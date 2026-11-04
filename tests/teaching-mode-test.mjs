#!/usr/bin/env node
/**
 * 单元测试 — 授课模式（src/teaching-mode.js）
 *
 * 钉住的不变量：
 *   - 缺省关闭：目标面板一个都不收，按钮处于「授课模式」待命态；
 *   - 开启后每个目标元素（含 .hint 这种会命中多个的选择器）都加 .hidden，
 *     再点一次逐个还原——两个方向都遍历全表，不能只收不还；
 *   - 建站即按 storage 恢复：老师在讲台上刷新页面不该又见到满屏生成面板；
 *   - storage 抛错（隐私模式 / 配额满）不崩，只是不记忆；
 *   - 选择器写错只跳过那一条，不影响其余面板与开关本身；
 *   - 按钮缺失时（裁剪版页面）模块仍可用，返回的 enable/disable/toggle 语义不变。
 *
 * 用法：node tests/teaching-mode-test.mjs
 */

import {
  setupTeachingMode,
  TEACHING_BODY_CLASS,
  TEACHING_HIDE_SELECTORS,
  TEACHING_STORAGE_KEY,
} from "../src/teaching-mode.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log("  OK " + message);
    passed++;
  } else {
    console.error("  FAIL " + message);
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
function makeClassList(classes) {
  const set = new Set(classes || []);
  return {
    _set: set,
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: (c, force) => {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c);
      else set.delete(c);
      return want;
    },
  };
}

function makeEl(tag, opts) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    classList: makeClassList((opts || {}).classes),
    attrs: {},
    listeners: {},
    textContent: "",
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    click() {
      (this.listeners.click || []).forEach(fn => fn());
    },
  };
  return el;
}

function installDocument(targets) {
  const doc = {
    body: makeEl("body"),
    querySelectorAll(selector) {
      return targets.has(selector) ? targets.get(selector) : [];
    },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return doc;
}

function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function buildWorld(opts) {
  const options = opts || {};
  const targets = new Map();
  for (const selector of options.selectors || TEACHING_HIDE_SELECTORS) {
    const count = selector === ".hint" ? 2 : 1;
    targets.set(selector, Array.from({ length: count }, () => makeEl("div")));
  }
  const doc = installDocument(targets);
  const storage = options.storage || makeStorage({});
  const btn = options.btn === null ? null : makeEl("button");
  const mode = setupTeachingMode({
    btn,
    hideSelectors: options.selectors || TEACHING_HIDE_SELECTORS,
    storage,
  });
  return { mode, doc, storage, btn, targets };
}

describe("默认态", () => {
  it("缺省关闭且按钮待命", () => {
    const w = buildWorld();
    assert(w.mode.isEnabled() === false, "未开启");
    assert(w.doc.body.classList.contains(TEACHING_BODY_CLASS) === false, "body 无授课类");
    assert(w.btn.textContent === "🎓 授课模式", "按钮文案：" + w.btn.textContent);
    assert(w.btn.getAttribute("aria-pressed") === "false", "aria-pressed=false");
    assert(w.btn.classList.contains("active") === false, "未激活");
    for (const [selector, nodes] of w.targets) {
      for (const el of nodes) {
        assert(el.classList.contains("hidden") === false, selector + " 未收起");
      }
    }
  });
});

describe("开启 / 退出", () => {
  it("开启后逐个收起并落存储", () => {
    const w = buildWorld();
    w.btn.click();
    assert(w.mode.isEnabled() === true, "已开启");
    assert(w.doc.body.classList.contains(TEACHING_BODY_CLASS) === true, "body 打上课授课类");
    assert(w.storage.map.get(TEACHING_STORAGE_KEY) === "1", "存储写 1");
    assert(w.btn.textContent === "🎓 退出授课", "按钮文案切换");
    assert(w.btn.getAttribute("aria-pressed") === "true", "aria-pressed=true");
    assert(w.btn.classList.contains("active") === true, "按钮激活态");
    let hidden = 0;
    for (const [selector, nodes] of w.targets) {
      for (const el of nodes) {
        if (el.classList.contains("hidden")) hidden++;
      }
    }
    assert(hidden === 6, "6 个目标元素全部收起（.hint 命中 2 个），实际 " + hidden);
  });

  it("再点一次全部还原", () => {
    const w = buildWorld();
    w.btn.click();
    w.btn.click();
    assert(w.mode.isEnabled() === false, "已退出");
    assert(w.storage.map.get(TEACHING_STORAGE_KEY) === "0", "存储写 0");
    let stillHidden = 0;
    for (const [, nodes] of w.targets) {
      for (const el of nodes) if (el.classList.contains("hidden")) stillHidden++;
    }
    assert(stillHidden === 0, "没有元素被漏还原，实际 " + stillHidden);
  });

  it("原本带 .hidden 的元素退出后不该被误还原", () => {
    // #blender-banner 常态就是 .hidden（没检测到 Blender 时也不显示），
    // 授课模式不该把它「还」出来。
    const targets = new Map();
    const banner = makeEl("div", { classes: ["hidden"] });
    targets.set("#blender-banner", [banner]);
    installDocument(targets);
    const mode = setupTeachingMode({ btn: null, hideSelectors: ["#blender-banner"], storage: makeStorage({}) });
    mode.toggle();
    mode.toggle();
    assert(banner.classList.contains("hidden") === true, "退出后仍保持隐藏");
  });
});

describe("记忆与容错", () => {
  it("建站即恢复上次的开启态", () => {
    const w = buildWorld({ storage: makeStorage({ [TEACHING_STORAGE_KEY]: "1" }) });
    assert(w.mode.isEnabled() === true, "存储为 1 时初始即开启");
    for (const [selector, nodes] of w.targets) {
      for (const el of nodes) {
        assert(el.classList.contains("hidden") === true, selector + " 初始即收起");
      }
    }
  });

  it("storage 抛错不崩", () => {
    const broken = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceeded");
      },
    };
    let threw = false;
    let mode = null;
    try {
      mode = setupTeachingMode({ btn: makeEl("button"), storage: broken });
      mode.toggle();
      mode.toggle();
    } catch (e) {
      threw = true;
    }
    assert(!threw, "读写都抛错也不该炸");
    assert(mode && mode.isEnabled() === false, "状态仍可翻转");
  });

  it("选择器写错只跳过那一条", () => {
    const targets = new Map();
    const panel = makeEl("div");
    targets.set("#upload-panel", [panel]);
    installDocument(targets);
    const mode = setupTeachingMode({
      btn: null,
      hideSelectors: ["#upload-panel", ":::bad("],
      storage: makeStorage({}),
    });
    mode.enable();
    assert(panel.classList.contains("hidden") === true, "正常选择器照常生效");
    assert(mode.isEnabled() === true, "开关本身没被带崩");
  });

  it("按钮缺失时 API 仍可用", () => {
    const w = buildWorld({ btn: null });
    assert(w.mode.toggle() === true, "toggle → true");
    assert(w.mode.isEnabled() === true, "已开启");
    assert(w.mode.disable() === false, "disable → false");
    assert(w.mode.enable() === true, "enable → true");
    assert(w.mode.hideSelectors.length === TEACHING_HIDE_SELECTORS.length, "选择器表可读");
  });
});

for (const { name, fn } of describeQueue) {
  console.log(name);
  fn();
}

console.log("结果: " + passed + " 通过, " + failed + " 失败");
if (failed > 0) {
  console.error("失败项:", failures.join("; "));
  process.exit(1);
}
