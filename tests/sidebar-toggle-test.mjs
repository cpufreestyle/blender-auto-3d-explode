#!/usr/bin/env node
/**
 * 单元测试 — 侧栏折叠（src/sidebar-toggle.js）
 *
 * 钉住的不变量：
 *   - 缺省展开：面板无 .collapsed、浮动展开钮 .hidden、aria-expanded=true；
 *   - localStorage("quest3-sidebar") === "collapsed" 时初始即收起（记忆生效）；
 *   - 点收起钮：.collapsed + inert + 展开钮显身 + 写回存储；
 *   - 点展开钮：全部还原 + 写回 "open"；
 *   - 收起时把面板设为 inert——否则 Tab 照样能钻进一块看不见的面板；
 *     元素不支持 inert 时退化成「只是看不见」，不抛错也不假装设置了；
 *   - 键盘用户：焦点跟着面板走，别留在已经 inert 的按钮上；
 *   - toggle() 返回值语义：收起 true / 展开 false；
 *   - 面板或任一按钮缺失：静默返回 null，不抛。
 *
 * 用法：node tests/sidebar-toggle-test.mjs
 */

import { setupSidebarToggle } from "../src/sidebar-toggle.js";

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

// ===== 假 DOM / 假 localStorage =====
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
});

function makeEl(id, opts = {}) {
  const classes = new Set(opts.classes || []);
  const el = {
    id,
    attrs: {},
    listeners: {},
    inert: false,
    classList: {
      has: c => classes.has(c),
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, on) => {
        const should = on === undefined ? !classes.has(c) : !!on;
        if (should) classes.add(c);
        else classes.delete(c);
        return should;
      },
    },
    setAttribute(n, v) { el.attrs[n] = String(v); },
    getAttribute(n) { return n in el.attrs ? el.attrs[n] : null; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    click() { for (const fn of el.listeners.click || []) fn({}); },
    focus() { globalThis.document.activeElement = el; },
  };
  return el;
}

const doc = { activeElement: null, elements: {}, getElementById: id => doc.elements[id] || null };
Object.defineProperty(globalThis, "document", { configurable: true, value: doc });

function setupGrid({ saved = null, withInert = true } = {}) {
  store.clear();
  if (saved !== null) store.set("quest3-sidebar", saved);
  doc.activeElement = null;
  doc.elements = {
    "ui-overlay": makeEl("ui-overlay"),
    "sidebar-collapse": makeEl("sidebar-collapse"),
    "sidebar-expand": makeEl("sidebar-expand", { classes: ["hidden"] }),
  };
  if (!withInert) delete doc.elements["ui-overlay"].inert;
  const mod = setupSidebarToggle();
  return {
    mod,
    overlay: doc.elements["ui-overlay"],
    collapse: doc.elements["sidebar-collapse"],
    expand: doc.elements["sidebar-expand"],
  };
}

describe("侧栏折叠", () => {
  it("缺省展开，不碰存储", () => {
    const { mod, overlay, collapse, expand } = setupGrid();
    assert(mod !== null, "三个元素齐全时返回实例");
    assert(!overlay.classList.has("collapsed"), "面板默认展开");
    assert(expand.classList.has("hidden"), "浮动展开钮默认隐藏");
    assert(collapse.getAttribute("aria-expanded") === "true", "收起钮 aria-expanded=true");
    assert(expand.getAttribute("aria-expanded") === "true", "展开钮 aria-expanded=true");
    assert(overlay.inert === false, "展开状态不设 inert");
    assert(store.size === 0, "首次加载不主动写存储");
  });

  it("记住上次收起：初始即收起 + inert + 展开钮可见", () => {
    const { overlay, collapse, expand } = setupGrid({ saved: "collapsed" });
    assert(overlay.classList.has("collapsed"), "面板带 .collapsed");
    assert(overlay.inert === true, "收起时 inert（Tab 不该钻进看不见的面板）");
    assert(!expand.classList.has("hidden"), "浮动展开钮显身");
    assert(collapse.getAttribute("aria-expanded") === "false", "收起钮 aria-expanded=false");
    assert(expand.getAttribute("aria-expanded") === "false", "展开钮 aria-expanded=false");
  });

  it("点收起钮：收起、写存储、展开钮显身", () => {
    const { overlay, collapse, expand } = setupGrid();
    collapse.click();
    assert(overlay.classList.has("collapsed"), "面板收起");
    assert(overlay.inert === true, "inert 生效");
    assert(!expand.classList.has("hidden"), "展开钮显身");
    assert(store.get("quest3-sidebar") === "collapsed", "写回 collapsed");
  });

  it("点展开钮：还原、写回 open", () => {
    const { mod, overlay, expand } = setupGrid({ saved: "collapsed" });
    expand.click();
    assert(!overlay.classList.has("collapsed"), "面板还原");
    assert(overlay.inert === false, "inert 撤掉");
    assert(expand.classList.has("hidden"), "展开钮又隐藏");
    assert(store.get("quest3-sidebar") === "open", "写回 open");
    assert(mod.isCollapsed() === false, "isCollapsed() = false");
  });

  it("toggle() 返回值语义与实例状态一致", () => {
    const { mod } = setupGrid();
    assert(mod.toggle() === true, "收起返回 true");
    assert(mod.isCollapsed() === true, "isCollapsed() = true");
    assert(mod.toggle() === false, "再 toggle 返回 false");
    assert(mod.isCollapsed() === false, "isCollapsed() = false");
  });

  it("键盘用户：焦点跟着面板走，不停在 inert 按钮上", () => {
    const { collapse, expand } = setupGrid();
    collapse.focus();
    collapse.click();
    assert(doc.activeElement === expand, "收起后焦点移到展开钮");
    expand.click();
    assert(doc.activeElement === collapse, "展开后焦点移回收起钮");
  });

  it("元素不支持 inert 时：不加类以外的东西，也不抛", () => {
    const { overlay, collapse } = setupGrid({ withInert: false });
    collapse.click();
    assert(overlay.classList.has("collapsed"), "仍能收起");
    assert(!("inert" in overlay), "没有 inert 属性就不赋值（不假装支持）");
  });

  it("面板或按钮缺失：静默返回 null", () => {
    store.clear();
    doc.activeElement = null;
    // 用 try 包住：少了静默守卫时这里会抛 TypeError，同样算回归，但报出来要是断言而不是崩溃
    const trySetup = () => {
      try {
        return { result: setupSidebarToggle(), threw: null };
      } catch (e) {
        return { result: undefined, threw: e.message };
      }
    };
    doc.elements = { "ui-overlay": makeEl("ui-overlay") };
    let r = trySetup();
    assert(r.result === null && r.threw === null, `缺按钮时静默返回 null（结果 ${r.result}，抛错 ${r.threw}）`);
    doc.elements = { "sidebar-collapse": makeEl("c"), "sidebar-expand": makeEl("e") };
    r = trySetup();
    assert(r.result === null && r.threw === null, `缺面板时静默返回 null（结果 ${r.result}，抛错 ${r.threw}）`);
    doc.elements = {};
    r = trySetup();
    assert(r.result === null && r.threw === null, `全缺时静默返回 null（结果 ${r.result}，抛错 ${r.threw}）`);
  });
});

for (const { name, fn } of describeQueue) {
  console.log(`\n[${name}]`);
  fn();
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log("  失败项：");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(failed === 0 ? "  ✅ 全部测试通过！" : "  ❌ 存在失败");
process.exit(failed === 0 ? 0 : 1);
