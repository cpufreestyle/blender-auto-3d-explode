#!/usr/bin/env node
/**
 * 单元测试 — 步骤描述淡入动画（src/step-desc.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 文案变化：style.animation 先置 "none"、void 读 offsetHeight 触发重排、
 *     再置 "fadeInUp 0.5s ease-out"；
 *   - 文案未变：不碰 style.animation（不重放动画）；
 *   - 只跟 textContent 的当前值比较，每次变化都重播（lastStepDesc 随动更新）；
 *   - 首次调用（lastStepDesc 为 ""）只要文案非空即播一次；
 *   - stepDescEl 缺失时静默返回，不抛错。
 *
 * 用法：node tests/step-desc-test.mjs
 */

import { createStepDescAnimation } from "../src/step-desc.js";

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

// ===== 假 DOM =====
// offsetHeight 定义 getter：记录被 void 读取的次数（触发重排的哨兵）；
// style.animation 定义 setter：逐次记录赋值序列（钉住 none → fadeInUp 顺序）
function makeDescEl() {
  let reads = 0;
  const writes = [];
  const el = { textContent: "", style: {} };
  Object.defineProperty(el, "offsetHeight", {
    get: () => {
      reads++;
      return 100;
    },
  });
  let animation = "";
  Object.defineProperty(el.style, "animation", {
    get: () => animation,
    set: v => {
      animation = v;
      writes.push(v);
    },
  });
  return { el, reads: () => reads, writes };
}

describe("淡入动画播放", async() => {
  await it("文案变化：none → 重排 → fadeInUp 三步", async() => {
    const d = makeDescEl();
    const { updateStepDescAnimation } = createStepDescAnimation({ stepDescEl: d.el });
    d.el.textContent = "第 1 步：取下后面板";
    updateStepDescAnimation();
    assert(d.el.style.animation === "fadeInUp 0.5s ease-out", "最终落 fadeInUp 0.5s ease-out");
    assert(
      d.writes.join(",") === "none,fadeInUp 0.5s ease-out",
      "赋值序列：先 none 重置再 fadeInUp（none 缺失将杀死该断言）",
    );
    assert(d.reads() === 1, "void offsetHeight 触发一次重排");
  });

  await it("文案未变：不碰 animation", async() => {
    const d = makeDescEl();
    const { updateStepDescAnimation } = createStepDescAnimation({ stepDescEl: d.el });
    d.el.textContent = "同一句";
    updateStepDescAnimation();
    d.el.style.animation = "fadeInUp 0.5s ease-out";
    updateStepDescAnimation();
    assert(d.el.style.animation === "fadeInUp 0.5s ease-out", "保持既有值");
    assert(d.reads() === 1, "不触发重排");
  });

  await it("文案再变：重播一次", async() => {
    const d = makeDescEl();
    const { updateStepDescAnimation } = createStepDescAnimation({ stepDescEl: d.el });
    d.el.textContent = "A";
    updateStepDescAnimation();
    d.el.textContent = "B";
    updateStepDescAnimation();
    assert(d.el.style.animation === "fadeInUp 0.5s ease-out", "新文案再次淡入");
    assert(d.reads() === 2, "第二次变化再触发一次重排");
  });

  await it("首次调用即非空文案：播一次", async() => {
    const d = makeDescEl();
    const { updateStepDescAnimation } = createStepDescAnimation({ stepDescEl: d.el });
    d.el.textContent = "初始步骤";
    updateStepDescAnimation();
    assert(d.el.style.animation === "fadeInUp 0.5s ease-out", "首次即播放");
  });

  await it("stepDescEl 缺失：静默返回", async() => {
    const { updateStepDescAnimation } = createStepDescAnimation({ stepDescEl: null });
    let threw = null;
    try {
      updateStepDescAnimation();
    } catch (err) {
      threw = err;
    }
    assert(threw === null, "不抛错");
  });
});

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
