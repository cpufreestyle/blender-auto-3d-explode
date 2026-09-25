#!/usr/bin/env node
/**
 * 单元测试 — 渲染循环与视口响应（src/render-loop.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - resize：camera.aspect = innerWidth/innerHeight、camera.updateProjectionMatrix()、
 *     renderer.setSize(innerWidth, innerHeight) 三步；刻意不碰 setPixelRatio
 *     （DPR 初值只在 createSceneSetup 里设一次）；
 *   - animate 自递归：每次被调用都重新注册下一帧；
 *   - 后台标签页（document.hidden）在 updateExplodedView 之前就 return：
 *     不跑爆炸视图更新、不转粒子、不 controls.update、不 render，但下一帧
 *     已经注册上（浏览器自己会节流，这里再兜一层）；
 *   - 前台顺序：updateExplodedView(now) → 粒子旋转 → controls.update() →
 *     renderer.render(scene, camera)；
 *   - 粒子仅在 particlesMesh 存在且 visible 时旋转，系数 rotation.y = now *
 *     0.00005、rotation.x = now * 0.00003；
 *   - 进厂即注册首帧。
 *
 * 用法：node tests/render-loop-test.mjs
 */

import { createRenderLoop } from "../src/render-loop.js";

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

// ===== 假 three / 假 DOM =====
// window / document / requestAnimationFrame 三个全局在 Node 不存在，
// 按仓库既有约定用 Object.defineProperty 装到 globalThis 上，跑完还原。
const REAL_RAF = globalThis.requestAnimationFrame;
const HAD_WINDOW = "window" in globalThis;
const HAD_DOCUMENT = "document" in globalThis;
const savedWindow = globalThis.window;
const savedDocument = globalThis.document;

function installGlobals({ width, height, hidden, onFrame }) {
  const winListeners = {};
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: width,
      innerHeight: height,
      addEventListener: (type, fn) => {
        winListeners[type] = fn;
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { hidden },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: fn => {
      onFrame(fn);
      return onFrame.count++;
    },
  });
  return { winListeners };
}

function restoreGlobals() {
  if (HAD_WINDOW) Object.defineProperty(globalThis, "window", { configurable: true, value: savedWindow });
  else delete globalThis.window;
  if (HAD_DOCUMENT) Object.defineProperty(globalThis, "document", { configurable: true, value: savedDocument });
  else delete globalThis.document;
  if (REAL_RAF === undefined) delete globalThis.requestAnimationFrame;
  else Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: REAL_RAF });
}

function makeWorld({ width = 1280, height = 800, hidden = false, hasParticles = true, particlesVisible = true } = {}) {
  const log = [];
  const camera = {
    aspect: 1,
    updateProjectionMatrix: () => log.push("camera.updateProjectionMatrix"),
  };
  const renderer = {
    setSize: (w, h) => log.push(`renderer.setSize(${w},${h})`),
    setPixelRatio: r => log.push(`renderer.setPixelRatio(${r})`),
    render: (s, c) => log.push(`renderer.render(${s === scene},${c === camera})`),
  };
  const scene = { tag: "scene" };
  const controls = { update: () => log.push("controls.update") };
  const explodeCtl = { updateExplodedView: now => log.push(`updateExplodedView(${now})`) };
  const particlesMesh = hasParticles ?
    { visible: particlesVisible, rotation: { x: 0, y: 0 } } :
    null;
  const frames = [];
  const g = installGlobals({ width, height, hidden, onFrame: fn => frames.push(fn) });
  const world = {
    camera,
    renderer,
    scene,
    controls,
    explodeCtl,
    particlesMesh,
    log,
    frames,
    winListeners: g.winListeners,
  };
  // renderer.render 需要引用 scene，故放这里补
  renderer.render = (s, c) => log.push(`renderer.render(${s === scene},${c === camera})`);
  return world;
}

function boot(w) {
  createRenderLoop({
    camera: w.camera,
    renderer: w.renderer,
    scene: w.scene,
    controls: w.controls,
    explodeCtl: w.explodeCtl,
    particlesMesh: w.particlesMesh,
  });
}

describe("视口响应", async() => {
  await it("resize：aspect + updateProjectionMatrix + setSize", async() => {
    const w = makeWorld({ width: 1600, height: 900 });
    boot(w);
    w.winListeners.resize();
    assert(Math.abs(w.camera.aspect - 1600 / 900) < 1e-9, `aspect=1600/900（实际 ${w.camera.aspect}）`);
    assert(w.log.includes("camera.updateProjectionMatrix"), "updateProjectionMatrix 被调");
    const sized = w.log.find(l => l.startsWith("renderer.setSize"));
    assert(w.log.includes("renderer.setSize(1600,900)"), `setSize(1600,900)（实际 ${sized}）`);
  });

  await it("resize 不重设 pixelRatio", async() => {
    const w = makeWorld();
    boot(w);
    w.log.length = 0;
    w.winListeners.resize();
    assert(
      !w.log.some(l => l.startsWith("renderer.setPixelRatio")),
      "DPR 初值只在 createSceneSetup 里设一次，resize 不碰",
    );
  });

  await it("resize 读的是调用瞬间的窗口尺寸", async() => {
    const w = makeWorld({ width: 800, height: 600 });
    boot(w);
    w.winListeners.resize();
    const first = w.camera.aspect;
    assert(Math.abs(first - 800 / 600) < 1e-9, `第一次按 800/600（实际 ${first}）`);
    // 改窗口尺寸后再触发一次：aspect 必须跟着变，不能缓存初次值
    globalThis.window.innerWidth = 1024;
    globalThis.window.innerHeight = 512;
    w.winListeners.resize();
    assert(Math.abs(w.camera.aspect - 1024 / 512) < 1e-9, `第二次按 1024/512（实际 ${w.camera.aspect}）`);
    assert(w.log.filter(l => l === "renderer.setSize(1024,512)").length === 1, "setSize 也按新尺寸");
  });
});

describe("渲染循环", async() => {
  await it("进厂即注册首帧", async() => {
    const w = makeWorld();
    boot(w);
    assert(w.frames.length === 1, `构造后注册 1 帧（实际 ${w.frames.length}）`);
  });

  await it("animate 自递归：每次再注册一帧", async() => {
    const w = makeWorld();
    boot(w);
    w.frames[0](16);
    assert(w.frames.length === 2, `回调内又注册一帧（实际 ${w.frames.length}）`);
    w.frames[1](32);
    assert(w.frames.length === 3, "持续自递归");
  });

  await it("前台顺序：updateExplodedView → 粒子 → controls → render", async() => {
    const w = makeWorld({ width: 1280, height: 800 });
    boot(w);
    w.log.length = 0;
    w.frames[0](1000);
    assert(
      w.log.join(" | ") === "updateExplodedView(1000) | controls.update | renderer.render(true,true)",
      `顺序与内容（实际 ${w.log.join(" | ")}）`,
    );
  });

  await it("后台标签页：return 在 updateExplodedView 之前", async() => {
    const w = makeWorld({ hidden: true });
    boot(w);
    w.log.length = 0;
    w.frames[0](1000);
    assert(w.log.length === 0, `后台不做任何计算与渲染（实际 ${w.log.join(" | ") || "空"}）`);
    assert(w.frames.length === 2, "但下一帧已注册上（浏览器自行节流）");
    assert(
      !w.log.some(l => l.startsWith("updateExplodedView")),
      "updateExplodedView 未被调",
    );
  });

  await it("now 时间戳透传给 updateExplodedView", async() => {
    const w = makeWorld();
    boot(w);
    w.log.length = 0;
    w.frames[0](4242);
    assert(w.log.includes("updateExplodedView(4242)"), "透传 now=4242");
  });
});

describe("粒子动画", async() => {
  await it("可见时按 0.00005 / 0.00003 旋转", async() => {
    const w = makeWorld({ particlesVisible: true });
    boot(w);
    w.frames[0](100000);
    const ry = w.particlesMesh.rotation.y;
    const rx = w.particlesMesh.rotation.x;
    assert(Math.abs(ry - 100000 * 0.00005) < 1e-9, `rotation.y（实际 ${ry}）`);
    assert(Math.abs(rx - 100000 * 0.00003) < 1e-9, `rotation.x（实际 ${rx}）`);
  });

  await it("不可见时不旋转", async() => {
    const w = makeWorld({ particlesVisible: false });
    boot(w);
    w.frames[0](100000);
    assert(w.particlesMesh.rotation.y === 0 && w.particlesMesh.rotation.x === 0, "visible=false 不转");
  });

  await it("particlesMesh 为 null 时不抛错", async() => {
    const w = makeWorld({ hasParticles: false });
    let threw = null;
    try {
      boot(w);
      w.log.length = 0;
      w.frames[0](1000);
    } catch (e) {
      threw = e;
    }
    assert(threw === null, "低功耗模式下粒子不创建也不崩");
    assert(
      w.log.join(" | ") === "updateExplodedView(1000) | controls.update | renderer.render(true,true)",
      `其余步骤照跑（实际 ${w.log.join(" | ")}）`,
    );
  });
});

// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } finally {
    restoreGlobals();
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
