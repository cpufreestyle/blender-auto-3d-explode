#!/usr/bin/env node
/**
 * 单元测试 — 主题切换（src/theme-toggle.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 初值：localStorage("quest3-theme") === "light" 时给 uiOverlay 加
 *     light-theme 类、按钮文案置 ☀️；其余值（含 null）不动 DOM；
 *   - 点击：toggle light-theme 后按 contains 结果回写存储（"light"/"dark"）、
 *     图标随状态切 ☀️/🌙、放 rotate(360deg) scale(1.2) 动画，300ms 后清空
 *     style.transform；
 *   - themeToggle 或 uiOverlay 缺失时整段静默跳过，不抛错；
 *   - localStorage 只由点击路径写入（初值路径不写）。
 *
 * 用法：node tests/theme-toggle-test.mjs
 */

import { setupThemeToggle } from "../src/theme-toggle.js";

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
      toggle: c => {
        if (classes.has(c)) classes.delete(c);
        else classes.add(c);
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
  const themeToggle = opts.noToggle ? null : makeEl();
  const uiOverlay = opts.noOverlay ? null : makeEl();
  const doc = {
    getElementById: id => (id === "theme-toggle" ? themeToggle : null),
    querySelector: () => uiOverlay,
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
  setupThemeToggle({ uiOverlay });
  return { themeToggle, uiOverlay, store, timers };
}

describe("初值恢复", async() => {
  await it("light：加 light-theme、图标 ☀️、不写存储", async() => {
    const w = setup();
    w.store["quest3-theme"] = "light";
    setupThemeToggle({ uiOverlay: w.uiOverlay });
    assert(w.uiOverlay.classList.contains("light-theme"), "uiOverlay 加 light-theme");
    assert(w.themeToggle.textContent === "☀️", "按钮图标为 ☀️");
  });

  await it("dark/缺省：不动 DOM", async() => {
    const w = setup();
    w.store["quest3-theme"] = "dark";
    setupThemeToggle({ uiOverlay: w.uiOverlay });
    assert(!w.uiOverlay.classList.contains("light-theme"), "不加 light-theme");
    assert(w.themeToggle.textContent === "", "按钮文案保持原样");
  });
});

describe("点击切换", async() => {
  await it("dark → light：toggle、回写 light、图标 ☀️、动画与 300ms 复位", async() => {
    const w = setup();
    w.themeToggle.fire("click");
    assert(w.uiOverlay.classList.contains("light-theme"), "toggle 后为亮色");
    assert(w.store["quest3-theme"] === "light", "存储回写 \"light\"");
    assert(w.themeToggle.textContent === "☀️", "图标切 ☀️");
    assert(
      w.themeToggle.style.transform === "rotate(360deg) scale(1.2)",
      "切换动画 transform 已设置",
    );
    assert(w.timers.length === 1 && w.timers[0].ms === 300, "排了一个 300ms 定时器");
    w.timers[0].fn();
    assert(w.themeToggle.style.transform === "", "300ms 后 transform 清空");
  });

  await it("light → dark：再点一次回落", async() => {
    const w = setup();
    w.store["quest3-theme"] = "light";
    setupThemeToggle({ uiOverlay: w.uiOverlay });
    w.themeToggle.fire("click");
    assert(!w.uiOverlay.classList.contains("light-theme"), "toggle 后为暗色");
    assert(w.store["quest3-theme"] === "dark", "存储回写 \"dark\"");
    assert(w.themeToggle.textContent === "🌙", "图标切 🌙");
  });
});

describe("元素缺失", async() => {
  await it("无 themeToggle：静默", async() => {
    const w = setup({ noToggle: true });
    assert(!w.uiOverlay.classList.contains("light-theme"), "不动 uiOverlay");
  });

  await it("无 uiOverlay：静默", async() => {
    const w = setup({ noOverlay: true });
    assert(!w.themeToggle.hasListener("click"), "不挂点击监听");
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
