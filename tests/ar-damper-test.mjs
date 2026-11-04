#!/usr/bin/env node
/**
 * 单元测试 — AR 位姿阻尼器（src/ar-damper.js）
 *
 * 机制来源：model-viewer ARRenderer 的 Damper（二阶临界阻尼精确解）。
 * 锁定的不变量：
 *   - 大步进下单调收敛且不过冲（临界阻尼特性）
 *   - 足够时间后吸附到目标（nil-speed 判定，不渐进空转）
 *   - 帧率无关：60Hz 与 120Hz 相同墙钟时间后的位置一致（±容差）
 *   - smoothingAlpha 边界与帧率无关性
 */

import { Damper, smoothingAlpha, DECAY_MILLISECONDS } from "../src/ar-damper.js";

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

const closeTo = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe("Damper 收敛数学", () => {
  it("一步大步进：向目标推进且不过冲", () => {
    const d = new Damper(50);
    const next = d.update(0, 1, 16.67, 1);
    assert(next > 0 && next < 1, `0→1 一步后落在 (0,1)（实得 ${next.toFixed(4)}）`);
  });

  it("多步收敛：20 步 60Hz（约 333ms）后距目标 < 0.02", () => {
    const d = new Damper(50);
    let x = 0;
    for (let i = 0; i < 20; i++) x = d.update(x, 1, 16.67, 1);
    assert(Math.abs(1 - x) < 0.02, `20 步后 x=${x.toFixed(6)}，距目标 < 0.02`);
  });

  it("nil-speed 吸附：收敛后 velocity 清零并精确返回目标", () => {
    const d = new Damper(50);
    let x = 0;
    for (let i = 0; i < 40; i++) x = d.update(x, 5, 16.67, 1);
    assert(x === 5, `足够步数后精确吸附到目标（x=${x}）`);
    assert(d.velocity === 0, "吸附后 velocity 为 0");
  });

  it("goal 不变且已吸附：直接返回不再计算", () => {
    const d = new Damper(50);
    let x = d.update(3, 3, 16.67, 1);
    assert(x === 3, "x === goal 时直接返回");
  });

  it("负方向收敛对称", () => {
    const d1 = new Damper(50);
    const d2 = new Damper(50);
    let up = 0, down = 0;
    for (let i = 0; i < 20; i++) {
      up = d1.update(up, 1, 16.67, 1);
      down = d2.update(down, -1, 16.67, 1);
    }
    assert(closeTo(up, -down, 1e-9), `正负目标收敛对称（${up.toFixed(6)} vs ${-down.toFixed(6)}）`);
  });

  it("setDecayTime 后立即生效", () => {
    const d = new Damper(1000); // 很慢
    let x = d.update(0, 1, 16.67, 1);
    const slowStep = x;
    d.setDecayTime(10);
    x = d.update(x, 1, 16.67, 1);
    assert(x > slowStep, "衰减加快后推进更快");
  });

  it("DECAY_MILLISECONDS 默认 50ms", () => {
    assert(DECAY_MILLISECONDS === 50, "默认衰减常数 50");
  });
});

describe("帧率无关性", () => {
  it("60Hz 与 120Hz 相同墙钟时间后位置一致", () => {
    const d60 = new Damper(50);
    const d120 = new Damper(50);
    let x60 = 0, x120 = 0;
    // 333.3ms：60Hz 走 20 步，120Hz 走 40 步
    for (let i = 0; i < 20; i++) x60 = d60.update(x60, 1, 16.67, 1);
    for (let i = 0; i < 40; i++) x120 = d120.update(x120, 1, 8.33, 1);
    assert(closeTo(x60, x120, 1e-3), `60Hz(${x60.toFixed(5)}) ≈ 120Hz(${x120.toFixed(5)})`);
  });
});

describe("smoothingAlpha", () => {
  it("dt=0 返回 0（不动）", () => {
    assert(smoothingAlpha(0, 12) === 0, "零步长不插值");
  });

  it("dt<0 返回 0", () => {
    assert(smoothingAlpha(-1, 12) === 0, "负步长防御");
  });

  it("帧率无关：半步长 × 两倍次数 = 同 alpha 总量", () => {
    // alpha = 1 - e^(-rate*dt)；组合 n 步后剩余 = e^(-rate*T)，与步长无关
    const rate = 12;
    const a1 = smoothingAlpha(16.67 / 1000, rate);
    const a2 = smoothingAlpha(8.33 / 1000, rate);
    const remaining1 = Math.pow(1 - a1, 20);
    const remaining2 = Math.pow(1 - a2, 40);
    assert(closeTo(remaining1, remaining2, 1e-3), "相同墙钟时间剩余量一致");
  });

  it("alpha 始终在 [0,1]（大 dt 浮点可触 1）", () => {
    for (const dt of [0.001, 0.016, 0.1, 1, 10]) {
      const a = smoothingAlpha(dt, 12);
      assert(a >= 0 && a <= 1, `dt=${dt} → alpha=${a.toFixed(4)} 在 [0,1]`);
    }
  });
});

(async() => {
  for (const item of describeQueue) {
    console.log("\n──── " + item.name);
    await item.fn();
  }
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();

