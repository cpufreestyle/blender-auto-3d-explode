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
  splitByCutPlanes,
  splitByConnectedComponents,
  splitByMaterialGroups,
  weldVertices,
} from "../src/geometry-split.js";
import {
  Box3,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
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

// 细分「壳」方块：只生成 6 个外表面并细分，顶点不焊接。
// 它是 splitByCutPlanes 的头号陷阱形状——盒壳中段的剖面只有侧壁穿过，
// 面数远低于两端（两端整面铺满），按「面数分桶」的旧判据会把它误判成细颈。
function meshedBoxGeometry(bmin, bmax, segs, offset = 0) {
  const position = [];
  const index = [];
  const add = (p) => { position.push(p[0] + offset, p[1], p[2]); return position.length / 3 - 1; };
  for (const n of [0, 1, 2]) {
    const [u, v] = [0, 1, 2].filter((d) => d !== n);
    for (const side of [bmin, bmax]) {
      const du = (bmax[u] - bmin[u]) / segs[u];
      const dv = (bmax[v] - bmin[v]) / segs[v];
      for (let i = 0; i < segs[u]; i++) {
        for (let j = 0; j < segs[v]; j++) {
          const corner = (a, b) => {
            const p = [0, 0, 0];
            p[n] = side[n];
            p[u] = bmin[u] + a * du;
            p[v] = bmin[v] + b * dv;
            return add(p);
          };
          const a = corner(i, j), b = corner(i + 1, j), c = corner(i + 1, j + 1), d = corner(i, j + 1);
          index.push(a, b, c, a, c, d);
        }
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  return geo;
}

// 简单并集：顶点块直接拼接、索引整体偏移（各块之间不共享顶点）
function mergeGeometries(geometries) {
  const position = [];
  const index = [];
  let base = 0;
  for (const g of geometries) {
    for (const v of g.attributes.position.array) position.push(v);
    for (const i of g.index.array) index.push(i + base);
    base += g.attributes.position.array.length / 3;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  return geo;
}

// 环形截面的空心管：管壁由 (R + r·cos phi) 绕 Y 轴扫成，两端带环形端盖。
// 沿轴看它的中孔会让「实心面积」骤降，是空心件的代表形状（不该被拆）。
function tubeShellGeometry(R, r, L, N = 24, P = 12, M = 6) {
  const position = [];
  const index = [];
  const add = (p) => { position.push(p[0], p[1], p[2]); return position.length / 3 - 1; };
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k <= P; k++) {
      const ph = (k / P) * Math.PI * 2;
      const rho = R + r * Math.cos(ph);
      for (let j = 0; j <= M; j++) add([c * rho, -L / 2 + (j / M) * L, s * rho]);
    }
  }
  const stride = M + 1;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < P; k++) {
      for (let j = 0; j < M; j++) {
        const a = i * (P + 1) * stride + k * stride + j;
        const b = (i + 1) * (P + 1) * stride + k * stride + j;
        index.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
  }
  for (const side of [-1, 1]) {
    const y = (side * L) / 2, base = position.length / 3;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      add([c * r, y, s * r]);
      add([c * R, y, s * R]);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2, b = base + (i + 1) * 2;
      index.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  return geo;
}

// 哑铃：两端 9x8x8 的实体块 + 中间一段细颈（沿 X），共 1616 面。
// 颈两侧各有 776/840 面、剖面落差 8 倍，是「焊死装配体」的标准形。
function dumbbellGeometry() {
  return mergeGeometries([
    meshedBoxGeometry([-10, -4, -4], [-5, 4, 4], [8, 8, 8]),
    meshedBoxGeometry([-5, -1, -1], [-1, 1, 1], [4, 2, 2]),
    meshedBoxGeometry([-1, -4, -4], [9, 4, 4], [8, 8, 8]),
  ]);
}

const faceCountOf = (g) => (g.index ? g.index.count / 3 : g.attributes.position.count / 3);
const bboxOf = (g) => new Box3().setFromBufferAttribute(g.attributes.position);
const bboxText = (g) => {
  const b = bboxOf(g);
  const r = (v) => v.toFixed(2);
  return `x[${r(b.min.x)},${r(b.max.x)}] y[${r(b.min.y)},${r(b.max.y)}] z[${r(b.min.z)},${r(b.max.z)}]`;
};

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

// ===== weldVertices：焊接语义与索引类型 =====
// 这里锁的是真实修过的 bug：welded.setIndex(new Uint32Array(...)) 直接塞裸
// TypedArray，three 不会把它包装成 BufferAttribute，于是 index.count 变成
// undefined，下游 splitByConnectedComponents 整个失能——哑铃焊接后仍是「一整块」，
// 部件数、面数全都对不上。断言刻意同时盯住顶点数下降、面数不变、index.count 可用。
describe("weldVertices — 焊接语义与索引类型", async() => {
  const shell = () => meshedBoxGeometry([0, 0, 0], [1, 1, 1], [2, 2, 2]);

  await it("焊接合并重合顶点但不丢面", () => {
    const raw = shell();
    const welded = weldVertices(raw);
    assert(raw.attributes.position.count === 96 && faceCountOf(raw) === 48,
      `焊接前 96 顶点 / 48 面（实得 ${raw.attributes.position.count} / ${faceCountOf(raw)}）`);
    assert(welded.attributes.position.count === 26,
      `焊接后顶点合并到 26（实得 ${welded.attributes.position.count}）`);
    assert(faceCountOf(welded) === 48, `面数守恒 48（实得 ${faceCountOf(welded)}）`);
  });

  await it("产出的 index 是带有效 count 的 BufferAttribute", () => {
    const welded = weldVertices(shell());
    const idx = welded.index;
    assert(!!idx && typeof idx.count === "number" && idx.count === 144,
      `index.count === 144（实得 ${idx ? String(idx.count) : "无 index"}）`);
    assert(typeof idx.getX === "function", "index 暴露 getX（说明是 BufferAttribute 而非裸 TypedArray）");
  });

  await it("tolerance <= 0 退化为原样克隆", () => {
    const a = weldVertices(shell(), 0);
    const b = weldVertices(shell(), -1);
    assert(a.attributes.position.count === 96 && faceCountOf(a) === 48,
      `tolerance=0 时 96 顶点 / 48 面不变（实得 ${a.attributes.position.count} / ${faceCountOf(a)}）`);
    assert(b.attributes.position.count === 96, `tolerance=-1 同样不变（实得 ${b.attributes.position.count}）`);
  });

  await it("贴合的方块焊成同一分量，远处的方块独立成件", () => {
    const stacked = mergeGeometries([
      meshedBoxGeometry([-4, -4, -4], [4, 4, 4], [8, 8, 8]),
      meshedBoxGeometry([-4, 4, -4], [4, 12, 4], [8, 8, 8]),
      meshedBoxGeometry([20, -4, -4], [24, 4, 4], [4, 4, 4]),
    ]);
    const comps = splitByConnectedComponents(weldVertices(stacked)).map(faceCountOf);
    assert(comps.length === 2 && comps[0] === 1536 && comps[1] === 192,
      `贴合两块并成 1536 面、远处一块 192 面（实得 ${JSON.stringify(comps)}）`);
    assert(comps.reduce((s, n) => s + n, 0) === faceCountOf(stacked),
      `分量面数之和等于原面数 1728（实得 ${comps.reduce((s, n) => s + n, 0)}）`);
  });
});

// ===== splitByCutPlanes：不该被拆的形状 =====
// 判据用「沿轴的面密度 dA/da」而不是「面数分桶」。凸体与空心件沿任何一根轴
// 都是一条平线（圆柱、盒壳、空心管）、穹顶（球、胶囊、半球）或单边斜坡（圆锥），
// 只有真的细颈才会在中间凹下去。下面每一条都是历史假阳性：曾把整颗球切成 8 块。
describe("splitByCutPlanes — 凸体与空心件保持完整", async() => {
  const sphereFlat = () => {
    const g = new IcosahedronGeometry(1, 3);
    g.deleteAttribute("uv");
    g.deleteAttribute("normal");
    return g;
  };
  const cases = [
    ["盒壳（中段剖面最稀，旧判据的头号误判）", () => meshedBoxGeometry([-1, -1, -1], [1, 1, 1], [4, 4, 4])],
    ["球体（带 uv/normal，索引）", () => new SphereGeometry(1, 24, 16)],
    ["球体（非索引、无 normal/uv）", sphereFlat],
    ["圆锥", () => new ConeGeometry(1, 3, 24, 4)],
    ["圆柱", () => new CylinderGeometry(1, 1, 3, 16, 4)],
    ["胶囊", () => new CapsuleGeometry(1, 3, 8, 16)],
    ["圆环", () => new TorusGeometry(2, 1, 16, 32)],
    ["空心管（环截面 + 环形端盖）", () => tubeShellGeometry(2, 1, 6)],
    ["薄壁空心管", () => tubeShellGeometry(3, 1, 6)],
    ["半球", () => new SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 3, 0)],
    ["平板", () => meshedBoxGeometry([-4, -4, -0.4], [4, 4, 0.4], [8, 8, 1])],
    ["U 形支架（两臂之间是空档）", () => mergeGeometries([
      meshedBoxGeometry([-3, 0, -1], [3, 1, 1], [6, 1, 1]),
      meshedBoxGeometry([-3, 1, -1], [-2, 5, 1], [1, 4, 1]),
      meshedBoxGeometry([2, 1, -1], [3, 5, 1], [1, 4, 1]),
    ])],
    ["L 形角码", () => mergeGeometries([
      meshedBoxGeometry([-3, 0, -1], [3, 1, 1], [6, 1, 1]),
      meshedBoxGeometry([-3, 1, -1], [-2, 5, 1], [1, 4, 1]),
    ])],
    ["T 形接头", () => mergeGeometries([
      meshedBoxGeometry([-4, -0.6, -0.6], [4, 0.6, 0.6], [8, 1, 1]),
      meshedBoxGeometry([-0.6, 0.6, -0.6], [0.6, 4, 0.6], [1, 4, 1]),
    ])],
    // 已知并接受的漏检：桌腿平贴在台面上，剖面是「阶跃」而不是「凹陷」，
    // 判据据此不切。宁可漏切桌腿，也不能把球切成碎片。
    ["台面 + 桌腿（平贴面，接受不切）", () => mergeGeometries([
      meshedBoxGeometry([-6, -6, -6], [6, 6, -4], [6, 6, 1]),
      meshedBoxGeometry([4.5, 4.5, -4], [5.5, 5.5, 8], [1, 1, 4]),
    ])],
  ];
  for (const [name, build] of cases) {
    await it(`${name} → 1 件`, () => {
      const geo = build();
      const got = splitByCutPlanes(geo).map(faceCountOf);
      assert(got.length === 1, `${name}：期望 1 件（实得 ${got.length} 件 ${JSON.stringify(got)}）`);
      assert(got.reduce((s, n) => s + n, 0) === faceCountOf(geo),
        `${name}：面数守恒 ${faceCountOf(geo)}（实得 ${got.reduce((s, n) => s + n, 0)}）`);
    });
  }
});

// ===== splitByCutPlanes：该拆的形状 =====
describe("splitByCutPlanes — 真颈切分", async() => {
  await it("哑铃沿颈切 2 件", () => {
    const geo = dumbbellGeometry();
    const parts = splitByCutPlanes(geo);
    const got = parts.map(faceCountOf);
    assert(parts.length === 2, `期望 2 件（实得 ${parts.length} 件 ${JSON.stringify(got)}）`);
    assert(got.reduce((s, n) => s + n, 0) === 1616, `面数守恒 1616（实得 ${got.reduce((s, n) => s + n, 0)}）`);
    assert(got[0] === 808 && got[1] === 808, `两侧各 808 面，正落在颈正中（实得 ${JSON.stringify(got)}）`);
    const [a, b] = parts.map(bboxOf);
    assert(a.max.x <= b.min.x || b.max.x <= a.min.x,
      `两块包围盒沿 X 不重叠（${parts.map(bboxText).join(" | ")}）`);
  });

  await it("两侧大小不等的颈也切，且切口贴着颈", () => {
    // 左块 192 面 + 颈 64 面 + 右块 300 面。颈在 x=0 处正好对半（各 32 面），
    // 所以理想的切法是 192+32 / 300+32；切口偏一格就会变成 200/356 那种一边倒。
    const geo = mergeGeometries([
      meshedBoxGeometry([-8, -2, -2], [-3, 2, 2], [4, 4, 4]),
      meshedBoxGeometry([-3, -0.5, -0.5], [3, 0.5, 0.5], [3, 2, 2]),
      meshedBoxGeometry([3, -5, -5], [10, 5, 5], [5, 5, 5]),
    ]);
    const parts = splitByCutPlanes(geo);
    const got = parts.map(faceCountOf);
    assert(parts.length === 2 && got.reduce((s, n) => s + n, 0) === 556,
      `2 件且面数守恒 556（实得 ${parts.length} 件 / ${got.reduce((s, n) => s + n, 0)} 面）`);
    assert(got.includes(224) && got.includes(332), `两侧 224 / 332 面（实得 ${JSON.stringify(got)}）`);
  });

  await it("方桥沿横梁切 2 件", () => {
    const geo = mergeGeometries([
      meshedBoxGeometry([-8, -3, -3], [-2, 3, 3], [6, 6, 6]),
      meshedBoxGeometry([-2, -0.5, -0.5], [2, 0.5, 0.5], [4, 1, 1]),
      meshedBoxGeometry([2, -5, -5], [8, 5, 5], [6, 5, 5]),
    ]);
    const got = splitByCutPlanes(geo).map(faceCountOf);
    assert(got.length === 2, `期望 2 件（实得 ${got.length} 件 ${JSON.stringify(got)}）`);
  });

  await it("棒棒糖在接缝处分离糖棍，不切进球体", () => {
    const stick = meshedBoxGeometry([-0.4, -0.4, -2.2], [0.4, 0.4, 0], [1, 1, 4]);
    const candy = new SphereGeometry(1.2, 16, 10).translate(0, 0, 1.5);
    const parts = splitByCutPlanes(mergeGeometries([stick, candy]));
    assert(parts.length === 2, `期望 2 件（实得 ${parts.length} 件 ${JSON.stringify(parts.map(faceCountOf))}）`);
    const stickPart = parts.find((p) => faceCountOf(p) === 36);
    assert(!!stickPart, `糖棍 36 面完整成件（实得 ${JSON.stringify(parts.map(faceCountOf))}）`);
    assert(!stickPart || bboxOf(stickPart).max.z <= 0,
      `糖棍包围盒 z 上界 ≤ 0，未被切伤（${stickPart ? bboxText(stickPart) : "未成件"}）`);
  });

  await it("互不接触的三段递归切成 3 件", () => {
    const geo = mergeGeometries([
      new SphereGeometry(2, 20, 12).translate(-4, 0, 0),
      new SphereGeometry(2, 20, 12).translate(4, 0, 0),
      new CapsuleGeometry(0.5, 2.4, 4, 12).rotateZ(Math.PI / 2),
    ]);
    const got = splitByCutPlanes(geo).map(faceCountOf).sort((a, b) => b - a);
    assert(got.length === 3 && got[0] === 440 && got[1] === 440 && got[2] === 216,
      `球头 440 + 球头 440 + 连杆 216（实得 ${JSON.stringify(got)}）`);
    assert(got.reduce((s, n) => s + n, 0) === faceCountOf(geo), "三段面数之和等于原面数");
  });

  await it("锥体 + 圆柱基座：锥尖段是真颈，切口落在整段最薄处", () => {
    // 锥尖埋进圆柱底座，y 向剖面在锥尖段真的凹下去（0.31 → 0.18 → 0.07 → 0.65），
    // 两侧分别是锥体下段和圆柱，既够厚又够长，符合「两侧都撑得住 + 整段一致」，
    // 所以这里该切。切口取整段最薄的那一格（y≈0.37），不是锥柱接缝 y=0.5——
    // 判据找的是「材料最薄处」，不是「零件接缝」。
    const geo = mergeGeometries([
      new ConeGeometry(1, 2, 24, 3),
      new CylinderGeometry(1, 1, 2, 24, 3).translate(0, 1.5, 0),
    ]);
    const got = splitByCutPlanes(geo).map(faceCountOf);
    assert(got.length === 2 && got.reduce((s, n) => s + n, 0) === faceCountOf(geo),
      `切成 2 件且面数守恒（实得 ${got.length} 件 ${JSON.stringify(got)}）`);
  });
});

// ===== splitByCutPlanes：退化输入与形参 =====
describe("splitByCutPlanes — 退化输入与形参", async() => {
  await it("退化输入统一返回空数组", () => {
    const empty = new BufferGeometry();
    const noPosition = new BufferGeometry();
    noPosition.setAttribute("color", new Float32BufferAttribute([1, 0, 0, 0, 1, 0], 3));
    assert(splitByCutPlanes(null).length === 0, "null → []");
    assert(splitByCutPlanes(undefined).length === 0, "undefined → []");
    assert(splitByCutPlanes(empty).length === 0, "空几何体 → []");
    assert(splitByCutPlanes(noPosition).length === 0, "无 position 属性 → []");
  });

  await it("面数不足或门槛过高时不切", () => {
    const small = meshedBoxGeometry([-1, -1, -1], [1, 1, 1], [1, 1, 1]);
    assert(splitByCutPlanes(small).length === 1,
      `12 面低于 minFaces*2 → 原样返回 1 件（实得 ${splitByCutPlanes(small).length}）`);
    const big = dumbbellGeometry();
    assert(splitByCutPlanes(big, { minFaces: 1000 }).length === 1,
      `minFaces=1000 时哑铃也不切（实得 ${splitByCutPlanes(big, { minFaces: 1000 }).length}）`);
  });

  await it("maxParts 限制递归深度", () => {
    const big = dumbbellGeometry();
    const one = splitByCutPlanes(big, { maxParts: 1 });
    const two = splitByCutPlanes(big, { maxParts: 2 });
    assert(one.length === 1, `maxParts=1 时不切（实得 ${one.length} 件）`);
    assert(two.length === 2, `maxParts=2 时切到底（实得 ${two.length} 件）`);
  });

  await it("粗分桶（bins=8）仍然不误拆球体", () => {
    const parts = splitByCutPlanes(new SphereGeometry(1, 24, 16), { bins: 8 });
    assert(parts.length === 1, `bins=8 时球体仍 1 件（实得 ${parts.length} 件）`);
  });

  await it("共面退化几何体不抛错", () => {
    const flat = meshedBoxGeometry([-4, -4, 0], [4, 4, 0], [8, 8, 1]);
    let parts = null;
    let threw = null;
    try {
      parts = splitByCutPlanes(flat);
    } catch (err) {
      threw = err;
    }
    assert(threw === null, `不抛异常（实得 ${threw ? threw.message : "无"}）`);
    assert(Array.isArray(parts), `返回数组（实得 ${Array.isArray(parts) ? parts.length + " 件" : String(parts)}）`);
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
