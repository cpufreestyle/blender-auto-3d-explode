#!/usr/bin/env node
/**
 * 单元测试 — 键盘快捷键（src/keyboard-shortcuts.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - →/←：goToStep(getDisplayedStep() ± 1)（displayedStep 经注入的
 *     getter 惰性读取，钉住「读的是当前值」）；
 *   - 空格：toggleExplode；r/R：goToStep(0)；
 *   - a/A：翻转 autoRotateCheck.checked 并同步 controls.autoRotate；
 *   - f/F：focusCurrentPart；s/S：exportScreenshot；
 *   - 每个分支均 preventDefault；
 *   - target 为 INPUT/TEXTAREA 时整体忽略（不 preventDefault、不触发动作）；
 *   - 未列出的键无动作；
 *   - autoRotateCheck 的 change 把 e.target.checked 回写 controls.autoRotate。
 *
 * 用法：node tests/keyboard-shortcuts-test.mjs
 */

import { setupKeyboardShortcuts } from "../src/keyboard-shortcuts.js";

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
function setup(displayed = 2) {
  const keyListeners = {};
  const changeListeners = {};
  const autoRotateCheck = {
    checked: false,
    addEventListener: (type, fn) => {
      changeListeners[type] = fn;
    },
  };
  const doc = {
    addEventListener: (type, fn) => {
      keyListeners[type] = fn;
    },
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });

  const calls = [];
  const rec = name => (...args) => {
    calls.push({ name, args });
  };
  const explodeCtl = {
    goToStep: rec("goToStep"),
    toggleExplode: rec("toggleExplode"),
    focusCurrentPart: rec("focusCurrentPart"),
  };
  const controls = { autoRotate: true };
  const exportPanel = { exportScreenshot: rec("exportScreenshot") };
  let step = displayed;

  setupKeyboardShortcuts({
    explodeCtl,
    controls,
    autoRotateCheck,
    exportPanel,
    getDisplayedStep: () => step,
  });
  const key = (k, target = { tagName: "DIV" }) => {
    let prevented = false;
    keyListeners.keydown({
      key: k,
      target,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  const setStep = v => {
    step = v;
  };
  return { calls, key, controls, autoRotateCheck, setStep, changeListeners };
}

describe("keydown 分发", async() => {
  await it("ArrowRight/ArrowLeft：相对当前步 ±1 且 preventDefault", async() => {
    const w = setup(2);
    const p1 = w.key("ArrowRight");
    const p2 = w.key("ArrowLeft");
    assert(w.calls.length === 2, "两次 goToStep");
    assert(w.calls[0].name === "goToStep" && w.calls[0].args[0] === 3, "→ 走 2+1");
    assert(w.calls[1].name === "goToStep" && w.calls[1].args[0] === 1, "← 走 2-1");
    assert(p1 && p2, "两个分支都 preventDefault");
  });

  await it("步进读的是 getter 当前值（状态后变）", async() => {
    const w = setup(0);
    w.setStep(5);
    w.key("ArrowRight");
    assert(w.calls[0].args[0] === 6, "读到更新后的 displayedStep=5");
  });

  await it("空格 / r / R / f / F / s / S 各路动作", async() => {
    const w = setup();
    const prevented = [
      w.key(" "),
      w.key("r"),
      w.key("R"),
      w.key("f"),
      w.key("F"),
      w.key("s"),
      w.key("S"),
    ];
    const names = w.calls.map(c => c.name);
    const expectNames = [
      "toggleExplode",
      "goToStep",
      "goToStep",
      "focusCurrentPart",
      "focusCurrentPart",
      "exportScreenshot",
      "exportScreenshot",
    ].join(",");
    assert(names.join(",") === expectNames, "动作序列：toggle → goToStep(0) ×2 → focus ×2 → 截图 ×2");
    assert(w.calls[1].args[0] === 0 && w.calls[2].args[0] === 0, "r/R 均回步骤 0");
    assert(prevented.every(Boolean), "全部 preventDefault");
  });

  await it("a/A：翻转 checkbox 并同步 controls.autoRotate", async() => {
    const w = setup();
    w.key("a");
    assert(w.autoRotateCheck.checked === true, "checkbox 翻为 true");
    assert(w.controls.autoRotate === true, "controls 同步 true");
    w.key("A");
    assert(w.autoRotateCheck.checked === false, "再翻回 false");
    assert(w.controls.autoRotate === false, "controls 同步 false");
  });

  await it("INPUT/TEXTAREA 内忽略", async() => {
    const w = setup();
    const p = w.key("ArrowRight", { tagName: "INPUT" });
    assert(w.calls.length === 0, "不触发任何动作");
    assert(!p, "不 preventDefault");
    w.key(" ", { tagName: "TEXTAREA" });
    assert(w.calls.length === 0, "TEXTAREA 同样忽略");
  });

  await it("未列出键无动作", async() => {
    const w = setup();
    w.key("q");
    assert(w.calls.length === 0, "q 无动作");
  });
});

describe("autoRotate change 回写", async() => {
  await it("change 事件把 checked 写入 controls.autoRotate", async() => {
    const w = setup();
    w.changeListeners.change({ target: { checked: true } });
    assert(w.controls.autoRotate === true, "true 回写");
    w.changeListeners.change({ target: { checked: false } });
    assert(w.controls.autoRotate === false, "false 回写");
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
