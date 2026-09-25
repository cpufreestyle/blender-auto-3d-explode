#!/usr/bin/env node
/**
 * 单元测试 — 几何体拆分模块（src/geometry-split.js，autoSplitModel 从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - autoSplitModel 多 mesh 直通：>= 2 个 mesh 时原样返回、isOriginal 为真、
 *     mesh 引用不变、命名回退链 mesh.name -> userData.name -> `部件${i+1}`；
 *   - 收集阶段过滤：非 mesh、无 position 属性的子对象一律跳过，顺序保持
 *     traverse 文档序；
 *   - 单 mesh 材质组路径：>= 2 个材质组时逐组建 mesh，材质按 materialIndex 取
 *     （数组材质越界回落 material[0]），世界矩阵复制、matrixAutoUpdate 置 false；
 *   - 单 mesh 连通分量路径：>= 2 个分量时逐分量建 mesh，共享同一材质引用；
 *   - 两条自然拆分都不适用时保留原 mesh（isOriginal 为真、不强制切分）；
 *   - 命名：未命名部件按 (索引, 世界坐标, 整体包围盒) 走 generatePartName，
 *     已命名部件保持原名；
 *   - 边界：空模型返回 []、单块焊接几何不拆分。
 *
 * 夹具说明：three 的 BoxGeometry 每个角点按面复制（非焊接）且自带 6 个材质组，
 * 因此本文件统一使用手搓的「焊接方块」（8 角点共享、无 groups）与
 * 「双焊接方块 + 2 材质组」，确保两条自然拆分路径可分别、可预期地触发；
 * splitByConnectedComponents 只按「面内共享顶点」归并分量，非焊接几何会被
 * 12 面过滤规则合并成单分量——这正是本模块的真实契约，测试按契约写期望。
 *
 * 命名期望不重复实现数学：直接调用真实 generatePartName 按同样的
 * (i, worldPos, bbox) 入参计算，锁定的是接线（索引来源、坐标来源、包围盒
 * 汇总范围）而非其内部公式。
 *
 * splitSpatially（按最大轴把面切成 targetParts 段的纯函数）此前零覆盖：
 * autoSplitModel 走的是「材质组 → 连通分量」两条自然拆分路径，注释里明确写
 * 了「不强制空间切分」，所以这个导出从 L2 试点抽进来的那天起就没有调用方，
 * 任何测试都没碰过它。本文件末尾补上它的直接用例： slabs 的边界语义（内
 * 部边界归上段、末段闭区间）、首顶点决定归属、索引与非索引两条取顶点路
 * 径、<3 面的段被丢弃、退化几何体直接返回空数组。
 *
 * 用法：node tests/geometry-split-test.mjs
 */

import {
  autoSplitModel,
  splitSpatially,
  generatePartName,
  splitByMaterialGroups,
} from "../src/geometry-split.js";
import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";

// ===== 测试框架（与 unit-test.mjs / ar-preview-test.mjs 一致）=====
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

// ===== 几何体构造助手 =====

// 焊接方块：8 个角点被 12 个面共享（连通分量恰为 1），且不带材质组
function weldedBoxGeometry(offset = 0) {
  const corners = [];
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) corners.push([x + offset, y, z]);
    }
  }
  const quads = [
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [4, 5, 6, 7],
    [1, 0, 3, 2],
    [0, 4, 7, 3],
    [5, 1, 2, 6],
  ];
  const index = [];
  for (const [a, b, c, d] of quads) {
    index.push(a, b, c, a, c, d);
  }
  const position = [];
  for (const p of corners) position.push(...p);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  return geo;
}

// 两个互不相连的焊接方块（各自 12 面，连通分量恰为 2）
// secondOffset 可独立指定：关于原点对称时整体包围盒中心即原点，
// 便于让「整体并集 / 空包围盒 / 只取一块」三种命名入参落到不同方向桶。
function twoWeldedBoxesGeometry(offset = 5, withGroups = false, secondOffset = offset + 5) {
  const a = weldedBoxGeometry(-offset);
  const b = weldedBoxGeometry(secondOffset);
  const posA = a.attributes.position.array;
  const posB = b.attributes.position.array;
  const position = new Float32Array(posA.length + posB.length);
  position.set(posA, 0);
  position.set(posB, posA.length);
  const idxB = Array.from(b.index.array).map(v => v + 8);
  const index = [...Array.from(a.index.array), ...idxB];
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  if (withGroups) {
    geo.addGroup(0, 36, 0);
    geo.addGroup(36, 36, 1);
  }
  return geo;
}

function makeMesh(name, geometry, material) {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

function expectedNames(parts) {
  const bbox = new Box3();
  for (const part of parts) bbox.union(new Box3().setFromObject(part.mesh));
  return parts.map((part, i) => {
    const pos = part.mesh.getWorldPosition(new Vector3());
    return generatePartName(i, pos, bbox);
  });
}

// ===== 多 mesh 直通 =====
describe("autoSplitModel 多 mesh 直通", async() => {
  await it(">= 2 个 mesh：原样返回、isOriginal 为真、引用不变", async() => {
    const a = makeMesh("Alpha", weldedBoxGeometry(0));
    const b = makeMesh("Beta", weldedBoxGeometry(3));
    const model = new Group();
    model.add(a, b);

    const parts = autoSplitModel(model);

    assert(parts.length === 2, "两个部件");
    assert(parts[0].mesh === a && parts[1].mesh === b, "mesh 引用原样保留");
    assert(parts.every(p => p.isOriginal === true), "isOriginal 为真");
    assert(parts.map(p => p.name).join(",") === "Alpha,Beta", "名称取 mesh.name");
  });

  await it("命名回退链：mesh.name -> userData.name -> 部件N", async() => {
    const a = makeMesh("", weldedBoxGeometry(0));
    a.userData.name = "FromUserData";
    const b = makeMesh("", weldedBoxGeometry(3));
    const model = new Group();
    model.add(a, b);

    const parts = autoSplitModel(model);

    assert(parts[0].name === "FromUserData", "无名 mesh 回落 userData.name");
    assert(parts[1].name === "部件2", "两者皆无回落 `部件${i+1}`");
  });

  await it("非 mesh / 无 position 属性的子对象被跳过", async() => {
    const a = makeMesh("Alpha", weldedBoxGeometry(0));
    const emptyMesh = new Mesh(); // 默认空 BufferGeometry，无 position 属性
    const model = new Group();
    model.add(a, emptyMesh, new Group());

    const parts = autoSplitModel(model);

    assert(parts.length === 1, "只有带 position 的 mesh 入选");
    assert(parts[0].mesh === a, "入选的是原 mesh（未走拆分）");
    assert(parts[0].isOriginal === true, "单 mesh 不拆时 isOriginal 为真");
    assert(parts[0].name === "Alpha", "名称保持 mesh.name");
  });
});

// ===== 单 mesh：材质组拆分 =====
describe("autoSplitModel 单 mesh 材质组拆分", async() => {
  await it(">= 2 个材质组：逐组建 mesh、按 materialIndex 取材质", async() => {
    const matA = { name: "A" };
    const matB = { name: "B" };
    const mesh = makeMesh("", twoWeldedBoxesGeometry(5, true), [matA, matB]);
    mesh.position.set(3, 0, 0);
    mesh.updateMatrixWorld(true);
    const model = new Group();
    model.add(mesh);

    const parts = autoSplitModel(model);

    assert(parts.length === 2, "拆成 2 个部件");
    assert(parts.every(p => p.isOriginal === false), "isOriginal 为假");
    assert(parts[0].mesh.material === matA, "第一组取 material[0]");
    assert(parts[1].mesh.material === matB, "第二组取 material[1]");
    assert(parts[0].mesh !== mesh && parts[1].mesh !== mesh, "新 mesh 非原 mesh");
  });

  await it("数组材质越界回落 material[0]", async() => {
    const matOnly = { name: "Only" };
    const mesh = makeMesh("", twoWeldedBoxesGeometry(5, true), [matOnly]);
    mesh.updateMatrixWorld(true);
    const model = new Group();
    model.add(mesh);

    const parts = autoSplitModel(model);

    assert(parts.length === 2, "仍按材质组拆成 2 个");
    assert(parts[1].mesh.material === matOnly, "materialIndex 1 越界回落 material[0]");
  });

  await it("世界矩阵复制且 matrixAutoUpdate 置 false", async() => {
    const mesh = makeMesh("", twoWeldedBoxesGeometry(5, true), [{ name: "A" }, { name: "B" }]);
    mesh.position.set(3, 4, 5);
    mesh.updateMatrixWorld(true);
    const model = new Group();
    model.add(mesh);

    const parts = autoSplitModel(model);
    const world = mesh.matrixWorld.clone();

    for (const part of parts) {
      assert(part.mesh.matrix.equals(world), "新 mesh matrix 复制自原 mesh 世界矩阵");
      assert(part.mesh.matrixAutoUpdate === false, "matrixAutoUpdate 置 false");
    }
  });
});

// ===== 单 mesh：连通分量拆分 =====
describe("autoSplitModel 单 mesh 连通分量拆分", async() => {
  await it(">= 2 个分量：逐分量建 mesh、共享同一材质引用", async() => {
    const material = { name: "shared" };
    const mesh = makeMesh("", twoWeldedBoxesGeometry(5, false), material);
    mesh.position.set(1, 2, 3);
    mesh.updateMatrixWorld(true);
    const model = new Group();
    model.add(mesh);

    const parts = autoSplitModel(model);

    assert(parts.length === 2, "两个连通分量各成一个部件");
    assert(parts.every(p => p.isOriginal === false), "isOriginal 为假");
    assert(parts[0].mesh.material === material, "分量 mesh 共享材质引用");
    assert(parts[1].mesh.material === material, "分量 mesh 共享材质引用");
    assert(parts[0].mesh.matrix.equals(mesh.matrixWorld), "世界矩阵复制");
    assert(parts[0].mesh.matrixAutoUpdate === false, "matrixAutoUpdate 置 false");
  });

  await it("单块焊接几何不拆分：保留原 mesh", async() => {
    const mesh = makeMesh("Solo", weldedBoxGeometry(0));
    const model = new Group();
    model.add(mesh);

    const parts = autoSplitModel(model);

    assert(parts.length === 1, "只有一个部件");
    assert(parts[0].mesh === mesh, "保留原 mesh 引用");
    assert(parts[0].isOriginal === true, "isOriginal 为真");
    assert(parts[0].name === "Solo", "名称取原 mesh.name");
  });
});

// ===== 命名 =====
describe("autoSplitModel 命名", async() => {
  await it("未命名部件按 (索引, 世界坐标, 整体包围盒) 生成", async() => {
    // 两块关于原点对称（-5 / +5）：整体并集中心即原点，而新 mesh 的
    // matrixWorld 从未计算（matrixAutoUpdate=false），getWorldPosition()
    // 读到的是原点——于是「整体并集」定名「中心」，与空包围盒的平手兜底
    // 「左侧」、以及只取一块时的偏心方向三者互相区分，命名接线由此钉死。
    const mesh = makeMesh("", twoWeldedBoxesGeometry(5, false, 5), { name: "m" });
    mesh.position.set(2, 0, 0);
    mesh.updateMatrixWorld(true);
    const model = new Group();
    model.add(mesh);

    const parts = autoSplitModel(model);
    const expected = expectedNames(parts);

    assert(parts.every(p => typeof p.name === "string" && p.name.length > 0), "名称非空");
    assert(parts[0].name === expected[0], "第 0 个部件名称与真实 generatePartName 一致");
    assert(parts[1].name === expected[1], "第 1 个部件名称与真实 generatePartName 一致");
    assert(parts[0].name !== parts[1].name, "两个部件名称不同（索引参与命名）");
    assert(
      parts[0].name.endsWith("中心") && parts[1].name.endsWith("中心"),
      "整体包围盒（两块并集）参与定名：世界坐标落在并集中心",
    );
  });

  await it("已命名部件保持原名（多 mesh 直通路径）", async() => {
    const a = makeMesh("Named-A", weldedBoxGeometry(0));
    const b = makeMesh("Named-B", weldedBoxGeometry(3));
    const model = new Group();
    model.add(a, b);

    const parts = autoSplitModel(model);

    assert(parts.map(p => p.name).join(",") === "Named-A,Named-B", "原名保留");
  });
});

// ===== 边界与 primitive 契约 =====
describe("autoSplitModel 边界", async() => {
  await it("空模型返回 []", async() => {
    const model = new Group();
    const parts = autoSplitModel(model);
    assert(Array.isArray(parts) && parts.length === 0, "空数组");
  });

  await it("splitByMaterialGroups 契约：无分组返回 []、有分组按组出结果", async() => {
    const single = weldedBoxGeometry(0);
    assert(splitByMaterialGroups(single).length === 0, "无 groups 拆不动");
    const grouped = twoWeldedBoxesGeometry(5, true);
    assert(splitByMaterialGroups(grouped).length === 2, "两个 groups 出两个结果");
  });
});


// ===== splitSpatially：按最大轴切段 =====
// 沿 X 一字排开的 9 个三角形：首顶点 x = 0..8，每个三角形自身不跨段边界
function triangleRowGeometry() {
  const position = [];
  for (let i = 0; i < 9; i++) {
    position.push(i, 0, 0, i + 0.9, 0, 0, i, 1, 0);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  return geo;
}

// 沿 Y 排开的同款（用于把 maxAxis 从 x 支路逼到 y 支路）
function triangleColumnGeometry() {
  const position = [];
  for (let i = 0; i < 9; i++) {
    position.push(0, i, 0, 1, i, 0, 0, i + 0.9, 0);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  return geo;
}

// 首顶点落在内部分段边界上 / 落在包围盒最大值上的两排三角形。
// interior: v0.x=0（v1 向右伸 0.5）与 v0.x=1.25（v1 伸到 2.5）→ 包围盒 x∈[0,2.5]，
//   targetParts=2 的内部边界正是 1.25 —— v0.x=1.25 的面必须归上一段。
// onMax: v0.x=0 与 v0.x=2.5（v1 向左伸）→ 包围盒 x∈[0,2.5]，2.5 是末段闭端点。
function boundaryRowGeometry(firstXs, extendRight) {
  const position = [];
  for (const x of firstXs) {
    const x1 = extendRight ? x + 0.5 : x - 0.5;
    position.push(x, 0, 0, x1, 0, 0, x, 1, 0);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  return geo;
}

// 全部顶点重合：三个轴向尺寸都是 0，走退化分支
function pointGeometry() {
  const position = [];
  for (let i = 0; i < 9; i++) position.push(0, 0, 0);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  return geo;
}

const boxOf = geo => {
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const a = geo.attributes.position.array;
  for (let i = 0; i < a.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      b.min[k] = Math.min(b.min[k], a[i + k]);
      b.max[k] = Math.max(b.max[k], a[i + k]);
    }
  }
  return b;
};

describe("splitSpatially — 沿最大轴等分", async() => {
  await it("X 向长条按 targetParts 切出等段数", () => {
    const rs = splitSpatially(triangleRowGeometry(), null, 3);
    assert(rs.length === 3, `9 面切 3 段，每段 3 面 → 3 个结果（实得 ${rs.length}）`);
    assert(rs.every(g => g instanceof BufferGeometry), "结果都是 BufferGeometry");
    assert(rs.every(g => !g.index), "结果都是非索引几何体");
    const boxes = rs.map(boxOf);
    assert(Math.abs(boxes[0].max[0] - 2.9) < 1e-6, `第 1 段 x 到 2.9（实得 ${boxes[0].max[0]}）`);
    assert(Math.abs(boxes[1].min[0] - 3) < 1e-6 && Math.abs(boxes[1].max[0] - 5.9) < 1e-6,
      `第 2 段 x∈[3,5.9]（实得 ${boxes[1].min[0]},${boxes[1].max[0]}）`);
    assert(Math.abs(boxes[2].min[0] - 6) < 1e-6, `第 3 段 x 从 6 起（实得 ${boxes[2].min[0]}）`);
    const total = rs.reduce((s, g) => s + g.attributes.position.count, 0);
    assert(total === 27, `9 个面全部有归属（顶点合计 27，实得 ${total}）`);
  });
  await it("targetParts=1 只有一段且吃下全部面", () => {
    const rs = splitSpatially(triangleRowGeometry(), null, 1);
    assert(rs.length === 1 && rs[0].attributes.position.count === 27,
      `1 段 27 顶点（实得 ${rs.length} 段 / ${rs[0] && rs[0].attributes.position.count} 顶点）`);
  });
  await it("段数细到每段不足 3 面时全部丢弃", () => {
    const rs = splitSpatially(triangleRowGeometry(), null, 9);
    assert(rs.length === 0, `9 面切 9 段，每段 1 面 < 3 → 空结果（实得 ${rs.length}）`);
  });
  await it("Y 向长条走 y 支路", () => {
    const rs = splitSpatially(triangleColumnGeometry(), null, 2);
    assert(rs.length === 2, `9 面沿 Y 切 2 段 → 2 个结果（实得 ${rs.length}）`);
    const boxes = rs.map(boxOf);
    // 首顶点 y=4 的三角形的第三个顶点伸到 4.9，仍整段归第 1 段
    assert(Math.abs(boxes[0].max[1] - 4.9) < 1e-4, `第 1 段 y 到 4.9（实得 ${boxes[0].max[1]}）`);
    assert(Math.abs(boxes[1].min[1] - 5) < 1e-4 && Math.abs(boxes[1].max[1] - 8.9) < 1e-4,
      `第 2 段 y∈[5,8.9]（实得 ${boxes[1].min[1]},${boxes[1].max[1]}）`);
  });
});

describe("splitSpatially — 边界语义", async() => {
  await it("内部边界归上段（闭端点在下段会掉段）", () => {
    // v0.x=1.25 恰好是 targetParts=2 的内部边界：属下段则下段空、只剩 1 个结果
    const rs = splitSpatially(boundaryRowGeometry([0, 0, 0, 1.25, 1.25, 1.25], true), null, 2);
    assert(rs.length === 2, `两排各 3 面都成段 → 2 个结果（实得 ${rs.length}）`);
    const boxes = rs.map(boxOf);
    assert(Math.abs(boxes[0].max[0] - 0.5) < 1e-6, `第 1 段只含 v0.x=0 的面（实得 max ${boxes[0].max[0]}）`);
    assert(Math.abs(boxes[1].min[0] - 1.25) < 1e-6,
      `第 2 段含 v0.x=1.25 的面（实得 min ${boxes[1].min[0]}）`);
  });
  await it("末段是闭区间：首顶点正好在包围盒最大值也算末段", () => {
    const rs = splitSpatially(boundaryRowGeometry([0, 0, 0, 2.5, 2.5, 2.5], false), null, 2);
    assert(rs.length === 2, `v0.x=2.5=包围盒最大值仍能成段 → 2 个结果（实得 ${rs.length}）`);
    const boxes = rs.map(boxOf);
    assert(Math.abs(boxes[1].min[0] - 2.0) < 1e-6,
      `第 2 段含 v0.x=2.5 的面（其实 min 2.0，实得 ${boxes[1].min[0]}）`);
  });
  await it("段下界是闭的：首顶点在段首的面算该段", () => {
    const rs = splitSpatially(boundaryRowGeometry([0, 0, 0, 2, 2, 2], true), null, 2);
    assert(rs.length === 2, `v0.x=0 恰为第 1 段 minBound → 2 个结果（实得 ${rs.length}）`);
    assert(Math.abs(boxOf(rs[0]).min[0]) < 1e-6, "第 1 段含 v0.x=0 的面");
  });
});

describe("splitSpatially — 索引、退化与 material 形参", async() => {
  await it("索引几何体按索引首顶点归属（焊接方块 8 面/4 面对半）", () => {
    // 焊接方块 x∈[-0.5,0.5]，目标 2 段边界为 0。按其 12 个 quad 的索引顺序逐面
    // 数首顶点 x 符号：落在负半边的 8 面为一段、正半边的 4 面为另一段。
    const rs = splitSpatially(weldedBoxGeometry(0), null, 2);
    assert(rs.length === 2, `两段都够 3 面 → 2 个结果（实得 ${rs.length}）`);
    const counts = rs.map(g => g.attributes.position.count / 3);
    assert(counts[0] === 8 && counts[1] === 4,
      `负半 8 面 / 正半 4 面（实得 ${counts.join("/")}）`);
  });
  await it("退化几何体（三轴尺寸皆 0）返回空数组", () => {
    const rs = splitSpatially(pointGeometry(), null, 3);
    assert(Array.isArray(rs) && rs.length === 0, "返回 [] 而不是 null / 抛错");
  });
  await it("material 形参不影响结果（当前实现对它只收不用）", () => {
    const geo = triangleRowGeometry();
    const a = splitSpatially(geo, null, 3);
    const b = splitSpatially(geo, new MeshStandardMaterial(), 3);
    const c = splitSpatially(geo, undefined, 3);
    const sig = rs => rs.map(g => g.attributes.position.count).join(",");
    assert(sig(a) === sig(b) && sig(b) === sig(c),
      `三种 material 入参结果逐段一致（实得 ${sig(a)} / ${sig(b)} / ${sig(c)}）`);
  });
});

// ===== 变异测试记录（/tmp/mutate_splitspatial.py，共 11 个变异：11 杀 0 存活）=====
// maxAxis 并列时改严格大于 / maxAxis 恒为 x / maxAxis 的 y/z 支路恒为 z /
// 退化守卫改成恒真 / 退化阈值改负数 / 末段闭区间改成开区间 / 段下界闭改开 /
// 成段面数门槛 3 改 1 / 分段起点整体后移一段 / 索引路径的首顶点改成几何体首
// 顶点 / 每段只取前 3 个面。逐条锚点都与同文件里形状相同的兄弟行（另两处
// extractFacesToGeometry 调用与另一处 v0 取值）用上下文区分过，11 条全部真实
// 命中、无锚点缺失误报。
// 11 杀 0 存活的代价是回归风险低：这 11 条变异把 slabs 划分、边界开闭、成段
// 门槛、索引/非索引取顶点四条主线各撬了个遍，没有一个能活着走出测试。
// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
