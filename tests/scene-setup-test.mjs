#!/usr/bin/env node
/**
 * 单元测试 — 场景初始化（src/scene-setup.js，从 main.js 抽取）
 *
 * 抽取的不变量（均按原实现的字面量与顺序钉住）：
 *   - scene：背景色 0x0a0c12、雾 (0x0a0c12, 10, 40)；背景网格 y=-1.5、
 *     opacity 0.3、transparent，与粒子 mesh 均已 add 到 scene；
 *   - 粒子数：桌面 500（visible=true）、低功耗 150（visible=false），
 *     几何 position 属性 count = 粒子数；
 *   - 低功耗判定：navigator.maxTouchPoints > 0 或 UA 匹配移动端正则；
 *     低功耗下像素比夹到 1.5、关阴影、阴影类型 BasicShadowMap；
 *   - 桌面：fov 45 / aspect=innerWidth/innerHeight / near 0.1 / far 100 /
 *     位置 (4, 2.5, 5)；像素比 min(devicePixelRatio, 2)、开阴影、
 *     PCFSoftShadowMap、ACESFilmicToneMapping、曝光 1.1；
 *   - renderer.setSize(innerWidth, innerHeight)、domElement 挂到
 *     canvas-container；createRenderer 收到的正是原 options 对象；
 *   - webglcontextlost：preventDefault + showStatus(error 提示)；
 *     webglcontextrestored：showStatus(success 提示)；
 *   - controls：damping 开、factor 0.05、距离 2.5~15、autoRotate 开、
 *     速度 1.2、target (0, 0.15, 0)。
 *
 * 用法：node tests/scene-setup-test.mjs
 */

import { ACESFilmicToneMapping, BasicShadowMap, PCFSoftShadowMap, Vector3 } from "three";
import { createSceneSetup } from "../src/scene-setup.js";

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

// ===== 假 DOM / 假 navigator / 假 window =====
function makeCanvasEl() {
  const listeners = {};
  return {
    style: {},
    tagName: "CANVAS",
    ownerDocument: null,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: type => {
      delete listeners[type];
    },
    getRootNode: () => null,
    fire: (type, ev) => listeners[type] && listeners[type](ev || {}),
    has: type => typeof listeners[type] === "function",
    listeners,
  };
}

function setup(opts = {}) {
  const status = [];
  const sizeCalls = [];
  const ratioCalls = [];
  const domEl = makeCanvasEl();
  domEl.ownerDocument = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  domEl.getRootNode = () => domEl.ownerDocument;
  const renderer = {
    domElement: domEl,
    shadowMap: {},
    toneMapping: 0,
    toneMappingExposure: 0,
    setSize: (...args) => sizeCalls.push(args),
    setPixelRatio: (...args) => ratioCalls.push(args),
  };
  const optionsSeen = [];
  const createRenderer = o => {
    optionsSeen.push(o);
    return renderer;
  };
  const container = {
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      maxTouchPoints: opts.touch ? 2 : 0,
      userAgent: opts.mobileUA ? "Mozilla/5.0 (Linux; Android 14)" : "Mozilla/5.0 (node)",
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2 },
    configurable: true,
  });
  const doc = {
    getElementById: id => (id === "canvas-container" ? container : null),
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });

  const bag = createSceneSetup({
    showStatus: (msg, type) => status.push({ msg, type }),
    createRenderer,
  });
  return { bag, renderer, domEl, container, status, sizeCalls, ratioCalls, optionsSeen };
}

describe("scene 场景本体", async() => {
  await it("背景色与雾", async() => {
    const w = setup();
    assert(w.bag.scene.background.getHex() === 0x0a0c12, "背景色 0x0a0c12");
    assert(w.bag.scene.fog.color.getHex() === 0x0a0c12, "雾色 0x0a0c12");
    assert(w.bag.scene.fog.near === 10 && w.bag.scene.fog.far === 40, "雾范围 10~40");
  });

  await it("网格与粒子入场，网格参数", async() => {
    const w = setup();
    const kids = w.bag.scene.children;
    const grid = kids.find(k => k.type === "GridHelper");
    assert(!!grid, "场景含网格");
    assert(grid.position.y === -1.5, "网格 y=-1.5");
    assert(grid.material.opacity === 0.3 && grid.material.transparent === true, "网格半透明 0.3");
    assert(kids.some(k => k.type === "Points"), "场景含粒子");
  });
});

describe("低功耗模式", async() => {
  await it("桌面：500 粒子可见、阴影开、PCFSoft、DPR 夹 2", async() => {
    const w = setup();
    const pts = w.bag.scene.children.find(k => k.type === "Points");
    assert(pts.geometry.getAttribute("position").count === 500, "500 个粒子顶点");
    assert(w.bag.particlesMesh.visible === true, "桌面粒子可见");
    assert(w.bag.lowPowerMode === false, "非低功耗");
    assert(w.renderer.shadowMap.enabled === true, "阴影开");
    assert(w.renderer.shadowMap.type === PCFSoftShadowMap, "PCFSoftShadowMap");
    assert(
      w.renderer.toneMapping === ACESFilmicToneMapping && w.renderer.toneMappingExposure === 1.1,
      "ACES 色调映射 + 曝光 1.1",
    );
    assert(w.ratioCalls[0][0] === 2, "DPR=2 时像素比 2");
  });

  await it("触屏：150 粒子不可见、lowPowerMode、DPR 夹 1.5、关阴影", async() => {
    const w = setup({ touch: true });
    const pts = w.bag.scene.children.find(k => k.type === "Points");
    assert(pts.geometry.getAttribute("position").count === 150, "150 个粒子顶点");
    assert(w.bag.particlesMesh.visible === false, "低功耗粒子不画");
    assert(w.bag.lowPowerMode === true && w.bag.isMobile === false, "触屏即低功耗但不是 UA 移动端");
    assert(w.renderer.shadowMap.enabled === false, "低功耗关阴影");
    assert(w.renderer.shadowMap.type === BasicShadowMap, "BasicShadowMap");
    assert(w.ratioCalls[0][0] === 1.5, "触屏 DPR 夹 1.5");
  });

  await it("移动端 UA：isMobile 为真", async() => {
    const w = setup({ mobileUA: true });
    assert(w.bag.isMobile === true, "Android UA 命中");
    assert(w.bag.lowPowerMode === true, "移动端同样低功耗");
  });
});

describe("camera / renderer 接缝", async() => {
  await it("相机参数", async() => {
    const w = setup();
    assert(w.bag.camera.fov === 45, "fov 45");
    assert(w.bag.camera.aspect === 1920 / 1080, "aspect 按 innerWidth/innerHeight");
    assert(w.bag.camera.near === 0.1 && w.bag.camera.far === 100, "near 0.1 / far 100");
    // OrbitControls 构造会把位姿过一遍球坐标，浮点有 1e-15 级扰动，按容差断言
    const p = w.bag.camera.position;
    assert(
      Math.abs(p.x - 4) < 1e-9 && Math.abs(p.y - 2.5) < 1e-9 && Math.abs(p.z - 5) < 1e-9,
      "初始位姿 (4, 2.5, 5)",
    );
  });

  await it("renderer 尺寸/挂载/options 原样透传", async() => {
    const w = setup();
    assert(w.sizeCalls[0][0] === 1920 && w.sizeCalls[0][1] === 1080, "setSize(innerWidth, innerHeight)");
    assert(w.container.children[0] === w.domEl, "domElement 挂进 canvas-container");
    assert(
      w.optionsSeen[0].antialias === true &&
        w.optionsSeen[0].alpha === true &&
        w.optionsSeen[0].powerPreference === "high-performance",
      "createRenderer 收到的 options 逐字一致",
    );
  });
});

describe("WebGL 上下文事件", async() => {
  await it("lost：preventDefault + error 提示", async() => {
    const w = setup();
    assert(w.domEl.has("webglcontextlost"), "lost 监听已挂");
    let prevented = false;
    w.domEl.fire("webglcontextlost", { preventDefault: () => {
      prevented = true;
    } });
    assert(prevented, "preventDefault 已调");
    assert(
      w.status[0].msg === "⚠️ GPU 上下文丢失，正在尝试恢复..." && w.status[0].type === "error",
      "error 提示文案",
    );
  });

  await it("restored：success 提示", async() => {
    const w = setup();
    w.domEl.fire("webglcontextrestored");
    assert(
      w.status[0].msg === "✅ GPU 上下文已恢复" && w.status[0].type === "success",
      "success 提示文案",
    );
  });
});

describe("controls 轨道控制", async() => {
  await it("阻尼/距离/自旋/target", async() => {
    const w = setup();
    const c = w.bag.controls;
    assert(c.enableDamping === true && c.dampingFactor === 0.05, "阻尼开、factor 0.05");
    assert(c.minDistance === 2.5 && c.maxDistance === 15, "距离 2.5~15");
    assert(c.autoRotate === true && c.autoRotateSpeed === 1.2, "自旋开、速度 1.2");
    assert(c.target instanceof Vector3, "target 为 Vector3");
    assert(c.target.x === 0 && c.target.y === 0.15 && c.target.z === 0, "target (0, 0.15, 0)");
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
