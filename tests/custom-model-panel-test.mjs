#!/usr/bin/env node
/**
 * 单元测试 — 自定义模型面板（src/custom-model-panel.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - updateCustomModelUI：部件计数、当前模型名（去扩展名经 setState 回落）、
 *     上传文件名展示、清除按钮显隐、时间轴总数与滑块范围、部件清单重建
 *     （圆点颜色取材质色、无材质回落 #888、dataset.part 同步）；
 *   - 缺失 DOM 元素一律静默跳过（逐个 if 守卫），不抛错；
 *   - clearCustomModel：先清旧模型；八个共享状态经 setState 回落且键在约定集；
 *     stepGroups 回落为 defaultStepGroups（同引用）、totalSteps 取其长度；
 *     part-count 复位 "15"；默认部件清单 HTML 复原；滑块 max/value 复位；
 *     清除按钮隐藏、上传状态清空、文件名清空；爆炸按钮 class 与文案复位；
 *     Quest 3 默认部件按 stepGroups 重排 stepIndex（未命中回落 totalSteps）；
 *     收尾 updateStepUI + fitCameraToModel(questGroup, false) + showStatus；
 *   - customModelParts 经 getCustomModelParts() 惰性读取（换数组后用新数组）。
 *
 * 用法：node tests/custom-model-panel-test.mjs
 */

import { createCustomModelPanel } from "../src/custom-model-panel.js";

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

// ===== 假 DOM =====
function makeEl(tag = "div") {
  let html = "";
  const el = {
    tagName: String(tag).toUpperCase(),
    textContent: "",
    className: "",
    value: "",
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
  // innerHTML 与 children 联动：赋 "" 即清空（真实 DOM 语义）
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set: v => {
      html = v;
      if (v === "") el.children.length = 0;
    },
  });
  return el;
}

function makeMaterial(hex) {
  return { color: { getHexString: () => hex } };
}

function makePartView(name, opts = {}) {
  return {
    name,
    mesh: opts.noMaterial ? {} : { material: opts.noColor ? {} : makeMaterial("ff0000") },
  };
}

const DEFAULT_GROUPS = [
  { name: "g0", parts: ["前面板"] },
  { name: "g1", parts: ["主机身", "头带"] },
];

function setup(opts = {}) {
  const els = {};
  const ids = [
    "part-count",
    "uploaded-file-name",
    "clear-model-btn",
    "timeline-total",
    "upload-status",
  ];
  for (const id of ids) els[id] = makeEl();
  els["part-count"].textContent = "15";
  const grid = makeEl();
  const panel = makeEl();
  const timelineSlider = makeEl();
  timelineSlider.max = "0";
  timelineSlider.value = "0";
  const explodeBtn = makeEl();
  explodeBtn.classList.add("exploded");
  explodeBtn.textContent = "💥 合体";

  const doc = {
    getElementById: id => (opts.withElements === false ? null : els[id] || null),
    querySelector: sel => {
      if (opts.withElements === false) return null;
      if (sel === ".panel") return panel;
      if (sel === ".parts-grid") return grid;
      return null;
    },
    createElement: tag => makeEl(tag),
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });

  const state = {
    hasCustomModel: true,
    currentModelName: "旧模型",
    stepGroups: [{ name: "旧步骤", parts: [] }],
    totalSteps: 7,
    currentStep: 3,
    displayedStep: 2,
    animatingStep: 3,
    isExploded: true,
    ...(opts.state || {}),
  };
  const patches = [];
  const store = {
    state,
    patches,
    getState: () => state,
    setState(patch) {
      patches.push({ ...patch });
      Object.assign(state, patch);
    },
  };

  let currentParts = opts.parts || [makePartView("Lens"), makePartView("Housing")];
  const calls = {
    partReads: 0,
    clearCustomModelGroup: 0,
    updateStepUI: 0,
    fitCameraToModel: [],
    showStatus: [],
  };

  const panelCtl = createCustomModelPanel({
    getState: store.getState,
    setState: store.setState,
    getCustomModelParts: () => {
      calls.partReads++;
      return currentParts;
    },
    questGroup: { visible: false },
    parts: opts.quest3Parts || [
      { mesh: { userData: { name: "前面板" } }, stepIndex: -1 },
      { mesh: { userData: { name: "主机身" } }, stepIndex: -1 },
      { mesh: { userData: { name: "透镜 x2" } }, stepIndex: -1 },
    ],
    timelineSlider,
    explodeBtn,
    defaultStepGroups: DEFAULT_GROUPS,
    clearCustomModelGroup: () => {
      calls.clearCustomModelGroup++;
    },
    updateStepUI: () => {
      calls.updateStepUI++;
    },
    fitCameraToModel: (group, smooth) => calls.fitCameraToModel.push({ group, smooth }),
    showStatus: (msg, type) => calls.showStatus.push({ msg, type }),
  });

  return { els, grid, panel, timelineSlider, explodeBtn, store, calls, panelCtl,
    setParts: p => { currentParts = p; } };
}

// ===== updateCustomModelUI =====
describe("updateCustomModelUI 同步面板", async() => {
  await it("计数 / 模型名 / 文件名 / 清除按钮 / 时间轴", async() => {
    const w = setup();
    w.panelCtl.updateCustomModelUI(42, "robot.glb");

    assert(w.els["part-count"].textContent === 42, "部件计数写入");
    assert(w.store.state.currentModelName === "robot", "模型名去扩展名经 setState 回落");
    assert(w.els["uploaded-file-name"].textContent === "当前模型：robot.glb", "文件名展示");
    assert(w.els["clear-model-btn"].style.display === "inline-block", "清除按钮显示");
    assert(w.els["timeline-total"].textContent === 7, "时间轴总数取 totalSteps");
    assert(w.timelineSlider.max === 7, "滑块范围取 totalSteps");
  });

  await it("fileName 为空时不改模型名", async() => {
    const w = setup({ state: { currentModelName: "保持" } });
    w.panelCtl.updateCustomModelUI(1, "");
    assert(w.store.state.currentModelName === "保持", "空文件名不改写模型名");
  });

  await it("部件清单重建：圆点颜色 / dataset / innerHTML", async() => {
    const w = setup({
      parts: [
        makePartView("Lens"),
        makePartView("Housing", { noMaterial: true }),
        makePartView("Board", { noColor: true }),
      ],
    });
    w.grid.innerHTML = "<div>陈旧</div>";
    w.panelCtl.updateCustomModelUI(3, "m.glb");

    assert(w.grid.innerHTML === "", "旧清单先清空");
    assert(w.grid.children.length === 3, "按部件数重建");
    assert(w.grid.children[0].dataset.part === "Lens", "dataset.part 同步");
    assert(w.grid.children[0].innerHTML.includes("background:#ff0000"), "圆点取材质色");
    assert(w.grid.children[1].innerHTML.includes("background:#888"), "无材质回落 #888");
    assert(w.grid.children[2].innerHTML.includes("background:#888"), "材质无色回落 #888");
    assert(w.grid.children[0].innerHTML.includes("Lens"), "清单含部件名");
  });

  await it("空部件不清空清单", async() => {
    const w = setup({ parts: [] });
    w.grid.innerHTML = "<div>保留</div>";
    w.panelCtl.updateCustomModelUI(0, "m.glb");
    assert(w.grid.innerHTML === "<div>保留</div>", "空部件不重建清单");
    assert(w.grid.children.length === 0, "未 append 新节点");
  });

  await it("惰性读取：换数组后用新数组", async() => {
    const w = setup({ parts: [makePartView("A")] });
    w.panelCtl.updateCustomModelUI(1, "m.glb");
    assert(w.grid.children.length === 1, "首次读旧数组");
    w.setParts([makePartView("A"), makePartView("B")]);
    w.panelCtl.updateCustomModelUI(2, "m.glb");
    assert(w.grid.children.length === 2, "换数组后按新数组重建");
    assert(w.calls.partReads === 2, "每次调用读一次");
  });

  await it("DOM 元素缺失时静默跳过", async() => {
    const w = setup({ withElements: false });
    w.panelCtl.updateCustomModelUI(3, "m.glb");
    assert(w.store.state.currentModelName === "m", "模型名仍回落（不依赖 DOM）");
    assert(true, "未抛错");
  });
});

// ===== clearCustomModel =====
describe("clearCustomModel 清除并恢复默认", async() => {
  await it("先清旧模型，八状态经一个 patch 回落", async() => {
    const w = setup();
    w.panelCtl.clearCustomModel();

    assert(w.calls.clearCustomModelGroup === 1, "先清旧模型");
    assert(w.store.patches.length === 1, "一个 setState patch");
    const keys = new Set(Object.keys(w.store.patches[0]));
    const allowed = new Set([
      "hasCustomModel",
      "currentModelName",
      "stepGroups",
      "totalSteps",
      "currentStep",
      "displayedStep",
      "animatingStep",
      "isExploded",
    ]);
    for (const k of keys) assert(allowed.has(k), `patch 键 ${k} 在约定集合内`);
    assert(w.store.state.hasCustomModel === false, "hasCustomModel 置假");
    assert(w.store.state.currentModelName === "Meta Quest 3", "模型名回默认");
    assert(w.store.state.stepGroups === DEFAULT_GROUPS, "stepGroups 回默认（同引用）");
    assert(w.store.state.totalSteps === DEFAULT_GROUPS.length, "totalSteps 取默认长度");
    assert(
      w.store.state.currentStep === 0 &&
        w.store.state.displayedStep === 0 &&
        w.store.state.animatingStep === 0,
      "步骤三态归零",
    );
    assert(w.store.state.isExploded === false, "爆炸状态复位");
  });

  await it("面板 DOM 复位", async() => {
    const w = setup();
    w.els["part-count"].textContent = "42";
    w.els["uploaded-file-name"].textContent = "当前模型：x";
    w.els["clear-model-btn"].style.display = "inline-block";
    w.els["timeline-total"].textContent = "99";
    w.timelineSlider.max = "99";
    w.timelineSlider.value = "3";
    w.els["upload-status"].textContent = "有内容";
    w.els["upload-status"].classList.remove("hidden");
    w.grid.innerHTML = "<div>自定义清单</div>";

    w.panelCtl.clearCustomModel();

    assert(w.els["part-count"].textContent === "15", "部件计数复位 15");
    assert(w.grid.innerHTML.includes("前面板") && w.grid.innerHTML.includes("头带"), "默认部件清单复原");
    assert(w.els["timeline-total"].textContent === DEFAULT_GROUPS.length, "时间轴总数复位");
    assert(w.timelineSlider.max === DEFAULT_GROUPS.length, "滑块范围复位");
    assert(w.timelineSlider.value === 0, "滑块值归零");
    assert(w.els["clear-model-btn"].style.display === "none", "清除按钮隐藏");
    assert(w.els["upload-status"].classList.has("hidden"), "上传状态隐藏");
    assert(w.els["upload-status"].textContent === "", "上传状态文案清空");
    assert(w.els["uploaded-file-name"].textContent === "", "文件名清空");
  });

  await it("爆炸按钮复位", async() => {
    const w = setup();
    w.explodeBtn.classList.add("exploded");
    w.explodeBtn.textContent = "💥 合体";
    w.panelCtl.clearCustomModel();
    assert(w.explodeBtn.classList.has("exploded") === false, "移除 exploded class");
    assert(w.explodeBtn.textContent === "💥 爆炸视图", "按钮文案复位");
  });

  await it("Quest 3 默认部件按 stepGroups 重排 stepIndex", async() => {
    const quest3Parts = [
      { mesh: { userData: { name: "前面板" } }, stepIndex: -1 },
      { mesh: { userData: { name: "主机身" } }, stepIndex: -1 },
      { mesh: { userData: { name: "透镜 x2" } }, stepIndex: -1 },
    ];
    const w = setup({ quest3Parts });
    w.panelCtl.clearCustomModel();
    assert(quest3Parts[0].stepIndex === 0, "命中 g0 → 索引 0");
    assert(quest3Parts[1].stepIndex === 1, "命中 g1 → 索引 1");
    assert(quest3Parts[2].stepIndex === DEFAULT_GROUPS.length, "未命中回落 totalSteps");
  });

  await it("收尾：刷新 UI、适配相机、轻提示", async() => {
    const w = setup();
    w.panelCtl.clearCustomModel();
    assert(w.calls.updateStepUI === 1, "刷新步骤 UI");
    assert(w.calls.fitCameraToModel.length === 1, "相机适配一次");
    assert(w.calls.fitCameraToModel[0].smooth === false, "非平滑适配");
    assert(w.calls.showStatus.length === 1, "一次轻提示");
    assert(
      w.calls.showStatus[0].msg === "已清除自定义模型，恢复默认" &&
        w.calls.showStatus[0].type === "info",
      "提示文案与类型",
    );
  });

  await it("DOM 元素缺失时静默跳过", async() => {
    const w = setup({ withElements: false });
    w.panelCtl.clearCustomModel();
    assert(w.store.state.hasCustomModel === false, "状态仍回落");
    assert(w.store.state.stepGroups === DEFAULT_GROUPS, "步骤仍回默认");
    assert(w.calls.updateStepUI === 1, "收尾照常执行");
    assert(true, "未抛错");
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
