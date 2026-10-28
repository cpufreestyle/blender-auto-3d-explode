#!/usr/bin/env node
/**
 * 单元测试 — 逐部件 STL 导出（src/print-export.js）
 *
 * 钉住的契约：
 *   · matrixWorld 陷阱：导出前必须 updateMatrixWorld，否则按原点导出；
 *   · 构建板朝向：导出结果 min.z ≈ 0（贴底）、XY 居中；
 *   · 二进制 STL 结构：84 + 50n 字节，三角形数字段与逐面字节数一致；
 *   · 单位：默认 1 场景单位 = 1000mm；
 *   · 现场 mesh 不被改动（爆炸动画依赖 homePos/explodePos）；
 *   · 80 字节头可写部件名且不溢出三角形计数字段。
 *
 * 用法：node tests/print-export-test.mjs
 */

import {
  JOIN_DEFAULTS,
  applyJoinFeatures,
  exportModelSTL,
  exportPartSTL,
  findJoinPairs,
  stlFilename,
  writeSTLHeader,
} from "../src/print-export.js";
import { analyzePart } from "../src/print-analyze.js";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Mesh } from "three";

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
function boxMesh(name = "盒子", size = 0.1) {
  const mesh = new Mesh(new BoxGeometry(size, size, size));
  mesh.name = name;
  return mesh;
}

// 从二进制 STL 里读出全部顶点的世界坐标范围
function stlBounds(buffer) {
  const dv = new DataView(buffer);
  const n = dv.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50;
    for (let v = 0; v < 3; v++) {
      for (let axis = 0; axis < 3; axis++) {
        const val = dv.getFloat32(base + 12 + v * 12 + axis * 4, true);
        if (val < min[axis]) min[axis] = val;
        if (val > max[axis]) max[axis] = val;
      }
    }
  }
  return { min, max, triangles: n, byteLength: buffer.byteLength };
}

// ===== 用例 =====

describe("二进制 STL 结构", async() => {
  await it("字节数 = 84 + 50 x 三角形数", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "盒子" });
    assert(r.triangles === 12, "12 个三角形（实得 " + r.triangles + "）");
    assert(r.buffer.byteLength === 84 + 50 * 12,
      "字节数 684（实得 " + r.buffer.byteLength + "）");
  });

  await it("头部三角形计数字段与实际逐面数据一致", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "盒子" });
    const b = stlBounds(r.buffer);
    assert(b.byteLength === 84 + 50 * b.triangles,
      "按头部计数逐字节走完不越界（实得 " + b.byteLength + "）");
  });

  await it("scaleToMm=1 时按场景单位输出，sizeMm 同步为 0.1", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "盒子" }, { scaleToMm: 1 });
    assert(Math.abs(r.sizeMm[0] - 0.1) < 1e-6, "sizeMm ≈ 0.1（实得 " + r.sizeMm[0] + "）");
    const b = stlBounds(r.buffer);
    assert(Math.abs(b.max[2] - 0.1) < 1e-6, "Z 上限 ≈ 0.1（实得 " + b.max[2] + "）");
  });
});

describe("构建板朝向", async() => {
  await it("导出结果贴底：min.z ≈ 0", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "盒子" });
    const b = stlBounds(r.buffer);
    assert(Math.abs(b.min[2]) < 1e-3, "min.z ≈ 0（实得 " + b.min[2] + "）");
  });

  await it("XY 居中：包围盒关于原点对称", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "盒子" });
    const b = stlBounds(r.buffer);
    assert(Math.abs(b.min[0] + b.max[0]) < 1e-3, "X 居中（实得 " + b.min[0] + " / " + b.max[0] + "）");
    assert(Math.abs(b.min[1] + b.max[1]) < 1e-3, "Y 居中（实得 " + b.min[1] + " / " + b.max[1] + "）");
  });

  await it("旋转把 Y-up 映射到 Z-up（100mm 立方体仍是 100³）", () => {
    // 立方体各向同性，旋转不改变尺寸；用一个长方体才能看出轴被换过
    const mesh = new Mesh(new BoxGeometry(0.1, 0.2, 0.3));
    mesh.name = "长条";
    const r = exportPartSTL({ mesh, name: "长条" });
    const b = stlBounds(r.buffer);
    const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
    assert(Math.abs(dx - 100) < 1e-2, "X = 100（实得 " + dx.toFixed(2) + "）");
    assert(Math.abs(dy - 300) < 1e-2, "Y = 300（实得 " + dy.toFixed(2) + "）");
    assert(Math.abs(dz - 200) < 1e-2, "Z = 200（实得 " + dz.toFixed(2) + "）");
  });
});

describe("matrixWorld 陷阱", async() => {
  await it("mesh 有位移时导出跟随位移，而不是落在原点", () => {
    // 这条用例钉住 src/print-export.js 里 updateMatrixWorld(true) 的必要性：
    // STLExporter 读 object.matrixWorld，若不先更新，translate(1,0,0) 的部件
    // 会按原点导出（实测 x = 0.05 而不是 1.05）。
    const mesh = boxMesh("位移盒");
    mesh.position.set(1, 0, 0);
    const r = exportPartSTL({ mesh, name: "位移盒" });
    const b = stlBounds(r.buffer);
    // 位移 + 居中后 X 范围应跨过原点两侧（部件被搬到板子中心）
    assert(Math.abs(b.min[0] + b.max[0]) < 1e-3,
      "X 仍居中（实得 " + b.min[0].toFixed(2) + " / " + b.max[0].toFixed(2) + "）");
    assert(r.triangles === 12, "三角形数不受位移影响");
  });

  await it("注入桩导出器时只调用一次 parse", () => {
    let calls = 0;
    let seenMatrixUpdated = false;
    let seenScale = 0;
    class FakeExporter {
      parse(object) {
        calls++;
        // 桩记录传入对象的状态。注意不能断言 matrixWorld 的平移分量：
        // 部件已被平放到板子中心，x 平移本就归零。真正要钉住的是
        // 「matrixWorld 被更新过」且「缩放已进矩阵」——漏掉
        // updateMatrixWorld 会让导出静默按原点/未缩放输出。
        // matrixWorld 已更新过（w=1）且缩放已进矩阵（m00 !== 1 或平移非零）。
        // 漏掉 updateMatrixWorld 会让导出静默按原点/未缩放输出。
        const mw = object.matrixWorld.elements;
        seenMatrixUpdated =
          mw[15] === 1 && (mw[0] !== 1 || mw[12] !== 0 || mw[13] !== 0);
        seenScale = object.matrixWorld.elements[0];
        const g = new BufferGeometry();
        g.setAttribute("position", new Float32BufferAttribute([0, 0, 0], 3));
        const out = new ArrayBuffer(84);
        new DataView(out).setUint32(80, 0, true);
        return out;
      }
    }
    const mesh = boxMesh("桩盒");
    mesh.position.set(2, 0, 0);
    const r = exportPartSTL({ mesh, name: "桩盒" }, { STLExporterClass: FakeExporter });
    assert(calls === 1, "parse 调用 1 次（实得 " + calls + "）");
    assert(seenMatrixUpdated, "parse 收到时 matrixWorld 已非单位矩阵（实得 elements[0]=" + seenScale + "）");
    assert(seenScale === 1000, "缩放 1000 已进 matrixWorld（实得 " + seenScale + "）");
    assert(r.triangles === 0, "桩返回 0 三角形时如实透出");
  });
});

describe("现场 mesh 保护", async() => {
  await it("导出不改动原 mesh 的位置与缩放", () => {
    const mesh = boxMesh("现场盒");
    mesh.position.set(0.5, 0.5, 0.5);
    exportPartSTL({ mesh, name: "现场盒" });
    assert(mesh.position.x === 0.5 && mesh.position.y === 0.5 && mesh.position.z === 0.5,
      "position 未被改动");
    assert(mesh.scale.x === 1, "scale 未被改动（实得 " + mesh.scale.x + "）");
    assert(mesh.rotation.x === 0, "rotation 未被改动（实得 " + mesh.rotation.x + "）");
  });

  await it("导出不改动 geometry 本身", () => {
    const mesh = boxMesh("几何盒");
    const before = Array.from(mesh.geometry.attributes.position.array);
    exportPartSTL({ mesh, name: "几何盒" });
    const after = Array.from(mesh.geometry.attributes.position.array);
    assert(before.length === after.length && before.every((v, i) => v === after[i]),
      "顶点数组逐值未变");
  });
});

describe("文件名与头部", async() => {
  await it("非法文件名字符被替换", () => {
    assert(stlFilename("a/b\\c:d") === "a_b_c_d.stl", "斜杠与冒号被替换（实得 " + stlFilename("a/b\\c:d") + "）");
  });

  await it("索引追加两位序号", () => {
    assert(stlFilename("部件", 0) === "部件-01.stl", "index 0 -> -01");
    assert(stlFilename("部件", 11) === "部件-12.stl", "index 11 -> -12");
  });

  await it("空名回退为 part", () => {
    assert(stlFilename("", 0) === "part-01.stl", "空名（实得 " + stlFilename("", 0) + "）");
  });

  await it("80 字节头写入部件名且不碰三角形计数", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "原头" });
    writeSTLHeader(r.buffer, "Quest3 面罩");
    const dv = new DataView(r.buffer);
    const text = new TextDecoder().decode(new Uint8Array(r.buffer, 0, 80));
    assert(text.startsWith("Quest3 面罩"), "头部包含部件名（实得 " + JSON.stringify(text.slice(0, 20)) + "）");
    assert(dv.getUint32(80, true) === 12, "三角形计数仍为 12（实得 " + dv.getUint32(80, true) + "）");
  });

  await it("超长头部名被截断到 79 字符", () => {
    const r = exportPartSTL({ mesh: boxMesh(), name: "截断" });
    writeSTLHeader(r.buffer, "x".repeat(200));
    const dv = new DataView(r.buffer);
    assert(dv.getUint32(80, true) === 12, "计数未受损（实得 " + dv.getUint32(80, true) + "）");
  });
});

describe("容错与批量", async() => {
  await it("mesh 缺失时返回 null 而不抛错", () => {
    assert(exportPartSTL({ name: "坏部件" }) === null, "返回 null");
  });

  await it("geometry 无 position 时返回 null", () => {
    assert(exportPartSTL({ mesh: new Mesh(new BufferGeometry()) }) === null, "返回 null");
  });

  await it("exportModelSTL 跳过无效部件", () => {
    const out = exportModelSTL([
      { mesh: boxMesh("A"), name: "A" },
      { name: "坏" },
      { mesh: boxMesh("B"), name: "B" },
    ]);
    assert(out.length === 2, "2 个有效导出（实得 " + out.length + "）");
    assert(out[0].name === "A" && out[1].name === "B", "顺序与名字保持");
  });

  await it("exportModelSTL 非数组返回空数组", () => {
    assert(exportModelSTL(null).length === 0, "空数组");
  });
});

describe("装配定位销 — findJoinPairs", async() => {
  await it("相邻盒检测出 1 对，轴向为贴合面法轴", () => {
    const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    a.position.set(-0.1, 0, 0);
    const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    b.position.set(0.1, 0, 0);
    const pairs = findJoinPairs([{ mesh: a }, { mesh: b }]);
    assert(pairs.length === 1, "恰好 1 对");
    assert(pairs[0].axis === "x", "界面轴为 x");
    assert(pairs[0].a === 0 && pairs[0].b === 1, "a=0 b=1");
    assert(pairs[0].axisSign === 1, "a 在负方向");
  });

  await it("不接触的部件不成对", () => {
    const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    a.position.set(0, 0, 0);
    const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    b.position.set(1, 0, 0);
    assert(findJoinPairs([{ mesh: a }, { mesh: b }]).length === 0, "相距 1m 无对");
  });

  await it("界面 200×200mm 放 2 根销，位置对称于界面中心", () => {
    const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    a.position.set(-0.1, 0, 0);
    const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    b.position.set(0.1, 0, 0);
    const [pair] = findJoinPairs([{ mesh: a }, { mesh: b }]);
    assert(pair.points.length === 2, "2 根销");
    const ys = pair.points.map(p => Math.round(p.y * 1e6));
    assert(ys[0] === -ys[1] && ys[0] !== 0, "沿 y 对称偏移");
    assert(Math.abs(pair.points[0].x) < 1e-9, "销在界面平面上");
  });

  await it("界面小于 minFaceSize 不放销", () => {
    // 5mm 见方的细柱贴面
    const a = new Mesh(new BoxGeometry(0.005, 0.05, 0.005));
    a.position.set(-0.0025, 0, 0);
    const b = new Mesh(new BoxGeometry(0.005, 0.05, 0.005));
    b.position.set(0.0025, 0, 0);
    assert(findJoinPairs([{ mesh: a }, { mesh: b }]).length === 0, "细柱不放销");
  });
});

describe("装配定位销 — applyJoinFeatures", async() => {
  const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
  a.position.set(-0.1, 0, 0);
  const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
  b.position.set(0.1, 0, 0);
  const [pair] = findJoinPairs([{ mesh: a }, { mesh: b }]);
  const cuts = pair.points.map(pt => ({ pt: pt.clone(), axis: pair.axis }));
  const pins = pair.points.map(pt => ({ pt: pt.clone(), axis: pair.axis }));
  const geoA = applyJoinFeatures(a, cuts, []);
  const geoB = applyJoinFeatures(b, [], pins);

  await it("孔件水密（0 开放边 / 0 非流形边）", () => {
    const r = analyzePart({ mesh: new Mesh(geoA) }, { scaleToMm: 1000 });
    assert(r.watertight, "水密");
    assert(r.openEdges === 0, "0 开放边");
    assert(r.nonManifoldEdges === 0, "0 非流形边");
  });

  await it("销件水密", () => {
    const r = analyzePart({ mesh: new Mesh(geoB) }, { scaleToMm: 1000 });
    assert(r.watertight, "水密");
    assert(r.openEdges === 0, "0 开放边");
  });

  await it("孔减去的体积 = 2 × (含间隙孔径 × 孔深)", () => {
    const plain = analyzePart({ mesh: a }, { scaleToMm: 1000 }).volumeMm3;
    const holed = analyzePart({ mesh: new Mesh(geoA) }, { scaleToMm: 1000 }).volumeMm3;
    const holeR = (JOIN_DEFAULTS.pinDiameter / 2 + JOIN_DEFAULTS.clearance) / 1000;
    const expected = 2 * Math.PI * holeR * holeR * JOIN_DEFAULTS.pinLength * 1e6;
    assert(Math.abs(plain - holed - expected) < 30, `体积差 ${ (plain - holed).toFixed(0) } ≈ ${ expected.toFixed(0) }`);
  });

  await it("销增加的体积 = 2 × 半根销（嵌入段被壳体吸收）", () => {
    const plain = analyzePart({ mesh: b }, { scaleToMm: 1000 }).volumeMm3;
    const pinned = analyzePart({ mesh: new Mesh(geoB) }, { scaleToMm: 1000 }).volumeMm3;
    const pinR = (JOIN_DEFAULTS.pinDiameter / 2) / 1000;
    const expected = 2 * Math.PI * pinR * pinR * JOIN_DEFAULTS.pinLength * 1e6;
    assert(Math.abs(pinned - plain - expected) < 30, `体积差 ${ (pinned - plain).toFixed(0) } ≈ ${ expected.toFixed(0) }`);
  });

  await it("无销无孔时返回 null 且不动原几何", () => {
    const before = a.geometry.attributes.position.count;
    assert(applyJoinFeatures(a, [], []) === null, "返回 null");
    assert(a.geometry.attributes.position.count === before, "原几何未变");
  });
});

describe("装配定位销 — exportModelSTL 集成", async() => {
  await it("默认开启：相邻件导出三角数显著增加，无关件保持 12", () => {
    const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    a.position.set(-0.1, 0, 0);
    const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    b.position.set(0.1, 0, 0);
    const lone = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    lone.position.set(5, 0, 0);
    const results = exportModelSTL([
      { mesh: a, name: "左壳" },
      { mesh: b, name: "右壳" },
      { mesh: lone, name: "独立件" },
    ]);
    assert(results.length === 3, "3 个 STL");
    assert(results[0].triangles > 100, `孔件三角数 ${ results[0].triangles } > 100`);
    assert(results[1].triangles > 100, `销件三角数 ${ results[1].triangles } > 100`);
    assert(results[2].triangles === 12, "无关件仍是 12 三角");
  });

  await it("joinFeatures:false 完全关闭，输出与纯盒一致", () => {
    const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    a.position.set(-0.1, 0, 0);
    const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    b.position.set(0.1, 0, 0);
    const results = exportModelSTL([{ mesh: a }, { mesh: b }], { joinFeatures: false });
    assert(results.every(r => r.triangles === 12), "全部 12 三角");
  });

  await it("现场 mesh 不被修改（CSG 只作用于导出副本）", () => {
    const a = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    a.position.set(-0.1, 0, 0);
    const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    b.position.set(0.1, 0, 0);
    exportModelSTL([{ mesh: a, name: "左壳" }, { mesh: b, name: "右壳" }]);
    assert(a.geometry.attributes.position.count === 24, "几何顶点数不变");
    assert(a.position.x === -0.1, "位置不变");
    assert(b.geometry.attributes.position.count === 24, "B 几何不变");
  });
});

// ===== runner =====
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
