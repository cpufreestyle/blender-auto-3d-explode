#!/usr/bin/env node
/**
 * 单元测试 — 爆炸视图几何计算（src/explode-geometry.js 的三个导出）
 *
 * 这个模块此前零直接覆盖：mergeGeometries 只被 src/quest3-parts.js 的装配
 * 管线调用（222 / 410 行），calculateExplodePos 只被 model-loaders.js 调用，
 * calculateSmartExplodeDist 只被 model-fit.js 调用——三者的行为都藏在调用方
 * 的成功路径后面，规则一旦被改错，症状是「合并出来的模型顶点错乱 / 缺法线 /
 * 索引没展开」这类静默几何损坏，没有任何报错。本测试直接钉住它们的语义：
 *
 * calculateExplodePos：
 *   - 返回值是 three 的 Vector3（下游按 .x/.y/.z 与向量运算消费）；
 *   - 数值等于 utils.computeExplodeVector 的输出（钉接线，不重复实现公式）；
 *   - 原点附近的部件走环形分布分支，远处部件走质心方向分支。
 * mergeGeometries（重点，此前完全没被直接测过）：
 *   - 空数组 → 空几何体（没有任何属性）；
 *   - 单几何体 → clone：返回新对象、保留原 index，而不是把输入直接交出去；
 *   - 多几何体一律以非索引形态拼接：有 index 的输入先 toNonIndexed，
 *     结果 index 恒为 null，顶点按输入顺序首尾相接；
 *   - 属性取「交集」：只有所有输入都有的属性才进结果——一个输入缺 normal，
 *     合并结果就不能有 normal（各属性 itemSize 不同，混拼会直接产出坏缓冲）；
 *   - 输入不被修改。
 * calculateSmartExplodeDist：
 *   - 三段钳制：不小于 0.8、不超过 maxVisibleDist × angleFactor；
 *   - 爆炸方向正对相机时距离打五折起步（angleFactor 的 PI/4 分界）。
 *
 * 用法：node tests/explode-geometry-test.mjs
 */

import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  PerspectiveCamera,
  Vector3,
} from "three";

import {
  calculateExplodePos,
  calculateSmartExplodeDist,
  mergeGeometries,
} from "../src/explode-geometry.js";
import { computeExplodeVector } from "../src/utils.js";

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
// 单个三角形：position / normal / uv 三件齐全，顶点坐标可辨（0/1/2 段的偏移量）
function tri(offset = 0, withNormal = true, withUV = true) {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([
    offset + 0, 0, 0,
    offset + 1, 0, 0,
    offset + 0, 1, 0,
  ], 3));
  if (withNormal) {
    g.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  }
  if (withUV) {
    g.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  }
  return g;
}

// 索引化的四边形：4 顶点 + 2 三角形，toNonIndexed 后应为 6 顶点
function quadIndexed(offset = 0) {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([
    offset + 0, 0, 0,
    offset + 1, 0, 0,
    offset + 1, 1, 0,
    offset + 0, 1, 0,
  ], 3));
  g.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const attrArray = (g, name) => (g.attributes[name] ? Array.from(g.attributes[name].array) : null);

// ===== 用例 =====
describe("calculateExplodePos — Vector3 接线与两条分支", async() => {
  await it("返回值是 Vector3", () => {
    const v = calculateExplodePos(new Vector3(3, 0, 0), 0, 2);
    assert(v instanceof Vector3, `返回 three.Vector3（实得 ${v.constructor.name}）`);
  });
  await it("远离原点：沿质心方向、距离取 3 倍半径", () => {
    const v = calculateExplodePos(new Vector3(3, 0, 0), 0, 2);
    assert(v.x === 9 && v.y === 0 && v.z === 0,
      `(3,0,0) → (9,0,0)（实得 ${v.x},${v.y},${v.z}）`);
    const n = calculateExplodePos(new Vector3(0, -2, 0), 0, 2);
    assert(n.x === 0 && n.y === -6 && n.z === 0,
      `(0,-2,0) → (0,-6,0)（实得 ${n.x},${n.y},${n.z}）`);
  });
  await it("原点附近：走 index 决定的环形分布", () => {
    const a = calculateExplodePos(new Vector3(0, 0, 0), 0, 4);
    assert(Math.abs(a.x - 1) < 1e-9 && Math.abs(a.y) < 1e-9,
      `index 0 / 4 → (1,0,0)（实得 ${a.x},${a.y}）`);
    const b = calculateExplodePos(new Vector3(0, 0, 0), 1, 4);
    assert(Math.abs(b.x) < 1e-9 && Math.abs(b.y - 1) < 1e-9,
      `index 1 / 4 → (0,1,0)（实得 ${b.x},${b.y}）`);
  });
  await it("质心距离小于 0.001 也算原点（环形分支）", () => {
    const v = calculateExplodePos(new Vector3(0.0001, 0, 0), 0, 2);
    assert(Math.abs(v.x - 1) < 1e-9, `1e-4 视同原点 → (1,0,0)（实得 ${v.x}）`);
  });
  await it("与 computeExplodeVector 逐分量一致（钉接线）", () => {
    const cases = [
      [new Vector3(3, 0, 0), 0, 2],
      [new Vector3(0, 0, 0), 3, 8],
      [new Vector3(-1.5, 2.5, 0.5), 5, 7],
    ];
    for (const [c, i, n] of cases) {
      const v = calculateExplodePos(c, i, n);
      const e = computeExplodeVector(c, i, n);
      assert(v.x === e.x && v.y === e.y && v.z === e.z,
        `(${c.x},${c.y},${c.z}) i=${i} n=${n} 与 utils 输出一致`);
    }
  });
});

describe("mergeGeometries — 边界与克隆语义", async() => {
  await it("空数组返回空几何体", () => {
    const m = mergeGeometries([]);
    assert(m instanceof BufferGeometry, "返回 BufferGeometry");
    assert(!m.attributes.position && m.index === null,
      "没有任何属性、index 为 null（不是 null 返回值、不是抛出）");
  });
  await it("单几何体是 clone 而非原对象", () => {
    const g = tri(0);
    const m = mergeGeometries([g]);
    assert(m !== g, "返回新对象（下游改结果不会污染输入）");
    assert(attrArray(m, "position").join() === attrArray(g, "position").join(),
      "顶点逐值相同");
    assert(m.attributes.position.count === 3, "顶点数不变");
  });
  await it("单索引几何体保留索引形态", () => {
    const q = quadIndexed();
    const m = mergeGeometries([q]);
    assert(m.index !== null && m.index.count === 6, "clone 保留了 index（6 个索引项）");
    assert(m.attributes.position.count === 4, "顶点数仍是 4（没有展开）");
  });
});

describe("mergeGeometries — 多几何体一律拼接成非索引", async() => {
  await it("顶点数求和且按输入顺序首尾相接", () => {
    const m = mergeGeometries([tri(0), tri(10)]);
    assert(m.attributes.position.count === 6, `顶点数 3+3=6（实得 ${m.attributes.position.count}）`);
    const expectPos = attrArray(tri(0), "position")
      .concat(attrArray(tri(10), "position")).join();
    assert(attrArray(m, "position").join() === expectPos,
      "第一份的顶点排在前面，顺序未被重排");
    assert(m.index === null, "合并结果没有 index");
  });
  await it("索引输入先展开再拼接", () => {
    const q = quadIndexed(0);
    const m = mergeGeometries([q, tri(10)]);
    assert(m.attributes.position.count === 9, `4 顶点索引体展开成 6，加 3 得 9（实得 ${m.attributes.position.count}）`);
    const pos = attrArray(m, "position");
    assert(pos[0] === 0 && pos[18] === 10 && pos[21] === 11 && pos[24] === 10,
      `展开顺序按 index [0,1,2,0,2,3]：前 18 个数是四边形的 6 个展开顶点，18 起是三角形（实得 ${pos.slice(0, 6).join()}）`);
    assert(m.index === null, "结果是索引无关的纯 buffers");
  });
  await it("三个输入全部拼接", () => {
    const m = mergeGeometries([tri(0), tri(10), tri(20)]);
    assert(m.attributes.position.count === 9, `顶点数 9（实得 ${m.attributes.position.count}）`);
    const pos = attrArray(m, "position");
    assert(pos[0] === 0 && pos[9] === 10 && pos[18] === 20, "三段偏移 0/10/20 按序排列");
  });
  await it("输入不被修改", () => {
    const q = quadIndexed(0);
    const before = attrArray(q, "position").join();
    mergeGeometries([q, tri(10)]);
    assert(q.index !== null && q.attributes.position.count === 4 &&
      attrArray(q, "position").join() === before,
    "原几何体的 index / 顶点数 / 顶点值都没被动过");
  });
});

describe("mergeGeometries — 属性取交集", async() => {
  await it("全部都有时 normal / uv 都进结果", () => {
    const m = mergeGeometries([tri(0), tri(10)]);
    assert(!!m.attributes.normal && m.attributes.normal.count === 6, "normal 存在且顶点数 6");
    assert(!!m.attributes.uv && m.attributes.uv.count === 6, "uv 存在且顶点数 6");
    assert(m.attributes.uv.array.length === 12, `uv 数组长 12（itemSize 2 × 6 顶点，实得 ${m.attributes.uv.array.length}）`);
    assert(m.attributes.uv.itemSize === 2, "uv 的 itemSize 保持 2（没有按 position 的 3 硬拼）");
    assert(attrArray(m, "normal").join() === attrArray(tri(0), "normal").concat(attrArray(tri(10), "normal")).join(),
      "normal 也按顺序拼接");
  });
  await it("一个输入缺 normal，结果就没有 normal", () => {
    const m = mergeGeometries([tri(0), tri(10, false, false)]);
    assert(!!m.attributes.position && m.attributes.position.count === 6, "position 照常合并");
    assert(!m.attributes.normal, "normal 不出现（ itemSize 不同的属性不能混拼）");
    assert(!m.attributes.uv, "第二个输入也没有 uv，uv 同样不出现");
  });
  await it("只缺 uv 时 normal 仍在、uv 不出现", () => {
    const m = mergeGeometries([tri(0, true, true), tri(10, true, false)]);
    assert(!!m.attributes.normal, "normal 在");
    assert(!m.attributes.uv, "uv 不在");
  });
  await it("两个都没有 normal 时结果也没有", () => {
    const m = mergeGeometries([tri(0, false, false), tri(10, false, false)]);
    assert(!!m.attributes.position && !m.attributes.normal && !m.attributes.uv,
      "position 在，normal / uv 都不在");
  });
});

describe("calculateSmartExplodeDist — 钳制与对相机夹角", async() => {
  // 单件 1×1×1 盒子居中，相机 10 单位外，爆炸方向与相机视线垂直（90°）
  const setup = (boxSize, camPos, dir) => {
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(boxSize, boxSize, boxSize)));
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(camPos[0], camPos[1], camPos[2]);
    camera.lookAt(0, 0, 0);
    return calculateSmartExplodeDist(group, new Vector3(dir[0], dir[1], dir[2]), camera);
  };
  await it("常规尺寸：模型尺寸 40% 起、被视野上限收口", () => {
    const real = console.log;
    console.log = () => {};
    const d = setup(10, [0, 0, 10], [1, 0, 0]);
    console.log = real;
    // maxVisibleDist = 10 × tan(30°) × 0.6 ≈ 3.464；夹角 90° → angleFactor 1；
    // 基础距离 10 × 0.4 = 4 > 3.464 → 被收口到 3.464
    assert(Math.abs(d - 10 * Math.tan(Math.PI / 6) * 0.6) < 1e-6,
      `10 尺寸模型 → 3.464（实得 ${d}）`);
  });
  await it("小模型：不小于 0.8 的地板", () => {
    const real = console.log;
    console.log = () => {};
    const d = setup(0.1, [0, 0, 0.5], [1, 0, 0]);
    console.log = real;
    // 基础 0.04 → max(·,1.0)=1.0；maxVisibleDist ≈ 0.173；min 后 0.173 → 地板 0.8
    assert(d === 0.8, `贴脸小模型也不会小于 0.8（实得 ${d}）`);
  });
  await it("小模型远相机：不小于 1.0 的基础距离", () => {
    const real = console.log;
    console.log = () => {};
    const d = setup(0.5, [0, 0, 100], [1, 0, 0]);
    console.log = real;
    // 基础距离 0.5 × 0.4 = 0.2 → max(·, 1.0) = 1.0；视野上限约 57.7 管不着
    assert(d === 1.0, `0.2 被抬到 1.0 而不是直接采用（实得 ${d}）`);
  });
  await it("爆炸方向正对相机：距离打五折", () => {
    const real = console.log;
    console.log = () => {};
    const d = setup(10, [0, 0, 10], [0, 0, 1]);
    console.log = real;
    // 夹角 0° < 45° → angleFactor 0.5；上限 3.464 × 0.5 = 1.732
    assert(Math.abs(d - 10 * Math.tan(Math.PI / 6) * 0.6 * 0.5) < 1e-6,
      `正对相机 → 1.732（实得 ${d}）`);
  });
  await it("夹角落在 45° 与 90° 之间不再打折", () => {
    const real = console.log;
    console.log = () => {};
    const d = setup(10, [5, 0, 8.660254037844387], [1, 0, 0]);
    console.log = real;
    // 相机方向与爆炸方向夹角 60° > 45° → angleFactor 1.0 → 上限仍是 3.464
    assert(Math.abs(d - 10 * Math.tan(Math.PI / 6) * 0.6) < 1e-6,
      `60° 夹角不打折（实得 ${d}）`);
  });
});

// ===== 变异测试记录（/tmp/mutate_explodegeo.py，共 17 个变异：16 杀 1 存活）=====
// 16 杀：
//   删空数组守卫 / 单几何体不 clone 直接返回 / 删单几何体短路 / 属性过滤
//   every 改 some / attrNames 去掉 uv / 拼接偏移多跳一个 itemSize /
//   itemSize 硬编码 3 / 不展开索引几何体 / 顶点数按索引前总量算 /
//   拼接顺序反转 / Vector3 x/y 分量互换 / 视野边距 0.6 改 1.0 /
//   分界 PI/4 改 PI/2 / 去掉 0.8 地板 / 去掉 1.0 基础距离 /
//   基础比例 0.4 改 0.2。
// 1 存活，为等价变异：attrNames 加 "color"。activeAttrs 是「所有输入都有该
// 属性才合并」的交集过滤，而本模块的全部真实输入（quest3-parts.js 合并
// Quest 3 部件几何体）与测试夹具都只带 position/normal/uv，没有任何几何体
// 有 color 属性——加上这项之后 filter 依旧把它滤掉，渲染输出逐字节相同。
// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } catch (err) {
    console.error("运行异常:", err);
    process.exit(1);
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
