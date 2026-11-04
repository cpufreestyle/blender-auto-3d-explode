#!/usr/bin/env node
/**
 * 单元测试 — 导出与轻提示模块（src/export-panel.js，从 main.js 抽取）
 *
 * 抽取的不变量：六个职能逐个锁住「外部可见行为」，防止以后改模块时破坏 main.js
 * 原有的导出交互：
 *   - stripTags / fileTimestamp：纯函数，格式与 HTML 剥离规则
 *   - showToast：toast 容器懒创建、主题跟随 class、同屏上限 3 条
 *   - buildLessonMarkdown：教案内容契约（标题/步骤/部件/工具去重汇总/页脚来源）
 *   - exportScreenshot / exportLessonMarkdown / copyLessonMarkdown / exportGLB：
 *     成功与失败两条路径的下载文件名、Blob MIME、URL 回收时机、toast 文案
 *   - exportSplitManifest：部件级 JSON 清单。与 GLB 导出同套路——buildManifest
 *     经注入缝替换（Node 里跑不了真 three 几何），锁住的是接线而非清单内容
 *     （内容契约在 tests/split-manifest-test.mjs）
 *   - 建厂后状态变更仍生效：原 main.js 里这些值是模块级 let，抽取后经 getState()
 *     现取，这是本次重构最容易踩的坑，专门用一条用例钉住。
 *
 * GLTFExporter.parse 在 Node 里会卡在 FileReader/纹理路径上，因此成功/失败回调
 * 路径用注入的假 exporter 驱动，其余全部走真实模块代码。
 *
 * 用法：node tests/export-panel-test.mjs
 */

import { createExportPanel } from "../src/export-panel.js";

// ===== 测试框架（与 unit-test.mjs / ar-preview-test.mjs 一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
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

// ===== 假浏览器世界 =====
const REAL_NAVIGATOR = globalThis.navigator;
const REAL_DOCUMENT = globalThis.document;
const REAL_LOCATION = globalThis.location;
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_RAF = globalThis.requestAnimationFrame;

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    value: "",
    href: "",
    download: "",
    style: {},
    disabled: false,
    children: [],
    parent: null,
    listeners: {},
    classList: {
      set: new Set(),
      add(c) {
        this.set.add(c);
      },
      remove(c) {
        this.set.delete(c);
      },
      contains(c) {
        return this.set.has(c);
      },
    },
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    get firstElementChild() {
      return el.children[0] || null;
    },
    remove() {
      const p = el.parent;
      if (!p) return;
      const i = p.children.indexOf(el);
      if (i >= 0) p.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(ev, fn) {
      el.listeners[ev] = fn;
    },
    click() {
      if (el.listeners.click) el.listeners.click();
    },
    focus() {},
    select() {},
  };
  return el;
}

function installBrowser({
  state,
  withButtons = true,
  lightTheme = false,
  clipboardMode = "resolve", // resolve | reject | none
  glbOutcome = "ok", //         ok | error
  manifestOutcome = "ok", //    ok | error（buildManifest 抛错）
  manifestParts = null, //      非 null 时用它覆盖 state.parts
  manifestSkipped = 0, //       假清单里造出的跳过项数
  manifestUrl = null, //        假落盘端点返回的 url；null 时给一个默认值
  manifestApiError = null, //   非 null 时 manifestApi 抛错
  manifestApiOk = true, //        false 时返回 success:false
  stepUrl = null, //            步骤深链构造器；null 时教案不带链接（默认行为）
} = {}) {
  const calls = {
    toasts: [],
    renders: [],
    dataUrls: [],
    downloads: [],
    objectUrls: [],
    revokedUrls: [],
    clipboardWrites: [],
    execCommandCalls: 0,
    textareasCreated: 0,
    parseCalls: [],
    exporterBuilt: 0,
    appendedToBody: [],
    manifestBuilds: [],
    openedUrls: [],
    manifestApiCalls: [],
  };

  // ── 时间与动画回调：改为手动排空，避免测试里真等 2.2 秒的 toast 消失动画 ──
  const rafQueue = [];
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  globalThis.requestAnimationFrame = fn => {
    rafQueue.push(fn);
    return rafQueue.length;
  };

  // ── DOM ──
  let toastWrap = null;
  const body = makeEl("body");
  const bodyAppend = body.appendChild.bind(body);
  body.appendChild = child => {
    bodyAppend(child);
    if (child.id === "toast-wrap") toastWrap = child;
    calls.appendedToBody.push(child);
    return child;
  };

  const overlay = makeEl("div");
  overlay.className = lightTheme ? "ui-overlay light-theme" : "ui-overlay";
  const BUTTON_IDS = [
    "shot-btn",
    "export-md-btn",
    "copy-md-btn",
    "export-glb-btn",
    "export-manifest-btn",
    "replay-manifest-btn",
  ];
  const buttons = {};
  for (const id of BUTTON_IDS) buttons[id] = makeEl("button");

  const doc = {
    body,
    readyState: "complete",
    getElementById(id) {
      if (id === "toast-wrap") return toastWrap;
      if (!withButtons) return null;
      return buttons[id] || null;
    },
    querySelector(sel) {
      if (sel === ".ui-overlay.light-theme") return lightTheme ? overlay : null;
      return null;
    },
    createElement(tag) {
      const el = makeEl(tag);
      if (el.tagName === "A") {
        // triggerDownload 的顺序是 appendChild → click → remove，click 时 href/download 已就位
        const originalClick = el.click.bind(el);
        el.click = () => {
          calls.downloads.push({ href: el.href, filename: el.download });
          originalClick();
        };
      }
      if (el.tagName === "TEXTAREA") calls.textareasCreated++;
      return el;
    },
    addEventListener() {},
    execCommand() {
      calls.execCommandCalls++;
      return true;
    },
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });

  // ── 剪贴板 ──
  let nav = {};
  if (clipboardMode !== "none") {
    nav.clipboard = {
      writeText: async text => {
        calls.clipboardWrites.push(text);
        if (clipboardMode === "reject") throw new Error("denied");
      },
    };
  }
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });

  Object.defineProperty(globalThis, "location", {
    value: { origin: "http://localhost:3000" },
    configurable: true,
  });

  // 假 window.open：记录地址，不真开标签页
  globalThis.window = globalThis.window || {};
  globalThis.window.open = (url, target, feats) => {
    calls.openedUrls.push({ url, target, feats });
    return null;
  };

  URL.createObjectURL = blob => {
    const url = `blob:fake/${++urlSeq}`;
    calls.objectUrls.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = url => {
    calls.revokedUrls.push(url);
  };

  // ── three 侧依赖 ──
  const renderer = {
    domElement: {
      toDataURL: mime => {
        calls.dataUrls.push(mime);
        return "data:image/png;base64,QUJD";
      },
    },
    render(sc, cam) {
      calls.renders.push({ sc, cam });
    },
  };
  const scene = { __scene: true };
  const camera = { __camera: true };
  const questGroup = makeEl("group");
  const customModelGroup = makeEl("group");

  const FakeExporter = class {
    constructor() {
      calls.exporterBuilt++;
    }
    parse(target, onDone, onError, options) {
      calls.parseCalls.push({ target, options });
      if (glbOutcome === "error") onError(new Error("导出炸了"));
      else onDone(new ArrayBuffer(32));
    }
  };

  // 假 buildManifest：Node 里跑不了真 three 几何，记录入参并返回可断言的形状
  const fakeManifest = {
    version: 1,
    model: state.currentModelName,
    totalParts: 2 + manifestSkipped,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    parts: [
      { index: 0, name: "后盖", isOriginal: false, triangles: 12, volume: 1, surfaceArea: 6,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] }, size: [1, 1, 1], centroid: [0.5, 0.5, 0.5],
        explodePos: [1.5, 0.5, 0.5] },
      { index: 1, name: "电池", isOriginal: false, triangles: 12, volume: 1, surfaceArea: 6,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] }, size: [1, 1, 1], centroid: [0.5, 0.5, 0.5],
        explodePos: [1.5, 0.5, 0.5] },
    ],
    summary: { skipped: manifestSkipped, reasons: manifestSkipped > 0 ? ["x"] : [] },
  };
  const buildManifest = (parts, options) => {
    if (manifestOutcome === "error") throw new Error("清单炸了");
    calls.manifestBuilds.push({ parts, options });
    return fakeManifest;
  };
  // 需要「空部件」语义时覆盖 state.parts
  const effectiveState = manifestParts ? Object.assign({}, state, { parts: manifestParts }) : state;

  const panel = createExportPanel({
    renderer,
    scene,
    camera,
    questGroup,
    customModelGroup,
    getState: () => effectiveState,
    GLTFExporterClass: FakeExporter,
    buildManifest,
    manifestApi: async(manifest, name) => {
      if (manifestApiError) throw new Error(manifestApiError);
      calls.manifestApiCalls.push({ manifest, name });
      // manifestApiOk === false 时返回「服务端明确失败」——这与抛异常是
      // 两条不同路径（HTTP 200 + success:false vs 网络层错误），都要测。
      if (manifestApiOk === false) {
        return { success: false, error: "磁盘配额不足" };
      }
      return {
        success: true,
        url: manifestUrl || `/models/generated/${encodeURIComponent(name || "model")}-manifest-x.json`,
        fileName: "x.json",
        size: 128,
      };
    },
    buildStepUrl: stepUrl,
  });

  const world = {
    panel,
    calls,
    buttons,
    body,
    overlay,
    scene,
    camera,
    renderer,
    questGroup,
    customModelGroup,
    deps: { renderer, scene, camera, questGroup, customModelGroup },
    lastToast: () => (toastWrap ? toastWrap.children[toastWrap.children.length - 1] : null),
    toastCount: () => (toastWrap ? toastWrap.children.length : 0),
    toastWrapExists: () => toastWrap !== null,
    runRaf() {
      const all = rafQueue.splice(0);
      for (const fn of all) fn();
    },
    runTimers() {
      let guard = 0;
      while (timers.length && guard++ < 50) {
        const { fn } = timers.shift();
        fn();
      }
    },
  };
  return world;
}

let urlSeq = 0;

function restoreGlobals() {
  const restore = (name, value) => {
    if (value === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, { value, configurable: true });
  };
  restore("navigator", REAL_NAVIGATOR);
  restore("document", REAL_DOCUMENT);
  restore("location", REAL_LOCATION);
  restore("setTimeout", REAL_SET_TIMEOUT);
  restore("requestAnimationFrame", REAL_RAF);
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
}

async function flushMicrotasks() {
  // 假 setTimeout 已接管宏任务，这里只排空真实微任务队列（clipboard 的 Promise 链要靠它推进）
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// ===== 测试数据 =====
function makeState(overrides = {}) {
  return Object.assign(
    {
      currentModelName: "Meta Quest 3",
      totalSteps: 3,
      displayedStep: 1,
      hasCustomModel: false,
      customModelParts: [],
      parts: [{ name: "后盖" }, { name: "电池" }, { name: "主板" }],
      stepGroups: [
        {
          name: "第一步：<b>拆后盖</b>",
          description: "先关机。<br>再用撬棒沿缝隙缓慢撬开。",
          parts: ["后盖", "电池"],
          tools: ["撬棒", "<i>螺丝刀</i>"],
        },
        {
          name: "第二步：取电池",
          description: "",
          parts: [],
          tools: ["撬棒"],
        },
        {
          name: "第三步：检查",
          description: "",
          parts: ["主板"],
          tools: [],
        },
      ],
    },
    overrides,
  );
}

// ===== 用例 =====

describe("导出模块（src/export-panel.js）", async() => {
  await it("stripTags：<br> 转换行、剥标签、折叠空行、空值兜底", () => {
    const w = installBrowser({ state: makeState() });
    try {
      const s = w.panel.stripTags;
      assert(s("先关机。<br>再拆。") === "先关机。\n再拆。", "<br> 转为换行");
      assert(s("a<br/>b") === "a\nb", "<br/> 自闭合也转换行");
      assert(s("a<br />b") === "a\nb", "<br /> 带空格也转换行");
      assert(s("<b>加粗</b>") === "加粗", "剥掉行内标签");
      assert(s("  x  ") === "x", "首尾空白被 trim");
      assert(s("a\n\n\n\nb") === "a\n\nb", "3 个以上连续换行折叠成 2 个");
      assert(s(null) === "", "null → 空串");
      assert(s(undefined) === "", "undefined → 空串");
      assert(s("") === "", "空串 → 空串");
    } finally {
      restoreGlobals();
    }
  });

  await it("fileTimestamp：YYYYMMDD-HHMMSS", () => {
    const w = installBrowser({ state: makeState() });
    try {
      const ts = w.panel.fileTimestamp();
      assert(/^\d{8}-\d{6}$/.test(ts), `格式正确（${ts}）`);
      assert(ts.startsWith(new Date().toISOString().slice(0, 4)), "年份取自当前时间");
    } finally {
      restoreGlobals();
    }
  });

  await it("showToast：容器懒创建、class 拼接、rAF 加 show", () => {
    const w = installBrowser({ state: makeState() });
    try {
      assert(!w.toastWrapExists(), "初始没有 toast 容器");
      w.panel.showToast("已保存", "success");
      assert(w.toastWrapExists(), "首次调用才创建 #toast-wrap");
      assert(w.body.children.length === 1, "容器挂在 body 下");
      const t = w.lastToast();
      assert(t.className === "toast toast-success", `class 正确（${t.className}）`);
      assert(t.textContent === "已保存", "文案透传");
      assert(t.classList.contains("show") === false, "show 要等下一帧");
      w.runRaf();
      assert(t.classList.contains("show"), "requestAnimationFrame 回调加上 show");

      w.panel.showToast("第二条");
      assert(w.lastToast().className === "toast toast-info", "默认 type 是 info");

      // 重复调用复用同一容器
      w.panel.showToast("第三条");
      assert(w.body.children.filter(c => c.id === "toast-wrap").length === 1, "容器只建一次");
    } finally {
      restoreGlobals();
    }
  });

  await it("showToast：亮色主题下追加 toast-light", () => {
    const w = installBrowser({ state: makeState(), lightTheme: true });
    try {
      w.panel.showToast("hi", "info");
      assert(w.lastToast().className === "toast toast-info toast-light", "带 toast-light");
    } finally {
      restoreGlobals();
    }
  });

  await it("showToast：同屏最多保留 3 条", () => {
    const w = installBrowser({ state: makeState() });
    try {
      for (let i = 0; i < 6; i++) w.panel.showToast(`第 ${i} 条`);
      assert(w.toastCount() === 3, `6 条后剩 3 条（实际 ${w.toastCount()}）`);
      assert(w.lastToast().textContent === "第 5 条", "保留的是最新的 3 条");
    } finally {
      restoreGlobals();
    }
  });

  await it("buildLessonMarkdown：标题 / 概览 / 步骤 / 页脚来源", () => {
    const w = installBrowser({ state: makeState() });
    try {
      const md = w.panel.buildLessonMarkdown();
      const lines = md.split("\n");
      assert(md.startsWith("# Meta Quest 3 · 拆解教学教案"), "标题带模型名");
      assert(md.includes("> 导出时间："), "含导出时间");
      assert(md.includes("- 模型名称：Meta Quest 3"), "模型名");
      assert(md.includes("- 拆解步骤：3 步"), "步骤总数");
      assert(md.includes("- 部件总数：3"), "默认取 parts 数量");
      assert(md.includes("- 导出时进度：步骤 1 / 3"), "导出时进度");
      assert(md.includes("### 步骤 1：第一步：拆后盖"), "步骤标题里的 <b> 被剥掉");
      assert(md.includes("### 步骤 2：第二步：取电池"), "第二个步骤标题");
      assert(md.includes("### 步骤 3：第三步：检查"), "第三个步骤标题");
      assert(lines.includes("> 先关机。"), "描述按 <br> 拆行后变引用块");
      assert(lines.includes("> 再用撬棒沿缝隙缓慢撬开。"), "第二行描述也进引用块");
      assert(md.includes("- **涉及部件（2）**：后盖、电池"), "涉及部件列表");
      assert(md.includes("- **涉及部件（0）**：无（概览步骤）"), "无部件的步骤给占位文案");
      assert(md.includes("- **涉及部件（1）**：主板"), "第三步只涉及主板");
      assert(md.includes("- **所需工具**：撬棒、螺丝刀"), "工具里的 <i> 被剥掉");
      assert(md.includes("- **所需工具**：无需工具"), "空工具列表的占位文案");
      assert(md.includes("## 工具清单汇总"), "工具汇总段存在");
      const summary = md.slice(md.indexOf("## 工具清单汇总"));
      assert(summary.includes("- 撬棒"), "撬棒进汇总");
      assert(summary.includes("- 螺丝刀"), "螺丝刀进汇总");
      assert(Array.from(summary.matchAll(/- 撬棒\n/g)).length === 1, "撬棒跨步骤去重");
      assert(
        md.includes("_由 blender-auto-3d-explode 自动生成 · http://localhost:3000_"),
        "页脚标注生成器与来源 origin",
      );
    } finally {
      restoreGlobals();
    }
  });

  await it("buildLessonMarkdown：hasCustomModel 时改用 customModelParts", () => {
    const w = installBrowser({
      state: makeState({
        hasCustomModel: true,
        currentModelName: "机械臂",
        customModelParts: [{ name: "a" }, { name: "b" }],
      }),
    });
    try {
      const md = w.panel.buildLessonMarkdown();
      assert(md.includes("- 部件总数：2"), "取自 customModelParts 而非 parts");
      assert(md.startsWith("# 机械臂 · 拆解教学教案"), "标题用自定义模型名");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportScreenshot：同栈 render 后取像素并下载 PNG", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.exportScreenshot();
      assert(w.calls.renders.length === 1, "调用了一次 renderer.render");
      assert(w.calls.renders[0].sc === w.scene && w.calls.renders[0].cam === w.camera, "render 的是主场景与主相机");
      assert(w.calls.dataUrls[0] === "image/png", "toDataURL 取 PNG");
      assert(w.calls.downloads.length === 1, "触发了一次下载");
      assert(
        /^Meta Quest 3-拆解截图-\d{8}-\d{6}\.png$/.test(w.calls.downloads[0].filename),
        `文件名带模型名与时间戳（${w.calls.downloads[0].filename}）`,
      );
      assert(w.calls.downloads[0].href === "data:image/png;base64,QUJD", "下载的是画布 data URL");
      assert(w.lastToast().className === "toast toast-success", "成功 toast");
      assert(w.lastToast().textContent.includes("截图已保存"), "成功文案");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportScreenshot：render 抛错时只报错不下载", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.renderer.render = () => {
        throw new Error("WebGL context lost");
      };
      w.panel.exportScreenshot();
      assert(w.calls.downloads.length === 0, "没有下载动作");
      assert(w.lastToast().className === "toast toast-error", "error toast");
      assert(w.lastToast().textContent.includes("截图失败"), "文案含失败原因");
      assert(w.lastToast().textContent.includes("WebGL context lost"), "透传 err.message");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportLessonMarkdown：Blob/对象URL/2 秒后回收", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.exportLessonMarkdown();
      assert(w.calls.downloads.length === 1, "触发下载");
      assert(w.calls.downloads[0].filename === "Meta Quest 3-拆解教案.md", "教案文件名");
      const { blob } = w.calls.objectUrls[0];
      assert(blob instanceof Blob, "内容打成 Blob");
      assert(blob.type === "text/markdown;charset=utf-8", "MIME 带 charset");
      assert(w.calls.revokedUrls.length === 0, "回收是延时的，不是立即");
      assert(w.lastToast().textContent.includes("教案已导出"), "成功文案");
      w.runTimers();
      assert(w.calls.revokedUrls.length === 1, "定时到点后回收对象 URL");
    } finally {
      restoreGlobals();
    }
  });

  await it("copyLessonMarkdown：Clipboard API 可用时直接写剪贴板", async() => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.copyLessonMarkdown();
      await flushMicrotasks();
      assert(w.calls.clipboardWrites.length === 1, "走了 navigator.clipboard.writeText");
      assert(w.calls.clipboardWrites[0].startsWith("# Meta Quest 3 ·"), "复制的是教案全文");
      assert(w.calls.execCommandCalls === 0, "没有走 execCommand 兜底");
      assert(w.lastToast().textContent.includes("已复制到剪贴板"), "成功文案");
    } finally {
      restoreGlobals();
    }
  });

  await it("copyLessonMarkdown：Clipboard 拒绝时回退 execCommand", async() => {
    const w = installBrowser({ state: makeState(), clipboardMode: "reject" });
    try {
      w.panel.copyLessonMarkdown();
      await flushMicrotasks();
      assert(w.calls.clipboardWrites.length === 1, "仍然先尝试了 Clipboard API");
      assert(w.calls.textareasCreated === 1, "回退路径创建了隐藏 textarea");
      assert(w.calls.execCommandCalls === 1, "回退到 document.execCommand('copy')");
      assert(w.lastToast().textContent.includes("已复制到剪贴板"), "兜底成功也提示成功");
    } finally {
      restoreGlobals();
    }
  });

  await it("copyLessonMarkdown：无 clipboard 时直接走 textarea 兜底", async() => {
    const w = installBrowser({ state: makeState(), clipboardMode: "none" });
    try {
      w.panel.copyLessonMarkdown();
      await flushMicrotasks();
      assert(w.calls.clipboardWrites.length === 0, "没有尝试 Clipboard API");
      assert(w.calls.execCommandCalls === 1, "同样走 execCommand");
      assert(w.lastToast().textContent.includes("已复制到剪贴板"), "给出成功提示");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportGLB：空组直接报错，不构造 exporter", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.exportGLB();
      assert(w.calls.exporterBuilt === 0, "没有 new GLTFExporter");
      assert(w.calls.parseCalls.length === 0, "没有调用 parse");
      assert(w.calls.downloads.length === 0, "没有下载");
      assert(w.lastToast().className === "toast toast-error", "error toast");
      assert(w.lastToast().textContent.includes("当前没有可导出的模型"), "文案说明原因");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportGLB：默认模型走 questGroup，文件名含当前步骤", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.questGroup.children.push(makeEl("mesh"));
      w.panel.exportGLB();
      assert(w.calls.exporterBuilt === 1, "构造了一次 exporter");
      assert(w.calls.parseCalls.length === 1, "调用了一次 parse");
      assert(w.calls.parseCalls[0].target === w.questGroup, "默认导出 questGroup");
      assert(w.calls.parseCalls[0].options.binary === true, "二进制 GLB");
      assert(w.calls.downloads.length === 1, "触发下载");
      assert(
        /^Meta Quest 3-拆解步骤1-\d{8}-\d{6}\.glb$/.test(w.calls.downloads[0].filename),
        `文件名含模型名与步骤号（${w.calls.downloads[0].filename}）`,
      );
      assert(w.calls.objectUrls[0].blob.type === "model/gltf-binary", "Blob MIME 正确");
      assert(w.lastToast().textContent.includes("GLB 已导出"), "成功文案");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportGLB：自定义模型走 customModelGroup", () => {
    const w = installBrowser({
      state: makeState({ hasCustomModel: true, currentModelName: "机械臂", displayedStep: 2 }),
    });
    try {
      w.customModelGroup.children.push(makeEl("mesh"));
      w.panel.exportGLB();
      assert(w.calls.parseCalls[0].target === w.customModelGroup, "自定义模型走 customModelGroup");
      assert(
        w.calls.downloads[0].filename.startsWith("机械臂-拆解步骤2-"),
        `文件名用自定义模型名与步骤（${w.calls.downloads[0].filename}）`,
      );
    } finally {
      restoreGlobals();
    }
  });


  await it("exportSplitManifest：空部件直接报错，不构造清单", () => {
    const w = installBrowser({ state: makeState(), manifestParts: [] });
    try {
      w.panel.exportSplitManifest();
      assert(w.calls.manifestBuilds.length === 0, "没有调用 buildManifest");
      assert(w.calls.downloads.length === 0, "没有下载");
      assert(w.lastToast().className === "toast toast-error", "error toast");
      assert(w.lastToast().textContent.includes("当前没有可导出的部件"), "文案说明原因");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportSplitManifest：默认模型传 parts 与 camera，文件名带模型名", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.exportSplitManifest();
      assert(w.calls.manifestBuilds.length === 1, "构造了一次清单");
      const b = w.calls.manifestBuilds[0];
      assert(Array.isArray(b.parts) && b.parts.length === 3, "传入 parts 数组（默认模型 3 件）");
      assert(b.options.camera === w.camera, "传入 camera：explodePos 与屏幕同算法");
      assert(b.options.model === "Meta Quest 3", "model 名透传");
      assert(w.calls.downloads.length === 1, "触发下载");
      assert(
        /^Meta Quest 3-部件清单-\d{8}-\d{6}\.json$/.test(w.calls.downloads[0].filename),
        `文件名含模型名与时间戳（${w.calls.downloads[0].filename}）`,
      );
      assert(w.calls.objectUrls[0].blob.type === "application/json", "Blob MIME 是 JSON");
      assert(w.lastToast().className === "toast toast-success", "success toast");
      assert(w.lastToast().textContent.includes("2 个部件"), "文案报出部件数");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportSplitManifest：自定义模型走 customModelParts", () => {
    const w = installBrowser({
      state: makeState({ hasCustomModel: true, customModelParts: [{ name: "自定义件" }] }),
    });
    try {
      w.panel.exportSplitManifest();
      assert(w.calls.manifestBuilds.length === 1, "构造了一次清单");
      assert(w.calls.manifestBuilds[0].parts.length === 1, "取的是 customModelParts");
      assert(w.calls.manifestBuilds[0].parts[0].name === "自定义件", "内容正确");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportSplitManifest：有跳过项时 toast 降级为 info 并报出数量", () => {
    const w = installBrowser({ state: makeState(), manifestSkipped: 1 });
    try {
      w.panel.exportSplitManifest();
      assert(w.calls.downloads.length === 1, "仍然下载（跳过项不阻断）");
      assert(w.lastToast().className === "toast toast-info", "skipped>0 时降级为 info");
      assert(w.lastToast().textContent.includes("跳过 1 个异常项"), "报出跳过数量");
    } finally {
      restoreGlobals();
    }
  });


  await it("saveManifestAndReplay：空部件直接报错，不请求服务端", async() => {
    const w = installBrowser({ state: makeState(), manifestParts: [] });
    try {
      await w.panel.saveManifestAndReplay();
      assert(w.calls.manifestApiCalls.length === 0, "没有调用落盘端点");
      assert(w.calls.openedUrls.length === 0, "没有打开重放页");
      assert(w.calls.downloads.length === 0, "也没有回退下载");
      assert(w.lastToast().className === "toast toast-error", "error toast");
    } finally {
      restoreGlobals();
    }
  });

  await it("saveManifestAndReplay：成功时打开 replay.html 且 manifest 参数已编码", async() => {
    const w = installBrowser({
      state: makeState(),
      manifestUrl: "/models/generated/Quest 3-manifest-x.json",
    });
    try {
      await w.panel.saveManifestAndReplay();
      assert(w.calls.manifestApiCalls.length === 1, "调用了一次落盘端点");
      assert(w.calls.manifestApiCalls[0].name === "Meta Quest 3", "模型名透传给落盘端点");
      assert(w.calls.openedUrls.length === 1, "打开了一次重放页");
      const opened = w.calls.openedUrls[0];
      assert(opened.url.startsWith("replay.html?manifest="), "指向重放页（实测 " + opened.url + "）");
      assert(opened.url.includes("%2Fmodels%2Fgenerated%2F"), "url 参数已编码");
      assert(!opened.url.includes(" "), "打开的地址里不留裸空格");
      assert(opened.target === "_blank", "新标签页打开");
      assert(w.lastToast().textContent.includes("已打开重放页"), "成功文案");
      assert(w.calls.downloads.length === 0, "成功路径不触发下载");
    } finally {
      restoreGlobals();
    }
  });

  await it("saveManifestAndReplay：服务端返回 success:false 时回退下载", async() => {
    // 让假 api 返回失败：用 manifestUrl 指向空串，代码会抛「未返回可寻址地址」
    const w = installBrowser({ state: makeState(), manifestApiOk: false });
    try {
      await w.panel.saveManifestAndReplay();
      assert(w.calls.openedUrls.length === 0, "没有打开重放页");
      assert(w.calls.downloads.length === 1, "回退到下载");
      assert(w.calls.downloads[0].filename.endsWith(".json"), "下载的是 JSON");
      assert(w.lastToast().textContent.includes("已改为下载文件"), "告知用户降级了");
    } finally {
      restoreGlobals();
    }
  });

  await it("saveManifestAndReplay：网络异常时回退下载，不把异常抛给调用方", async() => {
    const w = installBrowser({ state: makeState(), manifestApiError: "connect ECONNREFUSED" });
    try {
      await w.panel.saveManifestAndReplay();
      assert(w.calls.openedUrls.length === 0, "没有打开重放页");
      assert(w.calls.downloads.length === 1, "回退到下载");
      assert(w.lastToast().textContent.includes("已改为下载文件"), "toast 说明降级");
    } finally {
      restoreGlobals();
    }
  });

  await it("saveManifestAndReplay：自定义模型走 customModelParts", async() => {
    const w = installBrowser({
      state: makeState({ hasCustomModel: true, customModelParts: [{ name: "自定义件" }] }),
    });
    try {
      await w.panel.saveManifestAndReplay();
      assert(w.calls.manifestApiCalls.length === 1, "调用了一次");
      assert(w.calls.manifestBuilds.length === 1, "构建了一次清单");
      assert(w.calls.manifestBuilds[0].parts.length === 1, "取的是 customModelParts");
    } finally {
      restoreGlobals();
    }
  });


  await it("exportSplitManifest：buildManifest 抛错时只报错不下载", () => {
    const w = installBrowser({ state: makeState(), manifestOutcome: "error" });
    try {
      w.panel.exportSplitManifest();
      assert(w.calls.downloads.length === 0, "没有下载");
      assert(w.calls.revokedUrls.length === 0, "也没有回收 URL");
      assert(w.lastToast().className === "toast toast-error", "error toast");
      assert(w.lastToast().textContent.includes("清单导出失败"), "文案说明是清单导出");
      assert(w.lastToast().textContent.includes("清单炸了"), "透出底层错误信息");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportSplitManifest：下载后回收 objectURL", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.exportSplitManifest();
      assert(w.calls.objectUrls.length === 1, "创建了一次 objectURL");
      w.runTimers();
      assert(w.calls.revokedUrls.length === 1, "2 秒后回收");
      assert(w.calls.revokedUrls[0] === w.calls.objectUrls[0].url, "回收的是同一个 URL");
    } finally {
      restoreGlobals();
    }
  });

  await it("exportGLB：parse 失败回调时只报错不下载", () => {
    const w = installBrowser({ state: makeState(), glbOutcome: "error" });
    try {
      w.questGroup.children.push(makeEl("mesh"));
      w.panel.exportGLB();
      assert(w.calls.downloads.length === 0, "失败不下载");
      assert(w.lastToast().className === "toast toast-error", "error toast");
      assert(w.lastToast().textContent.includes("GLB 导出失败"), "文案含失败");
      assert(w.lastToast().textContent.includes("导出炸了"), "透传 exporter 的错误信息");
    } finally {
      restoreGlobals();
    }
  });

  await it("建厂时绑定四个导出按钮（缺失的按钮静默跳过）", () => {
    const w = installBrowser({ state: makeState() });
    try {
      assert(typeof w.buttons["shot-btn"].listeners.click === "function", "截图按钮已绑定");
      assert(typeof w.buttons["export-md-btn"].listeners.click === "function", "导出教案按钮已绑定");
      assert(typeof w.buttons["copy-md-btn"].listeners.click === "function", "复制教案按钮已绑定");
      assert(typeof w.buttons["export-glb-btn"].listeners.click === "function", "导出 GLB 按钮已绑定");
      assert(typeof w.buttons["export-manifest-btn"].listeners.click === "function", "导出清单按钮已绑定");
    } finally {
      restoreGlobals();
    }

    const w2 = installBrowser({ state: makeState(), withButtons: false });
    try {
      // 没有按钮的页面（例如嵌入模式）不应抛错
      assert(w2.calls.exporterBuilt === 0, "建厂本身无副作用");
    } finally {
      restoreGlobals();
    }
  });

  await it("建厂后状态变更仍生效（不把 let 快照钉死）", () => {
    const state = makeState();
    const w = installBrowser({ state });
    try {
      w.questGroup.children.push(makeEl("mesh"));
      w.customModelGroup.children.push(makeEl("mesh"));
      state.currentModelName = "Another Model";
      state.displayedStep = 2;
      state.hasCustomModel = true;
      state.customModelParts = [{ name: "x" }, { name: "y" }];
      w.panel.exportScreenshot();
      w.panel.exportGLB();
      assert(
        w.calls.downloads[0].filename.startsWith("Another Model-拆解截图-"),
        `截图文件名读到新模型名（${w.calls.downloads[0].filename}）`,
      );
      assert(w.calls.parseCalls[0].target === w.customModelGroup, "GLB 走自定义模型组");
      assert(
        w.calls.downloads[1].filename.startsWith("Another Model-拆解步骤2-"),
        `GLB 文件名读到新步骤号（${w.calls.downloads[1].filename}）`,
      );
      const md = w.panel.buildLessonMarkdown();
      assert(md.includes("- 部件总数：2"), "教案也读到新 customModelParts");
    } finally {
      restoreGlobals();
    }
  });

  await it("buildLessonMarkdown：未注入深链构造器时不出现链接行", () => {
    const w = installBrowser({ state: makeState() });
    try {
      const md = w.panel.buildLessonMarkdown();
      assert(!md.includes("本步链接"), "默认不注入时不写链接，教案格式不变");
    } finally {
      restoreGlobals();
    }
  });

  await it("buildLessonMarkdown：注入后每一步都带一条可点深链", () => {
    const w = installBrowser({
      state: makeState(),
      stepUrl: step => "http://localhost:3000/#step=" + step,
    });
    try {
      const md = w.panel.buildLessonMarkdown();
      assert(md.includes("- **本步链接**：http://localhost:3000/#step=1"), "第 1 步链接");
      assert(md.includes("- **本步链接**：http://localhost:3000/#step=2"), "第 2 步链接");
      assert(md.includes("- **本步链接**：http://localhost:3000/#step=3"), "第 3 步链接");
      const count = Array.from(md.matchAll(/本步链接/g)).length;
      assert(count === 3, "三步各一条，实际 " + count);
    } finally {
      restoreGlobals();
    }
  });

  await it("copyStepLink：Clipboard API 可用时直接写链接", async() => {
    const w = installBrowser({ state: makeState(), stepUrl: step => "http://x/#step=" + step });
    try {
      w.panel.copyStepLink(4);
      await flushMicrotasks();
      assert(w.calls.clipboardWrites.length === 1, "写了 navigator.clipboard");
      assert(w.calls.clipboardWrites[0] === "http://x/#step=4", "写的是第 4 步的深链");
      assert(w.calls.textareasCreated === 0, "没有走 textarea 兜底");
      assert(w.lastToast().textContent.includes("第 4 步"), "toast 报出步号");
    } finally {
      restoreGlobals();
    }
  });

  await it("copyStepLink：Clipboard 被拒时回退 execCommand", async() => {
    const w = installBrowser({
      state: makeState(),
      clipboardMode: "reject",
      stepUrl: () => "http://x/#step=1",
    });
    try {
      w.panel.copyStepLink(1);
      await flushMicrotasks();
      assert(w.calls.clipboardWrites.length === 1, "仍然先尝试 Clipboard API");
      assert(w.calls.textareasCreated === 1, "回退创建隐藏 textarea");
      assert(w.calls.execCommandCalls === 1, "走了一次 execCommand");
      assert(w.lastToast().textContent.includes("第 1 步"), "兜底成功也报步号");
    } finally {
      restoreGlobals();
    }
  });

  await it("copyStepLink：拿不到链接时明确报错，不硬拼地址", () => {
    const w = installBrowser({ state: makeState() });
    try {
      w.panel.copyStepLink(2);
      assert(w.calls.clipboardWrites.length === 0, "没有写剪贴板");
      assert(w.calls.execCommandCalls === 0, "也没有走兜底复制");
      assert(w.lastToast().className === "toast toast-error", "error toast");
      assert(w.lastToast().textContent.includes("无法生成"), "文案说清是链接生成不了");
    } finally {
      restoreGlobals();
    }
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
