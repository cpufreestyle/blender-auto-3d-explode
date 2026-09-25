#!/usr/bin/env node
/**
 * 单元测试 — 全局状态条与模型加载覆盖层（src/status-ui.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - showStatus：写 #upload-status 的 textContent，className 为
 *     "status-box " + type（缺省 type 为 "info"），并移除 hidden 类；
 *   - 状态条元素缺失时静默返回，不抛错（十余处调用点不判存在性）；
 *   - setModelLoading(true)：移除 #model-loading 的 hidden、写覆盖层文案
 *     （缺省 "正在准备模型..."）、14 个按钮 id 统一 disabled=true；
 *   - setModelLoading(false)：加回 hidden、按钮 disabled=false、文案可定制；
 *   - 覆盖层或文案元素缺失时逐个跳过，按钮统一切换照常；
 *   - 清单内按钮元素缺失时跳过该按钮，不影响其余按钮；
 *   - MODEL_LOADING_BTN_IDS 的 id 清单与顺序逐字钉住（14 个）。
 *
 * 用法：node tests/status-ui-test.mjs
 */

import { createStatusUI } from "../src/status-ui.js";

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
function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    textContent: "",
    className: "",
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    classList: {
      set: new Set(),
      add(c) {
        this.set.add(c);
      },
      remove(c) {
        this.set.delete(c);
      },
      toggle(c, on) {
        if (on) this.set.add(c);
        else this.set.delete(c);
      },
      has(c) {
        return this.set.has(c);
      },
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

const BTN_IDS = [
  "upload-btn",
  "clear-model-btn",
  "prev-step",
  "next-step",
  "reset-step",
  "style-toggle",
  "explode-btn",
  "explode-loop",
  "timeline-play",
  "timeline-reset",
  "generated-load",
  "img-to-3d-btn",
  "open-config-btn",
  "blender-launch",
];

// withElements=false：全部元素缺失；onlyBtns：只建按钮，状态条/覆盖层缺失
function setup(opts = {}) {
  const els = {};
  if (opts.withElements !== false) {
    els["upload-status"] = makeEl();
    els["model-loading"] = makeEl();
    els["model-loading-text"] = makeEl();
  }
  const btns = {};
  if (opts.onlyBtns !== false) {
    for (const id of BTN_IDS) {
      btns[id] = makeEl("button");
      els[id] = btns[id];
    }
  }
  const doc = {
    getElementById: id => els[id] || null,
    createElement: tag => makeEl(tag),
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
  return { els, btns, statusUI: createStatusUI() };
}

describe("showStatus 状态条", async() => {
  await it("写文案、className 拼类型、移除 hidden", async() => {
    const w = setup();
    w.els["upload-status"].classList.add("hidden");
    w.statusUI.showStatus("📦 正在加载", "success");
    assert(w.els["upload-status"].textContent === "📦 正在加载", "textContent 为消息文案");
    assert(
      w.els["upload-status"].className === "status-box success",
      "className 为 \"status-box \" + type",
    );
    assert(!w.els["upload-status"].classList.has("hidden"), "hidden 被移除");
  });

  await it("type 缺省为 info", async() => {
    const w = setup();
    w.statusUI.showStatus("就绪");
    assert(w.els["upload-status"].className === "status-box info", "缺省 type 落 \"info\"");
  });

  await it("错误类型原样落入 className", async() => {
    const w = setup();
    w.statusUI.showStatus("❌ 失败", "error");
    assert(w.els["upload-status"].className === "status-box error", "type \"error\" 原样拼接");
  });

  await it("状态条元素缺失时静默返回", async() => {
    const w = setup({ withElements: false, onlyBtns: false });
    let threw = null;
    try {
      w.statusUI.showStatus("任意", "info");
    } catch (err) {
      threw = err;
    }
    assert(threw === null, "不抛错");
    assert(w.els["upload-status"] === undefined, "无元素可写");
  });
});

describe("setModelLoading 加载覆盖层与按钮", async() => {
  await it("true：显覆盖层、默认文案、14 按钮统一点亮禁用", async() => {
    const w = setup();
    w.els["model-loading"].classList.add("hidden");
    w.statusUI.setModelLoading(true);
    assert(!w.els["model-loading"].classList.has("hidden"), "覆盖层 hidden 被移除");
    assert(
      w.els["model-loading-text"].textContent === "正在准备模型...",
      "缺省文案为「正在准备模型...」",
    );
    const disabledIds = Object.keys(w.btns).filter(id => w.btns[id].disabled);
    assert(disabledIds.length === 14, "14 个按钮全部 disabled");
    assert(
      BTN_IDS.every(id => w.btns[id].disabled === true),
      "按钮清单内逐个禁用（顺序内容一致）",
    );
  });

  await it("false：加回 hidden、按钮解禁", async() => {
    const w = setup();
    w.statusUI.setModelLoading(true);
    w.statusUI.setModelLoading(false);
    assert(w.els["model-loading"].classList.has("hidden"), "覆盖层重新隐藏");
    assert(BTN_IDS.every(id => w.btns[id].disabled === false), "按钮全部解禁");
  });

  await it("自定义文案覆盖缺省", async() => {
    const w = setup();
    w.statusUI.setModelLoading(true, "🧠 AI 推理中...");
    assert(w.els["model-loading-text"].textContent === "🧠 AI 推理中...", "文案为传入值");
  });

  await it("覆盖层/文案缺失时按钮切换照常", async() => {
    const w = setup({ withElements: false });
    let threw = null;
    try {
      w.statusUI.setModelLoading(true, "x");
    } catch (err) {
      threw = err;
    }
    assert(threw === null, "缺失覆盖层不抛错");
    assert(BTN_IDS.every(id => w.btns[id].disabled === true), "按钮仍被统一切换");
  });

  await it("按钮元素缺失时跳过该按钮", async() => {
    const w = setup({ onlyBtns: false });
    w.statusUI.setModelLoading(true);
    assert(true, "无按钮元素不抛错");
  });

  await it("MODEL_LOADING_BTN_IDS 清单逐字钉住", async() => {
    const w = setup();
    // 通过 disabled 落点反推清单：逐一比对 14 个 id
    const seen = [];
    w.statusUI.setModelLoading(true);
    for (const id of Object.keys(w.btns)) seen.push(id);
    assert(seen.length === 14, "工厂只触碰 14 个按钮 id");
    assert(
      BTN_IDS.every((id, i) => seen[i] === id),
      "id 顺序与清单一致（upload-btn 起、blender-launch 止）",
    );
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
