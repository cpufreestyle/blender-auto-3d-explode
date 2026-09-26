#!/usr/bin/env node
/**
 * 单元测试 — 乐高/原生外观切换（src/style-toggle.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 初值：localStorage("quest3-model-style")（缺省 "native"）决定
 *     applyModelStyle 的首次调用参数；按钮文案「🛠️ 原生风格」/「🧱 乐高风格」，
 *     lego 类随 style === "lego" 切换（toggle 第二参）；
 *   - 点击：native ↔ lego 翻转，applyModelStyle 以新值再调一次，存储回写，
 *     文案/类同步，放 rotate(360deg) scale(1.05) 动画，300ms 后清空
 *     style.transform；
 *   - 按钮缺失时静默跳过，applyModelStyle 一次都不调；
 *   - 初值与每次点击各触发一次 applyModelStyle，无额外调用。
 *
 * 用法：node tests/style-toggle-test.mjs
 */

import { setupStyleToggle } from "../src/style-toggle.js";

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

// ===== 假 DOM / 假存储 / 假计时器 =====
function makeEl() {
  const listeners = {};
  const classes = new Set();
  return {
    textContent: "",
    style: {},
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, on) => {
        if (on) classes.add(c);
        else classes.delete(c);
      },
      contains: c => classes.has(c),
      has: c => classes.has(c),
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fire: type => listeners[type] && listeners[type](),
    hasListener: type => typeof listeners[type] === "function",
    classes,
  };
}

function setup(opts = {}) {
  const store = {};
  const timers = [];
  const calls = [];
  const btn = opts.noButton ? null : makeEl();
  const doc = {
    getElementById: id => (id === "style-toggle" ? btn : null),
    createElement: () => makeEl(),
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    value: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    configurable: true,
  });
  const applyModelStyle = s => calls.push(s);
  setupStyleToggle({ applyModelStyle });
  return { btn, store, timers, calls };
}

describe("初值", async() => {
  await it("缺省 native：applyModelStyle(native)、原生文案、无 lego 类", async() => {
    const w = setup();
    assert(w.calls.length === 1 && w.calls[0] === "native", "首次调用参数 native");
    assert(w.btn.textContent === "🛠️ 原生风格", "文案为原生风格");
    assert(!w.btn.classList.contains("lego"), "无 lego 类");
  });

  await it("存储 lego：applyModelStyle(lego)、乐高文案、挂 lego 类", async() => {
    const w = setup();
    w.store["quest3-model-style"] = "lego";
    w.btn.textContent = "";
    setupStyleToggle({ applyModelStyle: s => w.calls.push(s) });
    assert(w.calls[w.calls.length - 1] === "lego", "再次初始化调用参数 lego");
    assert(w.btn.textContent === "🧱 乐高风格", "文案为乐高风格");
    assert(w.btn.classList.contains("lego"), "挂上 lego 类");
  });
});

describe("点击翻转", async() => {
  await it("native → lego：翻转、回写、文案/类、动画与 300ms 复位", async() => {
    const w = setup();
    w.btn.fire("click");
    assert(w.calls.length === 2 && w.calls[1] === "lego", "第二次调用参数 lego");
    assert(w.store["quest3-model-style"] === "lego", "存储回写 \"lego\"");
    assert(w.btn.textContent === "🧱 乐高风格", "文案切乐高风格");
    assert(w.btn.classList.contains("lego"), "挂上 lego 类");
    assert(
      w.btn.style.transform === "rotate(360deg) scale(1.05)",
      "切换动画 transform 已设置",
    );
    assert(w.timers.length === 1 && w.timers[0].ms === 300, "排了一个 300ms 定时器");
    w.timers[0].fn();
    assert(w.btn.style.transform === "", "300ms 后 transform 清空");
  });

  await it("lego → native：再点回落", async() => {
    const w = setup();
    w.store["quest3-model-style"] = "lego";
    setupStyleToggle({ applyModelStyle: s => w.calls.push(s) });
    w.btn.fire("click");
    assert(w.calls[w.calls.length - 1] === "native", "末次调用参数 native");
    assert(w.store["quest3-model-style"] === "native", "存储回写 \"native\"");
    assert(w.btn.textContent === "🛠️ 原生风格", "文案切回原生风格");
    assert(!w.btn.classList.contains("lego"), "lego 类移除");
  });
});

describe("按钮缺失", async() => {
  await it("无 style-toggle：静默，applyModelStyle 不调", async() => {
    const w = setup({ noButton: true });
    assert(w.calls.length === 0, "一次都不调用");
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
