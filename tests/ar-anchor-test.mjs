#!/usr/bin/env node
/**
 * 单元测试 — AR 锚定助手（src/ar-anchor.js）
 *
 * 锁定的不变量（全部用假 XR 对象真实驱动，无需真机）：
 *   - anchorSupported：hit.createAnchor 是函数才支持
 *   - createAnchorFromHit：支持时调用 hit.createAnchor() 并返回其 Promise；
 *     不支持/空入参返回 null（旧浏览器优雅降级，不抛错）
 *   - anchorGoalPose：从 frame.getPose(anchor.anchorSpace, refSpace) 的
 *     transform 提取 position(Vector3)/quaternion(Quaternion)；anchor 缺失、
 *     frame 缺失、getPose 返回 null 时一律返回 null
 *
 * 用法：node tests/ar-anchor-test.mjs
 */

import { createAnchorFromHit, anchorGoalPose, anchorSupported } from "../src/ar-anchor.js";

let passed = 0;
let failed = 0;
const failures = [];
function assert(condition, message) {
  if (condition) { console.log("  ✅ " + message); passed++; }
  else { console.error("  ❌ FAIL " + message); failed++; failures.push(message); }
}
const describeQueue = [];
function describe(name, fn) { describeQueue.push({ name, fn }); }
function it(_name, fn) { return fn(); }

// ===== 假 XR 对象 =====

// 4x4 矩阵：位置 (1,2,3)，无旋转（单位旋转部分）
const POSE_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  1, 2, 3, 1,
]);

function makeHit({ withCreateAnchor = true, anchor = { anchorSpace: {} } } = {}) {
  const hit = {};
  if (withCreateAnchor) {
    hit.createAnchor = () => Promise.resolve(anchor);
  }
  return hit;
}

function makeFrame({ pose = { matrix: POSE_MATRIX } } = {}) {
  return {
    getPose(space, ref) {
      if (!space || !ref) return null;
      return pose === null ? null : { transform: pose };
    },
  };
}

const REF_SPACE = { __refSpace: true };

// ===== 用例 =====

describe("anchorSupported", () => {
  it("hit.createAnchor 是函数 → true", () => {
    assert(anchorSupported(makeHit()) === true, "支持时返回 true");
  });

  it("无 createAnchor / 空入参 → false", () => {
    assert(anchorSupported(makeHit({ withCreateAnchor: false })) === false, "旧浏览器 false");
    assert(anchorSupported(null) === false, "null false");
    assert(anchorSupported({}) === false, "空对象 false");
  });
});

describe("createAnchorFromHit", () => {
  it("支持时调用 createAnchor 并返回 Promise", async() => {
    let called = 0;
    const anchor = { anchorSpace: {} };
    const hit = { createAnchor: () => { called++; return Promise.resolve(anchor); } };
    const p = createAnchorFromHit(hit);
    assert(called === 1, "createAnchor 恰好调用一次");
    assert(p instanceof Promise, "返回 Promise");
    const a = await p;
    assert(a === anchor, "resolve 出同一 anchor");
  });

  it("不支持/空入参 → null（不抛错）", () => {
    assert(createAnchorFromHit(makeHit({ withCreateAnchor: false })) === null, "旧浏览器 null");
    assert(createAnchorFromHit(null) === null, "null 入参 null");
  });
});

describe("anchorGoalPose", () => {
  it("从 anchor 位姿提取 position/quaternion", () => {
    const anchor = { anchorSpace: { __space: true } };
    const frame = makeFrame();
    const goal = anchorGoalPose(frame, anchor, REF_SPACE);
    assert(!!goal, "返回非空");
    assert(goal.position.x === 1 && goal.position.y === 2 && goal.position.z === 3, "位置 (1,2,3)");
    assert(
      goal.quaternion.x === 0 && goal.quaternion.y === 0 && goal.quaternion.z === 0 && goal.quaternion.w === 1,
      "单位旋转四元数",
    );
  });

  it("anchor / frame / 位姿缺失时返回 null", () => {
    assert(anchorGoalPose(makeFrame(), null, REF_SPACE) === null, "无 anchor → null");
    assert(anchorGoalPose(makeFrame(), { anchorSpace: null }, REF_SPACE) === null, "anchorSpace 空 → null");
    assert(anchorGoalPose(makeFrame({ pose: null }), { anchorSpace: {} }, REF_SPACE) === null, "getPose null → null");
    assert(anchorGoalPose(null, { anchorSpace: {} }, REF_SPACE) === null, "无 frame → null");
  });
});

// ===== 运行 =====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
  }
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
