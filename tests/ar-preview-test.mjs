#!/usr/bin/env node
/**
 * 单元测试 — WebXR AR 预览模块（src/ar-preview.js，从 main.js 抽取）
 *
 * 抽取的不变量：AR 逻辑逐行搬迁（唯一变化是整体缩进 +2 与状态改闭包），因此这里锁
 * 三类外部可见行为，防止以后改模块时破坏 main.js 原有的交互语义：
 *   - 无 navigator.xr 时静默降级：不碰按钮、不抛错
 *   - 支持时按钮显示并绑定 click；点击走 startAR
 *   - startAR 失败（requestSession 拒绝 / 渲染器起不来）时：alert 提示 +
 *     onAREnd 清理恢复主渲染画布、相机宽高比与按钮状态；会话簿记（session.end）不遗漏
 *
 * Node 环境没有 WebGL，成功路径（命中 hit-test、爆炸动画）依赖真实 XR 设备，
 * 不在单测范围内；失败与清理路径不碰 WebGLRenderer 构造之后的代码，可完整覆盖。
 *
 * 用法：node tests/ar-preview-test.mjs
 */

import { createARPreview } from "../src/ar-preview.js";

// ===== 测试框架（与 unit-test.mjs / provider-test.mjs 一致）=====
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
const REAL_WINDOW = globalThis.window;
const REAL_ALERT = globalThis.alert;

function installBrowser({ xrSupported, requestSession }) {
  const calls = { alert: [], sessionEnd: 0, appended: [] };
  const nav = {};
  if (xrSupported !== undefined) {
    nav.xr = { isSessionSupported: async() => xrSupported, requestSession };
  }
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });

  const button = {
    style: {},
    disabled: false,
    title: "",
    textContent: "",
    listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(ev, fn) {
      this.listeners[ev] = fn;
    },
  };
  const container = {
    innerHTML: "",
    appendChild(el) {
      calls.appended.push(el);
    },
  };
  const uiOverlay = { style: {} };
  const domElement = { __mainCanvas: true };
  const renderer = {
    domElement,
    setSize() {},
  };
  const camera = {
    aspect: 1,
    updateProjectionMatrix() {},
  };

  Object.defineProperty(globalThis, "document", {
    value: { getElementById: id => (id === "ar-btn" ? button : null), readyState: "complete" },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 },
    configurable: true,
  });
  Object.defineProperty(globalThis, "alert", {
    value: msg => calls.alert.push(String(msg)),
    configurable: true,
  });

  const deps = {
    container,
    uiOverlay,
    questGroup: { clone: () => ({ traverse() {} }) },
    parts: [],
    controls: { autoRotate: false },
    renderer,
    camera,
  };
  return { deps, button, container, calls, camera, renderer, domElement };
}

function restoreBrowser() {
  // 原本不存在的全局删掉还原；存在的恢复原值（Node 22 起 navigator 是只读 getter，必须走 defineProperty）
  const restore = (name, value) => {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, { value, configurable: true });
    }
  };
  restore("navigator", REAL_NAVIGATOR);
  restore("document", REAL_DOCUMENT);
  restore("window", REAL_WINDOW);
  restore("alert", REAL_ALERT);
}

// ===== 用例 =====

describe("AR 预览（src/ar-preview.js）", async() => {
  await it("无 navigator.xr 时静默降级：不碰按钮也不抛错", async() => {
    const world = installBrowser({});
    try {
      const ar = createARPreview(world.deps);
      await ar.initAR();
      assert(world.button.listeners.click === undefined, "未绑定 click");
      assert(world.button.style.display === undefined, "按钮显示状态未被改动");
      assert(world.calls.alert.length === 0, "没有弹窗");
    } finally {
      restoreBrowser();
    }
  });

  await it("xr 不可用时（isSessionSupported=false）同样不显示按钮", async() => {
    const world = installBrowser({ xrSupported: false });
    try {
      const ar = createARPreview(world.deps);
      await ar.initAR();
      assert(world.button.style.display === undefined, "按钮保持隐藏");
    } finally {
      restoreBrowser();
    }
  });

  await it("xr 可用时显示按钮并绑定 click", async() => {
    const world = installBrowser({ xrSupported: true, requestSession: async() => ({}) });
    try {
      const ar = createARPreview(world.deps);
      await ar.initAR();
      assert(world.button.style.display === "inline-block", "按钮显示");
      assert(world.button.disabled === false, "按钮可点");
      assert(world.button.title === "在 AR 中预览 Quest 3", "按钮 tooltip 正确");
      assert(typeof world.button.listeners.click === "function", "click 已绑定");
    } finally {
      restoreBrowser();
    }
  });

  await it("requestSession 拒绝时：alert 提示并恢复主渲染画布/相机/按钮", async() => {
    const world = installBrowser({
      xrSupported: true,
      requestSession: async() => {
        throw new Error("no camera permission");
      },
    });
    try {
      const ar = createARPreview(world.deps);
      await ar.initAR();
      world.button.listeners.click();
      // startAR 内部多处 await，给微任务队列排空的时间
      await new Promise(r => setTimeout(r, 20));
      assert(world.calls.alert.length === 1, "弹了一次失败提示");
      assert(world.calls.alert[0].includes("启动 AR 失败"), "提示内容说明是启动失败");
      assert(
        world.calls.appended.includes(world.domElement),
        "主渲染器画布重新挂回容器",
      );
      assert(world.deps.camera.aspect === 800 / 600, "相机宽高比已按窗口恢复");
      assert(world.button.textContent === "📱 AR 预览", "按钮文字复位");
      assert(world.deps.uiOverlay.style.display === "", "UI 浮层恢复显示（startAR 里被置 none，这里复位）");
    } finally {
      restoreBrowser();
    }
  });

  await it("会话建立后渲染器起不来：session.end() 仍被调用（收尾不遗漏）", async() => {
    const session = { end: () => {} };
    let endCalls = 0;
    session.end = () => {
      endCalls++;
    };
    const world = installBrowser({
      xrSupported: true,
      requestSession: async() => session,
    });
    try {
      const ar = createARPreview(world.deps);
      await ar.initAR();
      world.button.listeners.click();
      await new Promise(r => setTimeout(r, 20));
      assert(world.calls.alert.length === 1, "走了失败提示（Node 无 WebGL，渲染器构造必失败）");
      assert(endCalls === 1, "onAREnd 调用了 session.end()");
      assert(world.calls.appended.includes(world.domElement), "主画布已恢复");
      assert(world.button.textContent === "📱 AR 预览", "按钮文字复位");
    } finally {
      restoreBrowser();
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
