#!/usr/bin/env node
/**
 * 单元测试 — 模型加载后归一化（src/model-fit.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - computeAutoScale 的边界数学：0.001 下限、5.0 门槛、20 倍上限（原
 *     autoScaleModel 的算式，三个魔数都容易在回归中被改坏）；
 *   - autoScaleModel：Box3 实测最大维度驱动；只在需要放大时写 scale；
 *     返回值即应用系数；日志文案含类型标签与倍数；
 *   - adjustSmartExplodeDistances：rAF 内执行；方向优先级
 *     explodePos -> partCenter -> 环形 fallback；除以 groupScale；
 *     explodePos 被就地重算为 单位方向 * 智能距离 / 组缩放；
 *   - customModelParts 经 getCustomModelParts() 惰性读取（换数组后用新数组）。
 *
 * 距离期望值不重复实现数学：直接调用真实的 calculateSmartExplodeDist
 * （src/explode-geometry.js）按同样的入参计算，锁定的是本模块的接线
 * （方向来源、normalize、groupScale 除法、copy 落点），而非其内部公式。
 *
 * 用法：node tests/model-fit-test.mjs
 */

import { createModelFit, computeAutoScale } from "../src/model-fit.js";
import { calculateSmartExplodeDist } from "../src/explode-geometry.js";
import { BoxGeometry, Group, Mesh, Vector3 } from "three";

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

// ===== 假 rAF 与假 three 引用 =====
const REAL_RAF = globalThis.requestAnimationFrame;
let pendingFrames = [];

function installFakeRAF() {
  pendingFrames = [];
  globalThis.requestAnimationFrame = fn => {
    pendingFrames.push(fn);
    return pendingFrames.length;
  };
}

function restoreRAF() {
  if (REAL_RAF === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = REAL_RAF;
}

function runFrames() {
  const due = pendingFrames.splice(0, pendingFrames.length);
  for (const fn of due) fn();
}

function makeGroupWithBox(w, h, d) {
  const group = new Group();
  const mesh = new Mesh(new BoxGeometry(w, h, d));
  group.add(mesh);
  return group;
}

const CAMERA = { fov: 50, position: new Vector3(3, 4, 10) };

function makePart(explodePos, partCenter) {
  return {
    explodePos: explodePos ? explodePos.clone() : new Vector3(),
    partCenter: partCenter ? partCenter.clone() : new Vector3(),
  };
}

function setup(overrides) {
  installFakeRAF();
  const customModelGroup = (overrides && overrides.group) || new Group();
  let parts = (overrides && overrides.parts) || [];
  const fit = createModelFit({
    customModelGroup,
    camera: (overrides && overrides.camera) || CAMERA,
    getCustomModelParts: () => parts,
  });
  return {
    fit,
    customModelGroup,
    getParts: () => parts,
    setParts: p => { parts = p; },
  };
}

// ===== 用例 =====
describe("computeAutoScale 边界数学", async() => {
  await it("0 与低于 0.001 的退化尺寸不放大", () => {
    assert(computeAutoScale(0) === 1, "maxDim=0 -> 1");
    assert(computeAutoScale(0.0005) === 1, "maxDim=0.0005（低于下限）-> 1");
    assert(computeAutoScale(0.001) === 1, "maxDim=0.001（边界，不满足 >）-> 1");
  });

  await it("小于 5 的尺寸放大到约 10 单位，上限 20 倍", () => {
    assert(computeAutoScale(1) === 10, "maxDim=1 -> 10");
    assert(computeAutoScale(2) === 5, "maxDim=2 -> 5");
    assert(computeAutoScale(4) === 2.5, "maxDim=4 -> 2.5");
    assert(computeAutoScale(0.5) === 20, "maxDim=0.5 -> 命中 20 倍上限");
    assert(computeAutoScale(0.4) === 20, "maxDim=0.4 -> 仍为 20（不超上限）");
  });

  await it("不小于 5 的尺寸保持原样", () => {
    assert(computeAutoScale(5) === 1, "maxDim=5（边界，不满足 <）-> 1");
    assert(computeAutoScale(5.001) === 1, "maxDim=5.001 -> 1");
    assert(computeAutoScale(100) === 1, "maxDim=100 -> 1");
  });
});

describe("autoScaleModel", async() => {
  await it("小模型：按 Box3 最大维度放大并写 scale", () => {
    const { fit, customModelGroup } = setup({ group: makeGroupWithBox(1, 0.5, 0.2) });
    const applied = fit.autoScaleModel("STL");
    assert(applied === 10, "返回 10 倍");
    assert(customModelGroup.scale.x === 10, "scale.x = 10");
    assert(customModelGroup.scale.y === 10 && customModelGroup.scale.z === 10, "scale 三分量一致");
  });

  await it("恰好 5 单位与更大模型：不写 scale", () => {
    for (const [label, w] of [["边界 5", 5], ["大模型", 10]]) {
      const { fit, customModelGroup } = setup({ group: makeGroupWithBox(w, w, w) });
      const applied = fit.autoScaleModel("GLB");
      assert(applied === 1, `${label}返回 1`);
      assert(customModelGroup.scale.x === 1, `${label} scale.x 保持 1`);
      assert(customModelGroup.scale.y === 1 && customModelGroup.scale.z === 1, `${label} 三分量均保持 1`);
    }
  });

  await it("空组：退化为 maxDim=0，不放大不抛错", () => {
    const { fit, customModelGroup } = setup({ group: new Group() });
    const applied = fit.autoScaleModel("空");
    assert(applied === 1, "空组返回 1");
    assert(customModelGroup.scale.x === 1, "scale 保持 1");
  });

  await it("日志文案含类型标签与倍数", () => {
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      const { fit } = setup({ group: makeGroupWithBox(1, 1, 1) });
      fit.autoScaleModel("STL");
      const big = setup({ group: makeGroupWithBox(10, 10, 10) });
      big.fit.autoScaleModel("GLB");
    } finally {
      console.log = realLog;
    }
    assert(logs.some(l => l === "🔍 STL自动放大 10.0 倍"), "放大时打日志");
    assert(logs.every(l => !l.includes("GLB")), "不放大时不打日志");
  });
});

describe("adjustSmartExplodeDistances", async() => {
  await it("方向优先级 explodePos > partCenter > 环形 fallback", () => {
    // 1) explodePos 优先
    const withDir = setup({
      group: makeGroupWithBox(2, 2, 2),
      parts: [makePart(new Vector3(0, 3, 0), new Vector3(9, 0, 0))],
    });
    withDir.fit.adjustSmartExplodeDistances();
    assert(pendingFrames.length === 1, "注册一帧");
    runFrames();
    const p1 = withDir.getParts()[0];
    const expectDir1 = new Vector3(0, 3, 0).normalize();
    const expectDist1 =
      calculateSmartExplodeDist(withDir.customModelGroup, expectDir1.clone(), CAMERA);
    assert(p1.explodePos.distanceTo(expectDir1.multiplyScalar(expectDist1)) < 1e-9, "explodePos 方向被归一化后乘智能距离");
    assert(p1.explodePos.y > 0 && Math.abs(p1.explodePos.x) < 1e-9, "方向仍指向 +Y（未被 partCenter 覆盖）");

    // 2) explodePos 为零时退化到 partCenter
    const withCenter = setup({ group: makeGroupWithBox(2, 2, 2), parts: [makePart(null, new Vector3(4, 0, 0))] });
    withCenter.fit.adjustSmartExplodeDistances();
    runFrames();
    const p2 = withCenter.getParts()[0];
    const expectDir2 = new Vector3(4, 0, 0).normalize();
    const expectDist2 = calculateSmartExplodeDist(withCenter.customModelGroup, expectDir2.clone(), CAMERA);
    assert(p2.explodePos.distanceTo(expectDir2.multiplyScalar(expectDist2)) < 1e-9, "零 explodePos 时用 partCenter 方向");

    // 3) 两者都为零时用环形 fallback（i=0 -> angle=0 -> (1, 0.5, 0) 归一化）
    const withFallback = setup({ group: makeGroupWithBox(2, 2, 2), parts: [makePart(null, null)] });
    withFallback.fit.adjustSmartExplodeDistances();
    runFrames();
    const p3 = withFallback.getParts()[0];
    const expectDir3 = new Vector3(1, 0.5, 0).normalize();
    const expectDist3 = calculateSmartExplodeDist(withFallback.customModelGroup, expectDir3.clone(), CAMERA);
    assert(p3.explodePos.distanceTo(expectDir3.multiplyScalar(expectDist3)) < 1e-9, "环形 fallback 方向 (cos0, 0.5, sin0)");
  });

  await it("多部件各自按索引取不同角度", () => {
    const parts = [makePart(null, null), makePart(null, null)];
    const w = setup({ group: makeGroupWithBox(2, 2, 2), parts });
    w.fit.adjustSmartExplodeDistances();
    runFrames();
    const [a, b] = w.getParts();
    assert(a.explodePos.x > 0 && b.explodePos.x < 0, "第 0 个朝 +X、第 1 个（angle=π）朝 -X");
    assert(a.explodePos.y > 0 && b.explodePos.y > 0, "两个的 Y 分量均为正（fallback 固定 0.5）");
  });

  await it("按 groupScale 换算回组局部空间（Box3 随缩放变大，距离不线性减半）", () => {
    const group = makeGroupWithBox(2, 2, 2);
    const w1 = setup({ group, parts: [makePart(new Vector3(0, 1, 0), null)] });
    w1.fit.adjustSmartExplodeDistances();
    runFrames();
    const d1 = w1.getParts()[0].explodePos.length();
    const expectDir1 = new Vector3(0, 1, 0).normalize();
    const expectDist1 = calculateSmartExplodeDist(group, expectDir1.clone(), CAMERA);
    assert(Math.abs(d1 - expectDist1) < 1e-9, "scale=1 时局部距离 = 世界距离");

    group.scale.set(2, 2, 2);
    const w2 = setup({ group, parts: [makePart(new Vector3(0, 1, 0), null)] });
    w2.fit.adjustSmartExplodeDistances();
    runFrames();
    const d2 = w2.getParts()[0].explodePos.length();
    // scale=2 时包围盒与 smartDist 同步变大，再除以 groupScale 换算回局部空间；
    // 由于 max(suggestedDist, 1.0) 的下限钳制，结果不是精确减半，但必须等于
    // 「真实智能距离 / 2」，即确认除了 groupScale 且只除了 groupScale。
    const expectWorld2 =
      calculateSmartExplodeDist(group, expectDir1.clone(), CAMERA);
    assert(Math.abs(d2 - expectWorld2 / 2) < 1e-9, "scale=2 时局部距离 = 世界距离 / 2");
    assert(d2 !== expectWorld2, "确认除了 groupScale（非未除）");
    assert(Math.abs(d2 - d1 / 2) > 1e-9, "确认包围盒随缩放变大（非线性减半）");
  });

  await it("惰性读 customModelParts：换数组后用新部件", () => {
    const w = setup({ group: makeGroupWithBox(2, 2, 2), parts: [makePart(new Vector3(0, 1, 0), null)] });
    w.setParts([makePart(new Vector3(1, 0, 0), null)]);
    w.fit.adjustSmartExplodeDistances();
    runFrames();
    const p = w.getParts()[0];
    assert(Math.abs(p.explodePos.x) > 0.5, "新数组部件被重算（+X 方向）");
    assert(Math.abs(p.explodePos.y) < 1e-9, "旧方向未残留");
  });

  await it("空部件表：排帧但不抛错", () => {
    const w = setup({ group: makeGroupWithBox(2, 2, 2), parts: [] });
    let threw = false;
    try {
      w.fit.adjustSmartExplodeDistances();
      runFrames();
    } catch {
      threw = true;
    }
    assert(threw === false, "空表安全");
    assert(pendingFrames.length === 0, "帧已消费");
  });
});

// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
  }
  restoreRAF();
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
