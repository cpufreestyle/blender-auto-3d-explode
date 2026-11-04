#!/usr/bin/env node
/**
 * 单元测试 — 3D 打印面板接线层（src/print-panel.js）
 *
 * 分析算法与 STL 序列化分别在 tests/print-analyze-test.mjs 与
 * tests/print-export-test.mjs 里锁住；这里只锁「接线」这一层最容易坏的部分：
 *   - 部件来源跟随当前模型：hasCustomModel 时取 customModelParts，否则 parts；
 *     切换模型后点预检，分析的是新数组而不是建厂时钉住的旧引用；
 *   - #print-build-volume 的下拉值透传给 analyze / exportModelSTL；
 *   - 空部件（缺 mesh / 缺 position）在导出前被拦住，不产生半个文件；
 *   - 结果表格渲染：汇总徽章配色随 ready / problematic 切换，部件名经 HTML 转义
 *     （自定义模型部件名来自文件名，"模型 <v2>.glb" 不能把整块结果吞掉）；
 *   - 逐部件下载是分批让出宏任务的：既保证每个文件都被触发，又不能同步连环
 *     click（浏览器会合并），也不能无限期挂住按钮；
 *   - 分析抛错时结果是错误框，不是静默无反馈；
 *   - toast 注入缺失时退化成 console 而不是上抛（Blender 未就绪也要能点）。
 *
 * 用法：node tests/print-panel-test.mjs
 */

import { createPrintPanel } from "../src/print-panel.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
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
// 只建模本模块真正用到的面：getElementById / addEventListener / click /
// classList / innerHTML / textContent / value。innerHTML 存原文，断言转义时
// 直接查字符串，比解析 DOM 更贴近「浏览器会怎么解释它」。
function makeEl(id, tag = "div") {
  const classes = new Set();
  const el = {
    id,
    tagName: tag.toUpperCase(),
    value: "",
    disabled: false,
    _innerHTML: "",
    _textContent: "",
    listeners: {},
    style: {},
    classList: {
      set: classes,
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, on) {
        const add = on === undefined ? !classes.has(c) : !!on;
        if (add) classes.add(c);
        else classes.delete(c);
        return add;
      },
    },
    get className() { return [...classes].join(" "); },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = String(v); el._textContent = ""; },
    get textContent() { return el._textContent; },
    set textContent(v) { el._textContent = String(v); el._innerHTML = ""; },
    addEventListener(ev, fn) { el.listeners[ev] = fn; },
    click() { if (el.listeners.click) el.listeners.click(); },
  };
  return el;
}

function installDom(extra = {}) {
  const els = {
    "print-check-btn": makeEl("print-check-btn", "button"),
    "print-stl-btn": makeEl("print-stl-btn", "button"),
    "print-build-volume": makeEl("print-build-volume", "select"),
    "print-result": makeEl("print-result", "div"),
    ...extra,
  };
  const doc = {
    getElementById(id) { return els[id] || null; },
    createElement: tag => makeEl("", tag),
    body: makeEl("body", "body"),
  };
  globalThis.document = doc;
  installFakeTimers();
  return els;
}

// ===== 假 setTimeout：导出分批要让出宏任务，测试里手动推进 =====
// 装在 installDom 里而不是模块顶层：逐个 it 各自 restore 过一次全局，
// 顶层装的那份会被前一个用例的 restore 换回真的，后面用例就推进不动了。
let timerQueue = [];
function installFakeTimers() {
  timerQueue = [];
  globalThis.setTimeout = fn => { timerQueue.push(fn); return timerQueue.length; };
}
function flushTimers() {
  let guard = 0;
  while (timerQueue.length && guard++ < 50) timerQueue.shift()();
}

// 面板在缺 showToast 注入时退化成 console.log。测试只关心「没上抛」，
// 不关心打印内容，统一吞掉避免污染断言输出。
function silenceConsole(fn) {
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
}

function restoreGlobals() {
  delete globalThis.document;
}

// ===== 测试数据 =====
const part = (name, index) => ({ mesh: { geometry: {} }, name, index });

function makeAnalysis(overrides = {}) {
  return Object.assign(
    {
      parts: [
        { name: "后盖", index: 0, triangles: 12, sizeMm: [10, 20, 30], volumeMm3: 600,
          issues: [] },
        { name: "电池", index: 1, triangles: 12, sizeMm: [5, 5, 5], volumeMm3: 125,
          issues: ["有 3 条开放边（未封闭），切片无法闭合轮廓"] },
      ],
      summary: { total: 2, watertight: 1, problematic: 1, totalTriangles: 24,
        totalVolumeMm3: 725, ready: false },
      buildVolume: "bambu_x1c",
      buildLabel: "Bambu Lab X1C / P1",
      issues: [],
    },
    overrides,
  );
}

describe("部件来源跟随当前模型", () => {
  it("默认模型读 parts", () => {
    const els = installDom();
    const state = { hasCustomModel: false, parts: [part("后盖", 0)], customModelParts: [] };
    const seen = [];
    createPrintPanel({
      getState: () => state,
      analyze: (parts) => { seen.push(parts); return makeAnalysis(); },
    });
    els["print-check-btn"].click();
    assert(seen.length === 1 && seen[0][0].name === "后盖", "分析拿到 parts 而不是 customModelParts");
    restoreGlobals();
  });

  it("自定义模型读 customModelParts", () => {
    const els = installDom();
    const state = {
      hasCustomModel: true,
      parts: [part("后盖", 0)],
      customModelParts: [part("自定义件", 0)],
    };
    const seen = [];
    createPrintPanel({
      getState: () => state,
      analyze: (parts) => { seen.push(parts); return makeAnalysis(); },
    });
    els["print-check-btn"].click();
    assert(seen.length === 1 && seen[0][0].name === "自定义件", "hasCustomModel 时读 customModelParts");
    restoreGlobals();
  });

  it("建厂后切换模型再点预检，分析的是新数组（getState 惰性读）", () => {
    const els = installDom();
    let state = { hasCustomModel: false, parts: [part("旧件", 0)], customModelParts: [] };
    const seen = [];
    createPrintPanel({
      getState: () => state,
      analyze: (parts) => { seen.push(parts); return makeAnalysis(); },
    });
    els["print-check-btn"].click();
    state = { hasCustomModel: false, parts: [part("新件", 0), part("新件2", 1)], customModelParts: [] };
    els["print-check-btn"].click();
    assert(seen.length === 2, "两次点击各分析一次");
    assert(seen[1].length === 2 && seen[1][0].name === "新件", "第二次拿到切换后的 parts（不是旧引用）");
    restoreGlobals();
  });

  it("parts 不是数组时不崩，只提示", () => {
    const els = installDom();
    const toasts = [];
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: null, customModelParts: [] }),
      analyze: () => makeAnalysis(),
      showToast: (m, t) => toasts.push([m, t]),
    });
    els["print-check-btn"].click();
    assert(toasts.length === 1 && /没有可分析/.test(toasts[0][0]), "空部件给错误提示而非抛错");
    assert(els["print-result"].innerHTML === "", "空部件不渲染结果表格");
    restoreGlobals();
  });
});

describe("构建体积下拉值透传", () => {
  it("analyze 收到 select 的 value", () => {
    const els = installDom();
    els["print-build-volume"].value = "ender3";
    const seen = [];
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: (parts, opts) => { seen.push(opts); return makeAnalysis(); },
    });
    els["print-check-btn"].click();
    assert(seen[0] && seen[0].buildVolume === "ender3", "buildVolume 透传给 analyze");
    restoreGlobals();
  });

  it("select 缺省（页面未接）时传 undefined，让模块走自己的默认机", () => {
    const els = installDom();
    delete els["print-build-volume"];
    const seen = [];
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: (parts, opts) => { seen.push(opts); return makeAnalysis(); },
    });
    els["print-check-btn"].click();
    assert(seen[0] && seen[0].buildVolume === undefined, "缺 select 时不硬塞 buildVolume");
    restoreGlobals();
  });

  it("改下拉自动重跑预检（换打印机不用再点一次按钮）", () => {
    const els = installDom();
    let analyzeCalls = 0;
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: () => { analyzeCalls++; return makeAnalysis(); },
    });
    assert(typeof els["print-build-volume"].listeners.change === "function", "change 已绑定");
    els["print-build-volume"].listeners.change();
    assert(analyzeCalls === 1, "改下拉即重跑分析");
    restoreGlobals();
  });
});

describe("结果表格渲染", () => {
  it("有问题的部件：汇总标 problematic、表格列全、问题列表渲染", () => {
    const els = installDom();
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: () => makeAnalysis(),
    });
    els["print-check-btn"].click();
    const html = els["print-result"].innerHTML;
    assert(!els["print-result"].classList.contains("hidden"), "结果框取消隐藏");
    assert(/print-summary/.test(html), "有汇总徽章");
    assert(/1 \u4e2a\u90e8\u4ef6\u6709\u95ee\u9898/.test(html), "汇总文案报 problematic 数");
    assert(/asm-table print-table/.test(html), "明细表挂了 asm-table + print-table 两类");
    assert(/后盖/.test(html) && /电池/.test(html), "两个部件都列出");
    assert(/10 × 20 × 30/.test(html), "尺寸按毫米三轴展示");
    assert(/600 mm³/.test(html) && /125 mm³/.test(html), "体积按 mm³ 展示");
    assert(/有 3 条开放边/.test(html), "问题列表逐条列出");
    assert(/Bambu Lab X1C \/ P1/.test(html), "目标机名称展示");
    restoreGlobals();
  });

  it("全部合格时汇总标 ready", () => {
    const els = installDom();
    const ok = makeAnalysis({
      parts: [{ name: "后盖", index: 0, triangles: 12, sizeMm: [1, 1, 1], volumeMm3: 1, issues: [] }],
      summary: { total: 1, watertight: 1, problematic: 0, totalTriangles: 12,
        totalVolumeMm3: 1, ready: true },
    });
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: () => ok,
    });
    els["print-check-btn"].click();
    const html = els["print-result"].innerHTML;
    assert(/可直接切片/.test(html), "ready 时文案为可直接切片");
    assert(/水密、无退化面、构建体积内/.test(html), "合格部件列出默认说明");
    restoreGlobals();
  });

  it("部件名里的 HTML 元字符被转义（文件名带 <v2> 不能吞掉结果）", () => {
    const els = installDom();
    const a = makeAnalysis({
      parts: [{ name: "模型 <v2> & \"头显\"", index: 0, triangles: 12, sizeMm: [1, 1, 1],
        volumeMm3: 1, issues: ["尺寸 <b>巨大</b>"] }],
    });
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: () => a,
    });
    els["print-check-btn"].click();
    const html = els["print-result"].innerHTML;
    assert(/模型 &lt;v2&gt; &amp; &quot;头显&quot;/.test(html), "部件名四类元字符全部转义");
    assert(html.indexOf("<b>巨大</b>") === -1, "问题文案不带未转义标签");
    assert(/尺寸 &lt;b&gt;巨大&lt;\/b&gt;/.test(html), "问题文案也转义");
    restoreGlobals();
  });

  it("分析抛错 → 错误框，不是静默无反馈", () => {
    const els = installDom();
    const toasts = [];
    createPrintPanel({
      getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
      analyze: () => { throw new Error("几何体炸了"); },
      showToast: (m, t) => toasts.push([m, t]),
    });
    els["print-check-btn"].click();
    assert(els["print-result"].classList.contains("error"), "结果框切到 error 样式");
    assert(/几何体炸了/.test(els["print-result"].textContent), "错误信息落进结果框");
    assert(toasts.some(t => /几何体炸了/.test(t[0])), "同时弹错误 toast");
    restoreGlobals();
  });
});

describe("逐部件 STL 导出", () => {
  const readyState = () => ({ hasCustomModel: false, parts: [part("后盖", 0)], customModelParts: [] });

  it("每个部件触发一次下载，文件名来自导出结果", () => {
    const els = installDom();
    const downloads = [];
    createPrintPanel({
      getState: readyState,
      exportModelSTL: () => [
        { name: "后盖", filename: "后盖-01.stl", buffer: new ArrayBuffer(8), triangles: 4, sizeMm: [1, 1, 1] },
        { name: "电池", filename: "电池-02.stl", buffer: new ArrayBuffer(8), triangles: 4, sizeMm: [1, 1, 1] },
      ],
      triggerDownload: (buf, name) => downloads.push(name),
    });
    els["print-stl-btn"].click();
    assert(downloads.length === 1, "同步阶段只触发第一个（其余让出宏任务）");
    flushTimers();
    assert(downloads.length === 2, "推进定时器后第二个也触发");
    assert(downloads[0] === "后盖-01.stl" && downloads[1] === "电池-02.stl", "文件名逐个透传");
    assert(els["print-stl-btn"].disabled === false, "导完恢复按钮");
    restoreGlobals();
  });

  it("导出后弹成功 toast，带文件数", () => {
    const els = installDom();
    const toasts = [];
    createPrintPanel({
      getState: readyState,
      exportModelSTL: () => [
        { name: "a", filename: "a.stl", buffer: new ArrayBuffer(8) },
        { name: "b", filename: "b.stl", buffer: new ArrayBuffer(8) },
        { name: "c", filename: "c.stl", buffer: new ArrayBuffer(8) },
      ],
      triggerDownload: () => {},
      showToast: (m, t) => toasts.push([m, t]),
    });
    els["print-stl-btn"].click();
    flushTimers();
    assert(toasts.length === 1 && /已导出 3 个 STL/.test(toasts[0][0]), "成功 toast 报文件数");
    assert(toasts[0][1] === "success", "成功 toast 用 success 类型");
    restoreGlobals();
  });

  it("导出返回空数组（部件全无效）→ 不下载、报错误", () => {
    const els = installDom();
    const downloads = [];
    const toasts = [];
    createPrintPanel({
      getState: readyState,
      exportModelSTL: () => [],
      triggerDownload: (b, n) => downloads.push(n),
      showToast: (m, t) => toasts.push([m, t]),
    });
    els["print-stl-btn"].click();
    assert(downloads.length === 0, "空结果不触发任何下载");
    assert(toasts.some(t => /没有可导出/.test(t[0])), "空结果给错误提示");
    assert(els["print-stl-btn"].disabled === false, "按钮恢复（否则永远点不动）");
    restoreGlobals();
  });

  it("导出抛错 → 按钮恢复 + 错误 toast", () => {
    const els = installDom();
    const toasts = [];
    createPrintPanel({
      getState: readyState,
      exportModelSTL: () => { throw new Error("STL 炸了"); },
      triggerDownload: () => {},
      showToast: (m, t) => toasts.push([m, t]),
    });
    els["print-stl-btn"].click();
    assert(els["print-stl-btn"].disabled === false, "异常路径也恢复按钮");
    assert(toasts.some(t => /STL 炸了/.test(t[0])), "异常信息弹出来");
    restoreGlobals();
  });

  it("自定义模型的部件同样导出", () => {
    const els = installDom();
    const seen = [];
    createPrintPanel({
      getState: () => ({ hasCustomModel: true, parts: [], customModelParts: [part("自定义件", 0)] }),
      exportModelSTL: parts => {
        seen.push(parts);
        return [{ name: "x", filename: "x.stl", buffer: new ArrayBuffer(8) }];
      },
      triggerDownload: () => {},
    });
    els["print-stl-btn"].click();
    assert(seen.length === 1 && seen[0][0].name === "自定义件", "导出跟随 customModelParts");
    restoreGlobals();
  });

  it("toast 未注入时退化成 console，不上抛", () => {
    const els = installDom();
    let threw = null;
    let logs = [];
    try {
      logs = silenceConsole(() => {
        createPrintPanel({
          getState: readyState,
          exportModelSTL: () => [],
          triggerDownload: () => {},
        });
        els["print-stl-btn"].click();
      });
    } catch (e) {
      threw = e;
    }
    assert(threw === null, "缺 toast 注入时不上抛");
    assert(logs.some(l => /\[print\]/.test(l)), "缺 toast 注入时打 console");
    restoreGlobals();
  });
});

describe("DOM 缺失时静默降级", () => {
  it("结果框不存在时不崩", () => {
    installDom();
    delete globalThis.document.getElementById;
    const doc = globalThis.document;
    doc.getElementById = id => (id === "print-result" ? null : makeEl(id, "button"));
    let threw = null;
    try {
      createPrintPanel({
        getState: () => ({ hasCustomModel: false, parts: [part("a", 0)], customModelParts: [] }),
        analyze: () => makeAnalysis(),
        showToast: () => {},
      });
      globalThis.document.getElementById("print-check-btn").click();
    } catch (e) {
      threw = e;
    }
    assert(threw === null, "缺结果框不抛错");
    restoreGlobals();
  });
});

// ===== 运行 =====
for (const d of describeQueue) {
  console.log(`\n── ${d.name}`);
  d.fn();
}

console.log("\n" + "=".repeat(50));
console.log(`结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log("失败的用例:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("✅ 全部测试通过！");
