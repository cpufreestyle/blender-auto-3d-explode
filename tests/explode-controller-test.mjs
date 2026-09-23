#!/usr/bin/env node
/**
 * 单元测试 — 步骤 / 爆炸动画控制器（src/explode-controller.js，从 main.js 抽取）
 *
 * 抽取的不变量（本次拆分全部风险都集中在状态归属上，因此逐类锁定）：
 *   - 创建契约：18 个 DOM 引用注入与全部事件绑定；对外返回六个方法；
 *   - 共享状态响应式桥接：s.* 读取走 getState()（惰性）、写入走 setState({ key })，
 *     且 patch 只含变动键 —— 这是原 main.js 十余处直接写 let 的等价替代；
 *   - goToStep 的 clamp、同 step / isAnimating 双早退、stopExplodeLoop 接管；
 *   - finishAnimation 经 updateExplodedView 的 isAnimating 分支落定；
 *   - toggleExplode 双向 + 按钮 class/text + 停掉时间轴播放、置 isAnimating=false；
 *   - 循环播放三态（合体开循环 / 炸开开循环 / 关闭）、循环反向 timer、
 *     速度档对 explodeAnimDuration / loopHoldMs 的缩放；
 *   - updateStepUI 全量文案与按钮 disabled、highlightPart 高亮迁移；
 *   - updateExplodedView 三分支：isAnimating（easeOutCubic）、explodeAnimActive
 *     （整体因子 + 落定 + 循环 timer）、脏标记跳过；explodeAllMode 同因子 vs
 *     分步 smoothStep 异因子；自定义模型部件经共享状态参与插值；
 *   - 深度滑块 / timeline 播放暂停重置 / focusCurrentPart 相机动画。
 *
 * 范围说明：mouseControlEnabled 在原 main.js 里就没有置 true 的入口（本次为等价
 * 搬迁，未改变这一点），测试覆盖其恒为 false 的默认路径；WebGL 渲染循环本身不
 * 在 Node 环境内执行，断言停在 updateExplodedView 的输入输出边界。
 *
 * 用法：node tests/explode-controller-test.mjs
 */

import { createExplodeController } from "../src/explode-controller.js";
import { easeOutCubic, smoothStep } from "../src/utils.js";
import { Color, Vector3 } from "three";

// ===== 测试框架（与 unit-test.mjs / ar-preview-test.mjs 一致）=====
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

// ===== 假浏览器世界 =====
// 控制器在 Node 里运行需要四类环境：DOM 元素、计时器、rAF 与受控时钟。
// 全部用可确定性驱动的替身替换，跑完在文件尾部还原。
const REAL_PERF = globalThis.performance;
const REAL_ST = globalThis.setTimeout;
const REAL_CT = globalThis.clearTimeout;
const REAL_SI = globalThis.setInterval;
const REAL_CI = globalThis.clearInterval;
const REAL_RAF = globalThis.requestAnimationFrame;
const REAL_CAF = globalThis.cancelAnimationFrame;

let fakeNow = 0;
const pendingTimers = []; // { id, fn, ms, interval? }
const pendingFrames = []; // rAF 回调队列

function installFakes() {
  fakeNow = 0;
  pendingTimers.length = 0;
  pendingFrames.length = 0;
  globalThis.performance = { now: () => fakeNow };
  globalThis.setTimeout = (fn, ms) => {
    const id = pendingTimers.length + 1;
    pendingTimers.push({ id, fn, ms });
    return id;
  };
  globalThis.clearTimeout = id => {
    const i = pendingTimers.findIndex(t => t.id === id);
    if (i >= 0) pendingTimers.splice(i, 1);
  };
  globalThis.setInterval = (fn, ms) => {
    const id = -(pendingTimers.length + 1);
    pendingTimers.push({ id, fn, ms, interval: true });
    return id;
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.requestAnimationFrame = fn => {
    pendingFrames.push(fn);
    return pendingFrames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
}

function restoreFakes() {
  globalThis.performance = REAL_PERF;
  globalThis.setTimeout = REAL_ST;
  globalThis.clearTimeout = REAL_CT;
  globalThis.setInterval = REAL_SI;
  globalThis.clearInterval = REAL_CI;
  globalThis.requestAnimationFrame = REAL_RAF;
  globalThis.cancelAnimationFrame = REAL_CAF;
}

function runAllTimers() {
  const due = pendingTimers.splice(0, pendingTimers.length);
  for (const t of due) t.fn();
}

// setInterval 在真实浏览器里反复触发；mock 只在 tick 时执行一次，
// 未撤销的 interval 在后续 tick 继续触发，撤销（回调内 clearInterval）后停止。
function tickIntervals(times) {
  for (let i = 0; i < times; i++) {
    const live = pendingTimers.filter(t => t.interval);
    if (live.length === 0) break;
    for (const t of live) t.fn();
  }
}

function runNextFrame(t) {
  const fn = pendingFrames.shift();
  if (fn) fn(t);
}

function makeEl(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id,
    textContent: "",
    innerHTML: "",
    disabled: false,
    value: "0",
    style: {},
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c);
        else classes.delete(c);
      },
      contains: c => classes.has(c),
    },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    has: type => Boolean(listeners[type]),
    fire: (type, ev) => {
      (listeners[type] || []).slice().forEach(fn => fn(ev || {}));
    },
  };
}

function makePart(name, stepIndex, pos) {
  return {
    name,
    stepIndex,
    mesh: {
      position: pos ? pos.clone() : new Vector3(),
      rotation: { x: 0, y: 0, z: 0 },
      scale: {
        x: 1, y: 1, z: 1,
        setScalar(v) { this.x = v; this.y = v; this.z = v; },
      },
      material: { emissive: new Color() },
    },
    homePos: new Vector3(0, 0, 0),
    explodePos: new Vector3(0, 10, 0),
    homeRot: { x: 0, y: 0, z: 0 },
    explodeRot: { x: 0, y: 0, z: 0 },
  };
}

function makeStore(overrides) {
  const state = {
    stepGroups: [
      { name: "打开后盖", description: "拧下四颗螺丝", parts: ["part-a"], tools: ["螺丝刀"] },
      { name: "取下电池", description: "断开电池排线", parts: ["part-b"], tools: [] },
      { name: "装机复原", description: "按逆序装回", parts: [], tools: ["撬棒", "镊子"] },
    ],
    totalSteps: 3,
    currentStep: 0,
    displayedStep: 0,
    animatingStep: 0,
    isExploded: false,
    explodeLoop: false,
    hasCustomModel: false,
    customModelParts: [],
    ...(overrides || {}),
  };
  const patches = [];
  return {
    state,
    patches,
    getState: () => state,
    setState(patch) {
      patches.push({ ...patch });
      Object.assign(state, patch);
    },
  };
}

const UI_IDS = [
  "explodeBtn",
  "timelineSlider",
  "toolsListEl",
  "prevBtn",
  "nextBtn",
  "resetBtn",
  "stepNumberEl",
  "stepNameEl",
  "stepDescEl",
  "progressFillEl",
  "depthSlider",
  "depthValueEl",
  "timelineStepEl",
  "timelinePlayBtn",
  "timelineResetBtn",
  "timelineSpeedSelect",
  "explodeLoopBtn",
  "explodeLoopSpeed",
];

function setup(overrides) {
  installFakes();
  const ui = {};
  for (const id of UI_IDS) ui[id] = makeEl(id);
  const store = makeStore(overrides && overrides.state);
  const parts = [
    makePart("part-a", 1, new Vector3(1, 2, 3)),
    makePart("part-b", 2, new Vector3(-1, 0, 0)),
  ];
  const camera = { position: new Vector3(0, 5, 10) };
  const controls = { target: new Vector3(0, 0, 0) };
  const renderer = { domElement: makeEl("canvas") };
  const axisMat = { opacity: 0 };
  const ctl = createExplodeController({
    camera,
    controls,
    renderer,
    parts,
    axisMat,
    ui,
    getState: store.getState,
    setState: store.setState,
  });
  return { ctl, ui, store, parts, camera, controls, renderer, axisMat };
}

// ===== 用例 =====
describe("创建契约与事件绑定", async() => {
  await it("全部控件事件绑定，对外返回六个方法", () => {
    const { ctl, ui, renderer } = setup();
    assert(ui.timelineSlider.has("input"), "timelineSlider 绑 input");
    assert(ui.timelinePlayBtn.has("click"), "timelinePlayBtn 绑 click");
    assert(ui.timelineResetBtn.has("click"), "timelineResetBtn 绑 click");
    assert(ui.prevBtn.has("click"), "prevBtn 绑 click");
    assert(ui.nextBtn.has("click"), "nextBtn 绑 click");
    assert(ui.resetBtn.has("click"), "resetBtn 绑 click");
    assert(ui.explodeBtn.has("click"), "explodeBtn 绑 click");
    assert(ui.explodeBtn.has("dblclick"), "explodeBtn 绑 dblclick");
    assert(ui.explodeLoopBtn.has("click"), "explodeLoopBtn 绑 click");
    assert(ui.explodeLoopSpeed.has("change"), "explodeLoopSpeed 绑 change");
    assert(ui.depthSlider.has("input"), "depthSlider 绑 input");
    assert(renderer.domElement.has("mousemove"), "画布绑 mousemove");
    const methods = [
      "updateStepUI", "goToStep", "toggleExplode",
      "focusCurrentPart", "updateExplodedView", "setStepUIHook",
    ];
    for (const m of methods) {
      assert(typeof ctl[m] === "function", `返回 ${m}`);
    }
  });
});

describe("goToStep / finishAnimation", async() => {
  await it("goToStep 双向 clamp 到 [0, totalSteps]", () => {
    const { ctl, store } = setup();
    ctl.goToStep(99);
    assert(store.state.animatingStep === 3, "上限 clamp 到 totalSteps=3");
    assert(store.patches.some(p => p.animatingStep === 3), "patch 写入 animatingStep=3");
    ctl.updateExplodedView(100000); // 落定动画
    assert(store.state.currentStep === 3 && store.state.displayedStep === 3, "finishAnimation 落定");
    ctl.goToStep(-5);
    assert(store.state.animatingStep === 0, "下限 clamp 到 0");
    assert(store.patches[store.patches.length - 1].animatingStep === 0, "最新 patch 是 animatingStep=0");
  });

  await it("同 step 与动画中都早退，不产生新 patch", () => {
    const { ctl, store } = setup();
    ctl.goToStep(0);
    assert(store.patches.length === 0, "displayedStep 已为 0 时直接早退");
    ctl.goToStep(1);
    const before = store.patches.length;
    ctl.goToStep(2); // isAnimating=true，早退
    assert(store.patches.length === before, "动画中不产生新 patch");
    assert(store.state.animatingStep === 1, "animatingStep 保持 1");
  });

  await it("分步动画中点按 easeOutCubic 插值，跑满后落定", () => {
    const { ctl, store } = setup();
    ctl.goToStep(2);
    fakeNow = 300;
    ctl.updateExplodedView(300);
    const mid = 0 + (2 - 0) * easeOutCubic(0.5);
    assert(Math.abs(store.state.currentStep - mid) < 1e-9, "中点 currentStep = from+(to-from)*easeOutCubic(0.5)");
    assert(store.state.displayedStep === 0, "未落定前 displayedStep 不变");
    ctl.updateExplodedView(600);
    assert(store.state.currentStep === 2 && store.state.displayedStep === 2, "跑满后落定到 animatingStep");
  });

  await it("goToStep 时 stopExplodeLoop 接管循环", () => {
    const { ctl, store, ui } = setup();
    ui.explodeLoopBtn.fire("click"); // 开循环并触发爆炸
    assert(store.state.explodeLoop === true, "循环开启");
    ctl.goToStep(1);
    assert(store.state.explodeLoop === false, "goToStep 关掉循环");
    assert(ui.explodeLoopBtn.classList.contains("active") === false, "循环按钮 active 移除");
    assert(ui.explodeLoopBtn.textContent === "🔁 循环", "循环按钮文本回退");
  });
});

describe("updateStepUI 与 highlightPart", async() => {
  await it("步骤号/名称/说明/工具/进度条/时间轴", () => {
    const { ctl, ui, store } = setup();
    store.state.displayedStep = 1;
    ctl.updateStepUI();
    assert(ui.stepNumberEl.textContent === "步骤 1 / 3", "步骤号文本");
    assert(ui.stepNameEl.textContent === "取下电池", "步骤名取自 stepGroups");
    assert(ui.stepDescEl.innerHTML === "断开电池排线", "说明写入 innerHTML");
    assert(ui.toolsListEl.innerHTML === "<div class=\"tools-none\">✅ 本步骤无需工具</div>", "无工具文案");
    assert(ui.progressFillEl.style.width === `${(1 / 3) * 100}%`, "进度条宽度按显示步占比");
    assert(ui.timelineSlider.value === 1, "时间轴滑块跟随");
    assert(ui.timelineStepEl.textContent === 1, "时间轴步号文案");
  });

  await it("有工具时渲染 tool-item 清单", () => {
    const { ctl, ui } = setup();
    ctl.updateStepUI(); // step 0 带螺丝刀
    assert(ui.toolsListEl.innerHTML === "<div class=\"tool-item\">螺丝刀</div>", "单工具渲染");
  });

  await it("displayedStep 越界时名称取最后一步，不崩", () => {
    const { ctl, ui, store } = setup();
    store.state.displayedStep = 7;
    ctl.updateStepUI();
    assert(ui.stepNameEl.textContent === "装机复原", "名称 clamp 到末步");
    assert(ui.stepNumberEl.textContent === "步骤 7 / 3", "步骤号仍显示原值");
  });

  await it("按钮 disabled：边界与动画中", () => {
    const { ctl, ui, store } = setup();
    store.state.displayedStep = 0;
    ctl.updateStepUI();
    assert(ui.prevBtn.disabled === true, "step 0 时 prev 禁用");
    assert(ui.nextBtn.disabled === false, "step 0 时 next 可用");
    assert(ui.resetBtn.disabled === false, "reset 可用");
    store.state.displayedStep = 3;
    ctl.updateStepUI();
    assert(ui.nextBtn.disabled === true, "step 3 时 next 禁用");
    const second = setup();
    second.ctl.goToStep(1);
    second.ctl.updateStepUI();
    assert(second.ui.prevBtn.disabled && second.ui.nextBtn.disabled && second.ui.resetBtn.disabled, "动画中三按钮全禁用");
  });

  await it("highlightPart 高亮当前步骤首部件，切换时迁移", () => {
    const { ctl, parts, store } = setup();
    ctl.updateStepUI();
    assert(parts[0].mesh.material.emissive.getHex() === 0x4a9eff, "part-a emissive 设高亮蓝");
    assert(parts[0].mesh.scale.x === 1.08, "part-a 放大 1.08");
    store.state.displayedStep = 1;
    ctl.updateStepUI();
    assert(parts[0].mesh.material.emissive.getHex() === 0, "旧高亮 emissive 归零");
    assert(parts[0].mesh.scale.x === 1, "旧高亮 scale 复原");
    assert(parts[1].mesh.material.emissive.getHex() === 0x4a9eff, "part-b 新高亮");
    store.state.displayedStep = 2; // 无 parts
    ctl.updateStepUI();
    assert(parts[1].mesh.material.emissive.getHex() === 0, "空 parts 步骤清除高亮");
  });

  await it("stepUIHook：未挂不触发，挂后每次 updateStepUI 触发", () => {
    const { ctl } = setup();
    ctl.updateStepUI();
    let hits = 0;
    ctl.setStepUIHook(() => { hits += 1; });
    ctl.updateStepUI();
    ctl.updateStepUI();
    assert(hits === 2, "hook 每次被调");
  });
});

describe("toggleExplode 一键爆炸/合体", async() => {
  await it("双向切换与按钮态，落定后轴线 opacity = factor*0.5", () => {
    const { ctl, ui, store, axisMat } = setup();
    ctl.toggleExplode();
    assert(store.state.isExploded === true, "isExploded 写 true");
    assert(ui.explodeBtn.classList.contains("exploded"), "按钮加 exploded class");
    assert(ui.explodeBtn.textContent === "🔄 合体", "按钮文本切合体");
    fakeNow = 550;
    ctl.updateExplodedView(550);
    assert(Math.abs(axisMat.opacity - easeOutCubic(0.5) * 0.5) < 1e-9, "中途 opacity 按 easeOutCubic(0.5) 缩放");
    ctl.updateExplodedView(1100);
    assert(Math.abs(axisMat.opacity - 0.5) < 1e-9, "落定 opacity=0.5");
    ctl.toggleExplode();
    assert(store.state.isExploded === false, "再点合体");
    assert(ui.explodeBtn.classList.contains("exploded") === false, "class 移除");
    assert(ui.explodeBtn.textContent === "💥 爆炸", "文本回爆炸");
  });

  await it("停掉时间轴播放并接管分步动画", () => {
    const { ctl, ui, store } = setup();
    ui.timelinePlayBtn.fire("click");
    assert(ui.timelinePlayBtn.textContent === "⏸️ 暂停", "播放中");
    ctl.goToStep(1);
    assert(store.state.animatingStep === 1, "分步动画进行中");
    ctl.toggleExplode();
    assert(ui.timelinePlayBtn.textContent === "▶️ 播放", "播放被停、文本复位");
    ctl.updateExplodedView(600);
    assert(store.state.currentStep === 0, "currentStep 不被分步动画改写（toggle 已接管）");
    assert(store.patches.every(p => p.animatingStep === undefined || p.animatingStep === 1), "animatingStep 停在 1");
  });
});

describe("爆炸循环播放", async() => {
  await it("合体状态开循环：立即炸开且按钮 active", () => {
    const { ui, store } = setup();
    ui.explodeLoopBtn.fire("click");
    assert(store.state.explodeLoop === true, "explodeLoop 写 true");
    assert(store.state.isExploded === true, "自动触发一次爆炸");
    assert(ui.explodeLoopBtn.classList.contains("active"), "按钮 active");
    assert(ui.explodeLoopBtn.textContent === "🔁 循环中", "按钮文本循环中");
  });

  await it("已炸开状态开循环：保持炸开态只更新按钮", () => {
    const { ctl, ui, store } = setup();
    ctl.toggleExplode(); // 先炸开
    ui.explodeLoopBtn.fire("click");
    assert(store.state.isExploded === true, "保持炸开");
    assert(store.state.explodeLoop === true, "循环开启");
    assert(ui.explodeLoopBtn.textContent === "🔁 循环中", "按钮循环中");
  });

  await it("关闭循环：停在当前状态、按钮回退", () => {
    const { ui, store } = setup();
    ui.explodeLoopBtn.fire("click"); // 开 + 炸开
    ui.explodeLoopBtn.fire("click"); // 关
    assert(store.state.explodeLoop === false, "explodeLoop 写 false");
    assert(store.state.isExploded === true, "停在炸开状态");
    assert(ui.explodeLoopBtn.classList.contains("active") === false, "active 移除");
    assert(ui.explodeLoopBtn.textContent === "🔁 循环", "文本回退");
  });

  await it("循环反向 timer：炸开落定并停留 loopHoldMs 后自动合体", () => {
    const { ctl, ui, store } = setup();
    ui.explodeLoopBtn.fire("click");
    ctl.updateExplodedView(1100); // 炸开动画落定
    assert(pendingTimers.length === 1 && pendingTimers[0].ms === 900, "按 loopHoldMs=900 排反向 timer");
    runAllTimers();
    assert(store.state.isExploded === false, "停留后自动切回合体");
    assert(ui.explodeBtn.textContent === "💥 爆炸", "按钮回爆炸");
  });

  await it("速度档 2x：动画时长与停留时间减半", () => {
    const { ctl, ui, store, axisMat } = setup();
    ui.explodeLoopSpeed.fire("change", { target: { value: "2" } });
    ctl.toggleExplode();
    ctl.updateExplodedView(549);
    assert(Math.abs(axisMat.opacity - 0.5) > 1e-9, "549ms（2x 档）尚未落定");
    ctl.updateExplodedView(550);
    assert(Math.abs(axisMat.opacity - 0.5) < 1e-9, "550ms（2x 档）落定");
    assert(pendingTimers.length === 0, "未开循环不排 timer");
    ui.explodeLoopBtn.fire("click"); // 已炸开态开循环（只更新按钮）
    ctl.toggleExplode(); // 手动合体再启动一次动画
    ctl.updateExplodedView(100000); // 落定
    assert(pendingTimers.length === 1 && pendingTimers[0].ms === 450, "停留时间 900/2=450");
    runAllTimers();
    assert(store.state.isExploded === true, "450ms 后反向回炸开");
  });
});

describe("updateExplodedView 三条插值路径", async() => {
  await it("脏标记：非动画时第二次调用直接跳过", () => {
    const { ctl, parts } = setup();
    ctl.updateExplodedView(1000);
    const snapshot = parts[0].mesh.position.clone();
    parts[0].homePos.set(50, 50, 50); // 换起点
    ctl.updateExplodedView(1000); // 脏标记已置 false，应跳过
    assert(parts[0].mesh.position.equals(snapshot), "脏标记 false 时跳过部件重算");
    ctl.goToStep(1); // 置脏
    ctl.updateExplodedView(1000); // 落定 currentStep=1
    assert(parts[0].mesh.position.equals(snapshot) === false, "goToStep 置脏后重新计算");
    assert(Math.abs(parts[0].mesh.position.y - 10) < 1e-9, "part-a 走到 explodePos");
  });

  await it("explodeAllMode：不同 stepIndex 的部件同因子位移", () => {
    const { ctl, parts } = setup();
    ctl.toggleExplode(); // explodeAllMode=true
    ctl.updateExplodedView(550);
    const f = easeOutCubic(0.5);
    assert(Math.abs(parts[0].mesh.position.y - 10 * f) < 1e-9, "part-a 用全局因子");
    assert(Math.abs(parts[1].mesh.position.y - 10 * f) < 1e-9, "part-b 同全局因子（忽略 stepIndex）");
    assert(Math.abs(parts[0].mesh.position.y - parts[1].mesh.position.y) < 1e-9, "两部件位移一致");
  });

  await it("分步模式：部件按自身 stepIndex 平滑过渡，轴线随 currentStep", () => {
    const { ctl, parts, store, axisMat } = setup();
    store.state.currentStep = 1.5;
    store.state.displayedStep = 2;
    ctl.updateExplodedView(10);
    const done = smoothStep(0, 1, 1.5);
    const half = smoothStep(1, 2, 1.5);
    assert(done === 1 && half === 0.5, "smoothStep 期望值");
    assert(Math.abs(parts[0].mesh.position.y - 10) < 1e-9, "part-a(stepIndex=1) 已完成");
    assert(Math.abs(parts[1].mesh.position.y - 10 * half) < 1e-9, "part-b(stepIndex=2) 走到一半");
    assert(Math.abs(axisMat.opacity - (1.5 / 3) * 0.5) < 1e-9, "轴线 opacity 随分步因子");
  });

  await it("自定义模型部件经共享状态参与插值，换数组后惰性读新引用", () => {
    const { ctl, store } = setup({
      state: { hasCustomModel: true, customModelParts: [makePart("c-1", 2)] },
    });
    const custom = store.state.customModelParts[0];
    store.state.currentStep = 2;
    store.state.displayedStep = 2;
    ctl.updateExplodedView(10);
    assert(Math.abs(custom.mesh.position.y - 10) < 1e-9, "自定义部件随分步炸开");
    // 换上新模型数组：控制器必须惰性读到新引用，而不是钉死旧数组
    const next = makePart("c-2", 2);
    store.state.customModelParts = [next];
    ctl.goToStep(0);
    ctl.updateExplodedView(100000); // 落定 currentStep=0
    assert(Math.abs(next.mesh.position.y) < 1e-9, "新数组部件被插值回位");
    assert(Math.abs(custom.mesh.position.y - 10) < 1e-9, "旧数组部件不再被动");
  });
});

describe("深度滑块", async() => {
  await it("拖到 50%：文案/状态/按钮/步骤同步", () => {
    const { ui, store } = setup();
    ui.depthSlider.fire("input", { target: { value: "50" } });
    assert(ui.depthValueEl.textContent === "50%", "深度文案");
    assert(store.state.isExploded === true, "isExploded 置 true");
    assert(ui.explodeBtn.classList.contains("exploded"), "按钮加 exploded");
    assert(ui.explodeBtn.textContent === "🔄 合体", "按钮切合体");
    assert(store.state.currentStep === 1.5, "currentStep = 0.5*totalSteps");
    assert(store.state.displayedStep === 2, "displayedStep 取整");
  });

  await it("拖回 0：退出爆炸态", () => {
    const { ui, store } = setup();
    ui.depthSlider.fire("input", { target: { value: "40" } });
    ui.depthSlider.fire("input", { target: { value: "0" } });
    assert(ui.depthValueEl.textContent === "0%", "深度文案归零");
    assert(store.state.isExploded === false, "isExploded 置 false");
    assert(ui.explodeBtn.textContent === "💥 爆炸", "按钮回爆炸");
  });

  await it("动画中拖动不抢写 currentStep", () => {
    const { ctl, ui, store } = setup();
    ctl.goToStep(1);
    ui.depthSlider.fire("input", { target: { value: "80" } });
    assert(ui.depthValueEl.textContent === "80%", "文案仍更新");
    assert(store.patches.every(p => p.currentStep === undefined), "动画中不写 currentStep");
    assert(store.state.isExploded === true, "深度状态仍切换");
  });
});

describe("时间轴播放控制", async() => {
  await it("播放/暂停：interval 注册与撤销", () => {
    const { ui } = setup();
    ui.timelinePlayBtn.fire("click");
    assert(ui.timelinePlayBtn.textContent === "⏸️ 暂停", "播放中");
    assert(pendingTimers.length === 1 && pendingTimers[0].interval === true, "注册 interval");
    ui.timelinePlayBtn.fire("click");
    assert(ui.timelinePlayBtn.textContent === "▶️ 播放", "暂停");
    assert(pendingTimers.length === 0, "interval 撤销");
  });

  await it("interval 回调推进一步；到末步自动停", () => {
    const { ui, store } = setup();
    ui.timelinePlayBtn.fire("click");
    tickIntervals(1);
    assert(store.state.animatingStep === 1, "interval 从 displayedStep+1 推进");
    assert(ui.timelinePlayBtn.textContent === "⏸️ 暂停", "未到末步继续播放");
    store.state.displayedStep = 3;
    tickIntervals(1);
    assert(ui.timelinePlayBtn.textContent === "▶️ 播放", "到末步自动停");
    assert(pendingTimers.length === 0, "interval 撤销");
  });

  await it("重置：播放中也归零", () => {
    const { ui, store } = setup();
    ui.timelinePlayBtn.fire("click");
    store.state.displayedStep = 2;
    ui.timelineResetBtn.fire("click");
    assert(ui.timelinePlayBtn.textContent === "▶️ 播放", "播放被重置停掉");
    assert(store.state.animatingStep === 0, "回到第 0 步");
  });

  await it("前后步按钮走 goToStep", () => {
    const { ctl, ui, store } = setup();
    store.state.displayedStep = 1;
    ui.nextBtn.fire("click");
    assert(store.state.animatingStep === 2, "next 推进一步");
    ctl.updateExplodedView(100000);
    store.state.displayedStep = 2;
    ui.prevBtn.fire("click");
    assert(store.state.animatingStep === 1, "prev 退后一步");
    ctl.updateExplodedView(100000);
    ui.resetBtn.fire("click");
    assert(store.state.animatingStep === 0, "reset 归零");
  });
});

describe("focusCurrentPart 相机动画", async() => {
  await it("空步骤或无匹配部件时安全返回", () => {
    const groups = [{ name: "空步骤", description: "", parts: [], tools: [] }];
    const { ctl } = setup({ state: { stepGroups: groups, totalSteps: 1 } });
    ctl.focusCurrentPart();
    assert(pendingFrames.length === 0, "无部件不排帧");
    const ghost = [{ name: "幽灵", description: "", parts: ["ghost"], tools: [] }];
    const second = setup({ state: { stepGroups: ghost, totalSteps: 1 } });
    second.ctl.focusCurrentPart();
    assert(pendingFrames.length === 0, "部件名不存在也不排帧");
  });

  await it("相机与 target 平滑移向当前步骤首部件", () => {
    const { ctl, camera, controls, parts } = setup();
    parts[0].mesh.position.set(1, 2, 3);
    ctl.focusCurrentPart();
    assert(pendingFrames.length === 1, "注册首帧");
    runNextFrame(0);
    assert(camera.position.distanceTo(new Vector3(0, 5, 10)) < 1e-9, "第 0 帧相机不动");
    runNextFrame(400);
    const eased = 1 - Math.pow(1 - 0.5, 3);
    const expectCam = new Vector3(0, 5, 10).lerp(new Vector3(3, 3.5, 5), eased);
    const expectTarget = new Vector3(0, 0, 0).lerp(new Vector3(1, 2, 3), eased);
    assert(camera.position.distanceTo(expectCam) < 1e-9, "中途相机 easeOutCubic 插值");
    assert(controls.target.distanceTo(expectTarget) < 1e-9, "target 跟随部件位置");
    assert(pendingFrames.length === 1, "未完再排帧");
    runNextFrame(800);
    assert(camera.position.distanceTo(new Vector3(3, 3.5, 5)) < 1e-9, "落定到目标点");
    assert(pendingFrames.length === 0, "完成不再排帧");
  });
});

describe("共享状态桥接不变量", async() => {
  await it("s.* 写立刻回写 store，读惰性取最新值", () => {
    const { ctl, ui, store } = setup();
    ctl.toggleExplode();
    assert(store.patches.some(p => "isExploded" in p), "写走 setState patch");
    assert(store.state.isExploded === true, "store 立即可见");
    store.state.totalSteps = 9; // 外部直接改（等价 main.js 里 let 赋值）
    ctl.updateStepUI();
    assert(ui.stepNumberEl.textContent === "步骤 0 / 9", "惰性读到新 totalSteps");
  });

  await it("patch 只含变动键", () => {
    const { ctl, store } = setup();
    ctl.goToStep(1);
    const last = store.patches[store.patches.length - 1];
    assert(Object.keys(last).length === 1 && "animatingStep" in last, "只写 animatingStep");
  });

  await it("goToStep 的 clamp 结果经 patch 可见", () => {
    const { ctl, store } = setup();
    ctl.goToStep(99);
    assert(store.patches.some(p => p.animatingStep === 3), "clamp 后的 animatingStep 出现在 patch");
  });
});

describe("鼠标控制默认路径", async() => {
  await it("mouseControlEnabled 恒 false：mousemove 空转", () => {
    const { renderer, store } = setup();
    renderer.domElement.fire("mousemove", { clientY: 50, clientX: 10 });
    assert(store.patches.length === 0, "无任何状态写入");
  });

  await it("dblclick：合体态无操作、炸开态保持按钮控制", () => {
    const { ctl, ui, store } = setup();
    ui.explodeBtn.fire("dblclick");
    assert(store.state.isExploded === false, "合体态 dblclick 不改状态");
    ctl.toggleExplode();
    ui.explodeBtn.fire("dblclick");
    assert(store.state.isExploded === true, "炸开态 dblclick 保持炸开");
    assert(ui.explodeBtn.textContent === "🔄 合体", "按钮文本不变");
  });
});

// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
  }
  restoreFakes();
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
