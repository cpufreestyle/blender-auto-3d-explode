#!/usr/bin/env node
/**
 * 单元测试 — 部件级可交换清单（src/split-manifest.js）
 *
 * 钉住的契约：
 *   · 结构完整：version / model / totalParts / bounds / parts[] / summary 六件套齐全，
 *     parts 每项带 index / name / isOriginal / triangles / volume / surfaceArea /
 *     bounds / size / centroid / explodePos 十个字段；
 *   · index 是输出序号而非输入序号：跳过的项不占位，保证 parts[i].index === i；
 *   · 数值正确：焊接单位方块的三角形数 = 12、体积 = 1、表面积 = 6（解析值，
 *     不重复实现算法——直接按面累加算一遍对照）；
 *   · 包围盒与质心：两个分离方块各自的 bounds/min/max 与整体并集正确；
 *   · explodePos 无相机时沿质心方向外扩一格，量与「最大轴尺寸」挂钩，
 *     且整体质心在原点时方向桶确定为 (0,1,0)；
 *   · 容错：非数组 / 空数组 / 缺 position / 空包围盒一律跳过并记账，不抛错；
 *   · 序列化往返：serialize → parse 得到等价对象；坏 JSON 与结构不符返回 null。
 *
 * 用法：node tests/split-manifest-test.mjs
 */

import {
  buildSplitManifest,
  serializeSplitManifest,
  parseSplitManifest,
  MANIFEST_VERSION,
} from "../src/split-manifest.js";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Mesh } from "three";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}`);
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

// 几何金标准：three 官方 BoxGeometry。单位立方体 = 12 三角形 / 体积 1 / 表面积 6。
// 不手搓顶点——本仓库既有测试里的手搓焊接方块有几个 quad 是蝶式顶序，
// 切出的两个三角形面积不相等，表面积与体积都不是标称值；拿它当数值期望
// 会把夹具缺陷误报成模块缺陷。
function boxMesh(offset = 0, size = 1, name = "") {
  const m = new Mesh(new BoxGeometry(size, size, size));
  if (offset) m.position.set(offset, 0, 0);
  if (name) m.name = name;
  m.updateMatrixWorld(true);
  return m;
}

// 非索引等价物：把官方 BoxGeometry 的顶点按索引展开，去掉 index。
// 只用于验证 triangles 的「非索引路径」分支（position.count / 3）。
function nonIndexedBoxMesh(size = 1) {
  const src = new BoxGeometry(size, size, size);
  const pos = src.attributes.position;
  const idx = src.index;
  const flat = [];
  for (let i = 0; i < idx.count; i++) {
    const v = idx.getX(i);
    flat.push(pos.getX(v), pos.getY(v), pos.getZ(v));
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(flat, 3));
  const m = new Mesh(geo);
  m.updateMatrixWorld(true);
  return m;
}

function part(mesh, name = "", isOriginal = false) {
  return { mesh, name, isOriginal };
}

// ===== 用例 =====

describe("结构 — 六件套与十个字段齐全", async() => {
  await it("单部件 manifest 字段完整", () => {
    const m = buildSplitManifest([part(boxMesh(0, 1, "主体"), "主体", true)], { model: "demo" });
    assert(m.version === MANIFEST_VERSION, "version 与导出一致");
    assert(m.model === "demo", "model 名透传");
    assert(m.totalParts === 1, "totalParts = 1");
    assert(Array.isArray(m.parts) && m.parts.length === 1, "parts 长度 1");
    assert(!!m.bounds && Array.isArray(m.bounds.min) && Array.isArray(m.bounds.max), "bounds 有 min/max 数组");
    assert(!!m.summary && typeof m.summary.skipped === "number", "summary.skipped 是数字");
    const keys = Object.keys(m.parts[0]).sort();
    const expect = [
      "bounds", "centroid", "explodePos", "index", "isOriginal",
      "name", "size", "surfaceArea", "triangles", "volume",
    ];
    assert(JSON.stringify(keys) === JSON.stringify(expect), "part 十个字段无缺无多");
  });

  await it("index 是输出序号：跳过项不占位", () => {
    const bad = { mesh: new Mesh(new BufferGeometry()), name: "坏件", isOriginal: false };
    const m = buildSplitManifest([part(boxMesh(0, 1, "A"), "A"), bad, part(boxMesh(3, 1, "B"), "B")]);
    assert(m.totalParts === 2, "坏件被跳过，totalParts = 2");
    assert(m.parts[0].index === 0 && m.parts[1].index === 1, "index 连续为 0/1");
    assert(m.parts[0].name === "A" && m.parts[1].name === "B", "存活件顺序保持");
    assert(m.summary.skipped === 1, "skipped 记 1");
    assert(m.summary.reasons.length === 1 && m.summary.reasons[0].includes("index 1"), "原因带输入序号");
  });
});

describe("数值 — 三角形数、体积、表面积", async() => {
  await it("焊接单位方块：12 面 / 体积 1 / 表面积 6", () => {
    const m = buildSplitManifest([part(boxMesh(0, 1, "u"), "u")]);
    const p = m.parts[0];
    assert(p.triangles === 12, `triangles = 12（实测 ${p.triangles}）`);
    assert(Math.abs(p.volume - 1) < 1e-3, `volume ≈ 1（实测 ${p.volume}）`);
    assert(Math.abs(p.surfaceArea - 6) < 1e-3, `surfaceArea ≈ 6（实测 ${p.surfaceArea}）`);
  });

  await it("边长 2 的方块：体积 8、表面积 24", () => {
    const m = buildSplitManifest([part(boxMesh(0, 2, "big"), "big")]);
    const p = m.parts[0];
    assert(Math.abs(p.volume - 8) < 1e-2, `volume ≈ 8（实测 ${p.volume}）`);
    assert(Math.abs(p.surfaceArea - 24) < 1e-2, `surfaceArea ≈ 24（实测 ${p.surfaceArea}）`);
  });

  await it("非索引几何也能数面（position.count/3）", () => {
    const m = buildSplitManifest([part(nonIndexedBoxMesh(1), "flat")]);
    assert(m.parts[0].triangles === 12, `非索引路径 triangles = 12（实测 ${m.parts[0].triangles}）`);
  });
});

describe("几何 — 包围盒、尺寸、质心", async() => {
  await it("两个分离方块各自的 bounds 与整体并集", () => {
    const m = buildSplitManifest([part(boxMesh(-3, 1, "L"), "L"), part(boxMesh(3, 1, "R"), "R")]);
    const leftMin = JSON.stringify(m.parts[0].bounds.min);
    const leftMax = JSON.stringify(m.parts[0].bounds.max);
    assert(leftMin === "[-3.5,-0.5,-0.5]", `左件 min（实测 ${leftMin}）`);
    assert(leftMax === "[-2.5,0.5,0.5]", `左件 max（实测 ${leftMax}）`);
    assert(JSON.stringify(m.parts[1].bounds.min) === "[2.5,-0.5,-0.5]", "右件 min");
    assert(JSON.stringify(m.bounds.min) === "[-3.5,-0.5,-0.5]", "整体 min = 左件 min");
    assert(JSON.stringify(m.bounds.max) === "[3.5,0.5,0.5]", "整体 max = 右件 max");
  });

  await it("size 与 centroid 由包围盒导出", () => {
    const m = buildSplitManifest([part(boxMesh(0, 2, "c"), "c")]);
    assert(JSON.stringify(m.parts[0].size) === "[2,2,2]", "边长 2 → size 全 2");
    assert(JSON.stringify(m.parts[0].centroid) === "[0,0,0]", "居中 → 质心在原点");
  });
});

describe("explodePos — 无相机时的确定性退化", async() => {
  await it("单部件在原点：沿整体最大轴外扩一格", () => {
    const m = buildSplitManifest([part(boxMesh(0, 1, "s"), "s")]);
    const p = m.parts[0];
    assert(JSON.stringify(p.centroid) === "[0,0,0]", "前提：质心在原点");
    assert(JSON.stringify(p.explodePos) === "[1,0,0]", `沿 +X 外扩 1（立方体三轴等长取 x，实测 ${JSON.stringify(p.explodePos)}）`);
  });

  await it("偏离原点的部件沿质心方向外扩", () => {
    const m = buildSplitManifest([part(boxMesh(4, 1, "x"), "x")]);
    const p = m.parts[0];
    assert(p.explodePos[0] > p.centroid[0], "x 方向继续外扩");
    assert(Math.abs(p.explodePos[1]) < 1e-9 && Math.abs(p.explodePos[2]) < 1e-9, "其余轴不变");
  });

  await it("两部件各自背离整体中心", () => {
    const m = buildSplitManifest([part(boxMesh(-3, 1, "L"), "L"), part(boxMesh(3, 1, "R"), "R")]);
    assert(m.parts[0].explodePos[0] < m.parts[0].centroid[0], "左件继续往左");
    assert(m.parts[1].explodePos[0] > m.parts[1].centroid[0], "右件继续往右");
    assert(Math.abs(m.parts[0].explodePos[1]) < 1e-9, "左件 y 不变");
    assert(Math.abs(m.parts[1].explodePos[1]) < 1e-9, "右件 y 不变");
  });
});

describe("容错 — 非法输入不抛错", async() => {
  await it("非数组与空数组返回空 manifest", () => {
    for (const bad of [null, undefined, 42, "str", {}, []]) {
      const m = buildSplitManifest(bad);
      assert(m.totalParts === 0 && m.parts.length === 0, `输入 ${JSON.stringify(bad)} → 空 manifest`);
      assert(m.version === MANIFEST_VERSION, "空 manifest 仍带 version");
    }
  });

  await it("缺 mesh / 缺 geometry / 缺 position 三种都跳过", () => {
    const noGeo = { mesh: new Mesh(), name: "a", isOriginal: false };
    const noPos = { mesh: new Mesh(new BufferGeometry()), name: "b", isOriginal: false };
    const m = buildSplitManifest([null, undefined, noGeo, noPos, part(boxMesh(0, 1, "ok"), "ok")]);
    assert(m.totalParts === 1, "只有 1 件存活");
    assert(m.summary.skipped === 4, `跳过 4 项（实测 ${m.summary.skipped}）`);
    assert(m.parts[0].name === "ok", "存活件正确");
  });

  await it("未命名部件回落 部件N", () => {
    const m = buildSplitManifest([part(boxMesh(0, 1, ""), "")]);
    assert(m.parts[0].name === "部件1", `回落名称（实测 ${m.parts[0].name}）`);
  });
});

describe("序列化 — 往返与坏输入", async() => {
  await it("serialize → parse 得到等价对象", () => {
    const src = buildSplitManifest([part(boxMesh(-2, 1, "L"), "L"), part(boxMesh(2, 1, "R"), "R")], { model: "rt" });
    const back = parseSplitManifest(serializeSplitManifest(src));
    assert(back !== null, "解析成功");
    assert(JSON.stringify(back) === JSON.stringify(src), "往返后逐字节等价");
  });

  await it("坏 JSON 返回 null", () => {
    for (const bad of ["", "{", "not json", "[1,2"]) {
      assert(parseSplitManifest(bad) === null, `输入 ${JSON.stringify(bad)} → null`);
    }
  });

  await it("结构不符返回 null", () => {
    // 用 JSON.stringify 构造「合法 JSON 但结构不符」的输入，避免在双引号规范下
    // 手写一层转义——读起来就是它本来的样子。
    const badInputs = [
      "null",
      "42",
      JSON.stringify("str"),
      JSON.stringify({ totalParts: 1 }),
      JSON.stringify({ parts: [] }),
      JSON.stringify({ totalParts: "x", parts: [] }),
    ];
    for (const bad of badInputs) {
      assert(parseSplitManifest(bad) === null, `输入 ${bad} → null`);
    }
  });

  await it("indent 参数可调", () => {
    const m = buildSplitManifest([part(boxMesh(0, 1, "i"), "i")]);
    const compact = serializeSplitManifest(m, 0);
    assert(!compact.includes("\n"), "indent=0 输出单行");
  });
});

// ===== runner（与既有测试一致：describe 顺序执行，最后汇总）=====
(async() => {
  for (const d of describeQueue) {
    console.log(`\n📋 ${d.name}`);
    await d.fn();
  }
  console.log("\n" + "═".repeat(60));
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.error("  失败项:");
    for (const f of failures) console.error(`    - ${f}`);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
