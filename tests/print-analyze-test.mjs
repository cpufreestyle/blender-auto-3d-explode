#!/usr/bin/env node
/**
 * 单元测试 — 3D 打印可打印性预检（src/print-analyze.js）
 *
 * 钉住的契约：
 *   · 水密：闭合凸体（BoxGeometry）判定为 watertight，开放边 0
 *   · 开放：单个三角形 / 去掉一个面的盒子，开放边数正确
 *   · 焊接依赖：接缝处重复顶点不焊接会被误判成开放边，焊接后归零
 *   · 非流形：一条边被 3 个三角形共享时记 nonManifoldEdges 且不判 watertight
 *   · 退化面：三点共线 / 重复顶点计为退化三角形
 *   · 尺度：默认 1 单位 = 1 米 -> 1000mm，尺寸/体积/表面积都按毫米出
 *   · 构建体积：超尺寸部件 fitsBuildVolume = false 且 issues 说明超在哪轴
 *   · 汇总：ready 仅在全部部件无问题时为 true
 *
 * 用法：node tests/print-analyze-test.mjs
 */

import {
  analyzePart,
  analyzePrintability,
  BUILD_VOLUMES,
  DEFAULT_BUILD_VOLUME,
} from "../src/print-analyze.js";
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
} from "three";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log("  OK " + message);
    passed++;
  } else {
    console.error("  FAIL " + message);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
function it(_name, fn) {
  return fn();
}

// ===== 夹具 =====
// 注意：BoxGeometry 是索引几何且自带法线/UV，是最接近真实管线的输入。
// 历史教训：用「只有 position 的假几何」测不出一条重要路径——
// 本模块的边统计要先走 index 分支，非索引分支只有 STL 风格的几何才会走到。
function boxMesh(name = "盒子") {
  const mesh = new Mesh(new BoxGeometry(0.1, 0.1, 0.1));
  mesh.name = name;
  return mesh;
}

// 单个三角形（开放）
function singleTriangle(name = "单面") {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([
    0, 0, 0,
    0.1, 0, 0,
    0, 0.1, 0,
  ], 3));
  const mesh = new Mesh(g);
  mesh.name = name;
  return mesh;
}

// 去掉一个面的盒子：BoxGeometry 的 groups 顺序为 +X, -X, +Y, -Y, +Z, -Z。
// toNonIndexed 后每个面是 6 个顶点（18 个 float，即 3 个 float 一个顶点），
// 切分单位必须是 18 个 float——按「9 个 float 一面」切会把面与面之间的
// 顶点串位，得到一个根本不是盒子的几何。
function boxMissingTopFace(name = "缺面盒") {
  const g = new BoxGeometry(0.1, 0.1, 0.1).toNonIndexed();
  const pos = Array.from(g.attributes.position.array);
  const faceFloats = 18;
  const kept = [];
  for (let f = 0; f < 6; f++) {
    if (f === 2) continue; // +Y 顶面
    kept.push(...pos.slice(f * faceFloats, (f + 1) * faceFloats));
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(kept, 3));
  const mesh = new Mesh(out);
  mesh.name = name;
  return mesh;
}

// 接缝重复顶点：两个四边形沿 X 轴拼接，接缝处 4 个顶点各自复制一份
// （模拟 autoSplitModel 切口产出的、未焊接的几何）
function seamDuplicatedVertices(name = "接缝体") {
  // 两个共面 quad：z=0 面上 [0,1]x[0,1] 与 [1,2]x[0,1]，沿 x=1 处接缝拼接。
  // 每个 quad 用各自的 4 个独立顶点，接缝处 4 个位置重合点（左右各 2）——
  // 这就是 autoSplitModel 切口产出、尚未焊接的典型形状。
  //
  // 焊接后只有 6 个唯一顶点，外轮廓 6 条边各用 1 次 → 开放边 6、不水密。
  // 这是个**开放薄片**，再怎么焊也不会封闭，所以它证明的是
  // 「焊接把重复计数的接缝边收敛掉」，而不是「焊接能修好一切」。
  const pos = [
    // quad A
    0, 0, 0, 1, 0, 0, 1, 1, 0,
    0, 0, 0, 1, 1, 0, 0, 1, 0,
    // quad B（接缝顶点复制）
    1, 0, 0, 2, 0, 0, 2, 1, 0,
    1, 0, 0, 2, 1, 0, 1, 1, 0,
  ];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const mesh = new Mesh(g);
  mesh.name = name;
  return mesh;
}

// 重复顶点立方体：6 个 quad 各自带独立顶点（24 个顶点，角点全重复），
// 边长 0.1。焊接后应收敛为 8 个唯一顶点、12 个三角形、18 条边各用 2 次
// → 完全水密。这是「焊接有效」的正例，同时覆盖非索引几何路径。
function duplicatedVertexCube(name = "重复顶点立方体") {
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  // 每个面存成 quad 的四角，输出时拆成 2 个三角形（6 个顶点）。
  // 早先直接把 4 个顶点连成一坨，三角形数会是 8 而不是 12，边统计全乱。
  const quads = [
    [0, 3, 2, 1], // -Z 底
    [4, 5, 6, 7], // +Z 顶
    [0, 1, 5, 4], // -Y 前
    [1, 2, 6, 5], // +X 右
    [2, 3, 7, 6], // +Y 后
    [3, 0, 4, 7], // -X 左
  ];
  const pos = [];
  for (const q of quads) {
    for (const vi of [q[0], q[1], q[2], q[0], q[2], q[3]]) {
      pos.push(...c[vi].map(v => v * 0.1));
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const mesh = new Mesh(g);
  mesh.name = name;
  return mesh;
}

// 非流形：一条边被 3 个三角形共享。取盒子顶面中心，把三个三角形都连到同一条边
function nonManifoldMesh(name = "非流形") {
  // 三个三角形共用边 (0,0)-(1,0)：第三个三角形从边的另一侧接上来
  const pos = [
    0, 0, 0, 1, 0, 0, 0.5, 1, 0,
    0, 0, 0, 1, 0, 0, 0.5, -1, 0,
    0, 0, 0, 1, 0, 0, 0.5, 0.5, 1,
  ];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const mesh = new Mesh(g);
  mesh.name = name;
  return mesh;
}

// 退化三角形：三点共线
function degenerateMesh(name = "退化") {
  const pos = [
    0, 0, 0, 0.1, 0, 0, 0.2, 0, 0, // 共线
    0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, // 正常
  ];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const mesh = new Mesh(g);
  mesh.name = name;
  return mesh;
}

// ===== 用例 =====

describe("水密 — 闭合凸体", async() => {
  await it("BoxGeometry 判定为水密，无开放边无非流形边", () => {
    const r = analyzePart({ mesh: boxMesh(), name: "盒子", index: 0 });
    assert(r.watertight === true, "watertight = true");
    assert(r.openEdges === 0, "开放边 = 0（实得 " + r.openEdges + "）");
    assert(r.nonManifoldEdges === 0, "非流形边 = 0");
    assert(r.degenerateTriangles === 0, "退化面 = 0");
    assert(r.issues.length === 0, "无问题项（实得 " + JSON.stringify(r.issues) + "）");
  });

  await it("三角形数为 12（BoxGeometry 标准值）", () => {
    const r = analyzePart({ mesh: boxMesh() });
    assert(r.triangles === 12, "triangles = 12（实得 " + r.triangles + "）");
  });
});

describe("开放 — 未封闭几何", async() => {
  await it("单个三角形：3 条开放边，不水密", () => {
    const r = analyzePart({ mesh: singleTriangle() });
    assert(r.watertight === false, "watertight = false");
    assert(r.openEdges === 3, "开放边 = 3（实得 " + r.openEdges + "）");
    assert(r.issues.length === 1, "1 条问题（实得 " + r.issues.length + "）");
    assert(r.issues[0].includes("开放边"), "问题文案提到开放边：" + r.issues[0]);
  });

  await it("去掉顶面的盒子：开放边等于顶面边界（4 条）", () => {
    const r = analyzePart({ mesh: boxMissingTopFace() });
    assert(r.watertight === false, "watertight = false");
    assert(r.openEdges === 4, "开放边 = 4（实得 " + r.openEdges + "）");
    assert(r.boundaryVertices === 4, "边界顶点 = 4（实得 " + r.boundaryVertices + "）");
  });
});

describe("焊接 — 重复顶点收敛", async() => {
  await it("接缝共享边焊接后归零（重复顶点被合并）", () => {
    const r = analyzePart({ mesh: seamDuplicatedVertices() });
    // 两个共面 quad 拼起来仍是开放薄片：外轮廓 6 条边，永远不水密。
    // 这里断言的是「接缝那条共享边不再被重复计数」——若未焊接，接缝两侧
    // 各 4 条边会全部记为开放，总数翻倍到 12。
    assert(r.openEdges === 6, "开放边 = 6（薄片外轮廓，实得 " + r.openEdges + "）");
    assert(r.watertight === false, "开放薄片不水密（实得 watertight=" + r.watertight + "）");
    assert(r.triangles === 4, "三角形数不变 = 4（实得 " + r.triangles + "）");
  });

  await it("不焊接时同一几何的开放边为 12（所有边各用 1 次）", () => {
    // 这条用例直接验证「焊接是必需步骤」：绕过 weldPositions 的统计
    // 会把每个顶点都当成独立的，4 个三角形 12 条边各用 1 次、全记为开放。
    // 与上一条的 6 对照，正好证明焊接确实改变了结论。
    const mesh = seamDuplicatedVertices();
    const pos = mesh.geometry.attributes.position;
    const edgeUse = new Map();
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const tri = [i, i + 1, i + 2];
      for (let e = 0; e < 3; e++) {
        const p = tri[e], q = tri[(e + 1) % 3];
        const key = p < q ? p + "_" + q : q + "_" + p;
        edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      }
    }
    let open = 0;
    for (const n of edgeUse.values()) if (n === 1) open++;
    assert(open === 12, "未焊接开放边 = 12（实得 " + open + "）——证明焊接改变了结论");
  });

  await it("重复顶点立方体焊接后完全水密（焊接正例）", () => {
    const r = analyzePart({ mesh: duplicatedVertexCube() });
    assert(r.watertight === true,
      "watertight = true（实得 " + r.watertight + " openEdges=" + r.openEdges + "）");
    assert(r.openEdges === 0, "开放边 = 0（实得 " + r.openEdges + "）");
    assert(r.nonManifoldEdges === 0, "非流形边 = 0");
    assert(r.triangles === 12, "三角形 = 12（实得 " + r.triangles + "）");
    assert(r.issues.length === 0, "无问题项（实得 " + JSON.stringify(r.issues) + "）");
  });
});

describe("非流形 — 边被 3+ 面共享", async() => {
  await it("记 nonManifoldEdges 且不判水密", () => {
    const r = analyzePart({ mesh: nonManifoldMesh() });
    assert(r.watertight === false, "watertight = false");
    assert(r.nonManifoldEdges >= 1, "非流形边 >= 1（实得 " + r.nonManifoldEdges + "）");
    const msg = r.issues.find(m => m.includes("非流形"));
    assert(!!msg, "问题文案提到非流形：" + msg);
  });
});

describe("退化三角形", async() => {
  await it("三点共线计为退化，正常面不计", () => {
    const r = analyzePart({ mesh: degenerateMesh() });
    assert(r.degenerateTriangles === 1, "退化面 = 1（实得 " + r.degenerateTriangles + "）");
    assert(r.issues.some(m => m.includes("退化")), "问题文案提到退化");
  });
});

describe("尺度 — 单位换算", async() => {
  await it("0.1 单位的盒子换算为 100mm 各边", () => {
    const r = analyzePart({ mesh: boxMesh() });
    assert(r.sizeMm[0] === 100 && r.sizeMm[1] === 100 && r.sizeMm[2] === 100,
      "sizeMm = 100,100,100（实得 " + JSON.stringify(r.sizeMm) + "）");
  });

  // BoxGeometry 的位置是 float32，0.1 存成 0.10000000149…，所以体积是
  // 1000000.04 而不是整数 1000000。按仓库惯例用 1e-6 相对/绝对容差比对。
  await it("体积按 mm³ 输出（0.1³ 立方米 ≈ 1000000 mm³）", () => {
    const r = analyzePart({ mesh: boxMesh() });
    assert(Math.abs(r.volumeMm3 - 1000000) < 1e-6 * 1000000,
      "volumeMm3 ≈ 1000000（实得 " + r.volumeMm3 + "）");
  });

  // 0.1 单位的盒子：每面 0.1 x 0.1 = 0.01 m²，共 6 面 → 0.06 m² = 60000 mm²。
  // （曾写成 10000，只算了一个面。）
  await it("表面积按 mm² 输出（6 面共 0.06 m² = 60000 mm²）", () => {
    const r = analyzePart({ mesh: boxMesh() });
    assert(r.surfaceAreaMm2 === 60000, "surfaceAreaMm2 = 60000（实得 " + r.surfaceAreaMm2 + "）");
  });

  await it("自定义 scaleToMm 生效", () => {
    const r = analyzePart({ mesh: boxMesh() }, { scaleToMm: 10 });
    assert(r.sizeMm[0] === 1, "scale=10 时 0.1 单位 = 1mm（实得 " + r.sizeMm[0] + "）");
  });
});

describe("构建体积比对", async() => {
  await it("100mm 部件在 256³ 构建体积内", () => {
    const r = analyzePart({ mesh: boxMesh() }, { buildVolume: "bambu_x1c" });
    assert(r.fitsBuildVolume === true, "fitsBuildVolume = true");
    assert(!r.issues.some(m => m.includes("超出")), "无超尺寸问题");
  });

  await it("超尺寸部件 fitsBuildVolume = false 且指出超出的轴", () => {
    // 0.4 单位 = 400mm，超出所有 256 轴
    const mesh = new Mesh(new BoxGeometry(0.4, 0.1, 0.1));
    const r = analyzePart({ mesh }, { buildVolume: "bambu_x1c" });
    assert(r.fitsBuildVolume === false, "fitsBuildVolume = false");
    const over = r.issues.find(m => m.includes("超出"));
    assert(!!over && over.includes("X"), "问题文案指出 X 轴超出：" + over);
  });

  await it("未知构建体积键回退到默认值", () => {
    const r = analyzePart({ mesh: boxMesh() }, { buildVolume: "不存在的键" });
    assert(r.fitsBuildVolume === true, "回退后仍正常判定");
  });
});

describe("容错 — 非法输入不抛错", async() => {
  await it("mesh 缺失时返回 issues 而非抛错", () => {
    const r = analyzePart({ name: "坏部件" });
    assert(r.watertight === false, "watertight = false");
    assert(r.issues.length > 0, "有问题项说明原因");
  });

  await it("geometry 无 position 属性时不抛错", () => {
    const r = analyzePart({ mesh: new Mesh(new BufferGeometry()) });
    assert(r.triangles === 0, "triangles = 0");
    assert(r.issues.length > 0, "有问题项");
  });

  await it("parts 非数组时 analyzePrintability 返回空汇总", () => {
    const r = analyzePrintability(null);
    assert(r.parts.length === 0, "parts 为空");
    assert(r.summary.ready === false, "ready = false");
    assert(r.issues.length > 0, "有说明");
  });

  await it("parts 为空数组时同上", () => {
    const r = analyzePrintability([]);
    assert(r.summary.total === 0, "total = 0");
    assert(r.summary.ready === false, "ready = false");
  });
});

describe("汇总 — analyzePrintability", async() => {
  await it("全部合格时 ready = true", () => {
    const r = analyzePrintability([
      { mesh: boxMesh("A"), name: "A", index: 0 },
      { mesh: boxMesh("B"), name: "B", index: 1 },
    ]);
    assert(r.summary.total === 2, "total = 2");
    assert(r.summary.watertight === 2, "watertight = 2");
    assert(r.summary.problematic === 0, "problematic = 0");
    assert(r.summary.ready === true, "ready = true");
    assert(r.summary.totalTriangles === 24, "totalTriangles = 24（实得 " + r.summary.totalTriangles + "）");
  });

  await it("有不合格部件时 ready = false 且分别计数", () => {
    const r = analyzePrintability([
      { mesh: boxMesh("A"), name: "A", index: 0 },
      { mesh: singleTriangle("B"), name: "B", index: 1 },
    ]);
    assert(r.summary.watertight === 1, "watertight = 1");
    assert(r.summary.problematic === 1, "problematic = 1");
    assert(r.summary.ready === false, "ready = false");
  });

  await it("汇总体积是各部件之和", () => {
    const r = analyzePrintability([
      { mesh: boxMesh("A"), name: "A", index: 0 },
      { mesh: boxMesh("B"), name: "B", index: 1 },
    ]);
    assert(Math.abs(r.summary.totalVolumeMm3 - 2000000) < 1e-6 * 2000000,
      "totalVolumeMm3 ≈ 2000000（实得 " + r.summary.totalVolumeMm3 + "）");
  });

  await it("buildLabel 与 buildVolume 键对应", () => {
    const r = analyzePrintability([{ mesh: boxMesh() }], { buildVolume: "prusa_mk4" });
    assert(r.buildVolume === "prusa_mk4", "buildVolume 回带键");
    assert(r.buildLabel === BUILD_VOLUMES.prusa_mk4.label, "buildLabel 正确");
  });

  await it("DEFAULT_BUILD_VOLUME 是 bambu_x1c", () => {
    assert(DEFAULT_BUILD_VOLUME === "bambu_x1c", "默认构建体积键");
  });
});

// ===== runner（与既有测试一致：describe 顺序执行，最后汇总）=====
(async() => {
  for (const d of describeQueue) {
    console.log("\n" + d.name);
    await d.fn();
  }
  console.log("\n========================================");
  console.log(`总计: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("\n失败的用例:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})();
