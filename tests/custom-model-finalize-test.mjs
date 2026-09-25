#!/usr/bin/env node
/**
 * 单元测试 — 自定义模型加载统一收尾（src/custom-model-finalize.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 收尾链路顺序：setState({hasCustomModel:true}) → questGroup 隐藏 /
 *     customModelGroup 显示 → 样式（默认开，可关）→ 动态步骤（五个键一次回落：
 *     stepGroups 取 generateCustomStepGroups 返回值同引用、totalSteps 取其长度、
 *     currentStep/displayedStep/animatingStep 归 0）→ UI（updateCustomModelUI 收
 *     部件长度与文件名、explodeCtl.updateStepUI）→ autoScaleModel(modelType) →
 *     fitCameraToModel(customModelGroup, false) → adjustSmartExplodeDistances
 *     （默认开，可关）→ maybeApplyAssemblySequence(fileName) → goToStep(0) +
 *     isExploded 回落 false + 爆炸按钮 class/文案复位；
 *   - 少点击自动播放：explodeLoop 为假时 clearTimeout 旧计时器并经 setTimeout
 *     排 500ms 自动 toggleExplode；回调触发时先把 autoExplodeTimer 回落 null，
 *     再按「触发时刻」的 isExploded / explodeLoop 现读决定是否播放；
 *   - explodeLoop 为真 → 不排计时器、不动 autoExplodeTimer；
 *   - customModelParts 惰性读取（换数组后 updateCustomModelUI 收新长度）。
 *
 * 用法：node tests/custom-model-finalize-test.mjs
 */

import { createCustomModelFinalizer } from "../src/custom-model-finalize.js";

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

// ===== 假协作环境 =====
// makeEnv 复刻 main.js 的桥接语义：getState 现读、setState 按键写回同一份 state。
function makeEnv(overrides = {}) {
  const state = {
    hasCustomModel: false,
    stepGroups: [{ name: "old" }],
    totalSteps: 1,
    currentStep: 1,
    displayedStep: 1,
    animatingStep: 1,
    isExploded: true,
    explodeLoop: false,
    autoExplodeTimer: "TIMER-OLD",
  };
  const calls = [];
  const newGroups = [{ name: "g0" }, { name: "g1" }, { name: "g2" }];
  let parts = [{ name: "p0" }, { name: "p1" }];

  const questGroup = { visible: true };
  const customModelGroup = { visible: false };
  const explodeBtn = {
    classes: ["exploded", "other"],
    textContent: "合体",
    classList: {
      remove: c => {
        explodeBtn.classes = explodeBtn.classes.filter(x => x !== c);
        calls.push(["classList.remove", c]);
      },
    },
  };

  const env = {
    state,
    calls,
    newGroups,
    questGroup,
    customModelGroup,
    explodeBtn,
    getParts: () => parts,
    setParts: p => {
      parts = p;
    },
    currentModelStyle: "native",
  };

  const scheduled = [];
  const deps = {
    getState: () => state,
    setState: patch => {
      Object.keys(patch).forEach(k => {
        if (!(k in state)) throw new Error(`未知桥接键: ${k}`);
        state[k] = patch[k];
      });
      calls.push(["setState", patch]);
    },
    getCustomModelParts: () => parts,
    customModelGroup,
    questGroup,
    explodeBtn,
    assembly: {
      generateCustomStepGroups: (p, fileName) => {
        calls.push(["generateCustomStepGroups", p === parts, fileName]);
        return newGroups;
      },
      maybeApplyAssemblySequence: fileName => {
        calls.push(["maybeApplyAssemblySequence", fileName]);
      },
    },
    customModelPanel: {
      updateCustomModelUI: (count, fileName) => {
        calls.push(["updateCustomModelUI", count, fileName]);
      },
    },
    explodeCtl: {
      updateStepUI: () => calls.push(["updateStepUI"]),
      goToStep: step => calls.push(["goToStep", step]),
      toggleExplode: () => calls.push(["toggleExplode"]),
    },
    modelFit: {
      autoScaleModel: modelType => calls.push(["autoScaleModel", modelType]),
      adjustSmartExplodeDistances: () => calls.push(["adjustSmartExplodeDistances"]),
    },
    fitCameraToModel: (group, smooth) => {
      calls.push(["fitCameraToModel", group === customModelGroup, smooth]);
    },
    applyModelStyle: style => {
      calls.push(["applyModelStyle", style]);
      env.currentModelStyle = style;
    },
    getCurrentModelStyle: () => env.currentModelStyle,
    ...overrides.deps,
  };

  // 计时器桩：setTimeout 只记录不真跑，返回句柄；clearTimeout 记录被清的句柄
  const REAL_SET = globalThis.setTimeout;
  const REAL_CLEAR = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    calls.push(["setTimeout", delay]);
    return `TIMER-${scheduled.length}`;
  };
  globalThis.clearTimeout = handle => {
    calls.push(["clearTimeout", handle]);
  };

  const finalizer = createCustomModelFinalizer(deps);
  env.run = (fileName, opts) => finalizer.finalizeCustomModelLoad(fileName, opts);
  env.scheduled = scheduled;
  env.restore = () => {
    globalThis.setTimeout = REAL_SET;
    globalThis.clearTimeout = REAL_CLEAR;
  };
  return env;
}

function callSeq(calls) {
  return calls.map(c => c[0]);
}

describe("finalizeCustomModelLoad 收尾链路", async() => {
  it("默认 opts：整链按序调用且五个步骤键一次回落", async() => {
    const env = makeEnv();
    try {
      env.run("model.glb");
      const seq = callSeq(env.calls);
      const order = [
        "setState",
        "applyModelStyle",
        "generateCustomStepGroups",
        "setState",
        "updateCustomModelUI",
        "updateStepUI",
        "autoScaleModel",
        "fitCameraToModel",
        "adjustSmartExplodeDistances",
        "maybeApplyAssemblySequence",
        "goToStep",
        "setState",
        "classList.remove",
        "clearTimeout",
        "setTimeout",
        "setState",
      ];
      assert(JSON.stringify(seq) === JSON.stringify(order), `调用顺序符合收尾链路（${seq.join(",")}）`);
      assert(env.state.hasCustomModel === true, "hasCustomModel 回落 true");
      assert(env.questGroup.visible === false, "questGroup 隐藏");
      assert(env.customModelGroup.visible === true, "customModelGroup 显示");
      const stepPatch = env.calls.find(c => c[0] === "setState" && "stepGroups" in c[1]);
      assert(
        stepPatch[1].stepGroups === env.newGroups &&
          stepPatch[1].totalSteps === 3 &&
          stepPatch[1].currentStep === 0 &&
          stepPatch[1].displayedStep === 0 &&
          stepPatch[1].animatingStep === 0,
        "stepGroups 取返回值同引用、totalSteps 取长度、三个步骤位归 0",
      );
      const ui = env.calls.find(c => c[0] === "updateCustomModelUI");
      assert(ui[1] === 2 && ui[2] === "model.glb", "updateCustomModelUI 收部件长度与文件名");
      const fit = env.calls.find(c => c[0] === "fitCameraToModel");
      assert(fit[1] === true && fit[2] === false, "fitCameraToModel(customModelGroup, false)");
      const auto = env.calls.find(c => c[0] === "autoScaleModel");
      assert(auto[1] === undefined, "modelType 缺省时透传 undefined");
      const asm = env.calls.find(c => c[0] === "maybeApplyAssemblySequence");
      assert(asm[1] === "model.glb", "maybeApplyAssemblySequence 收文件名");
      const go = env.calls.find(c => c[0] === "goToStep");
      assert(go[1] === 0, "goToStep(0) 回到合体");
      const explodedPatch = env.calls.find(c => c[0] === "setState" && "isExploded" in c[1]);
      assert(explodedPatch[1].isExploded === false, "isExploded 回落 false");
      assert(env.explodeBtn.classes.includes("exploded") === false, "爆炸按钮移除 exploded class");
      assert(env.explodeBtn.textContent === "💥 爆炸", "爆炸按钮文案复位");
    } finally {
      env.restore();
    }
  });

  it("totalSteps 跟随 generateCustomStepGroups 返回值长度（不写死）", async() => {
    const twoGroups = [{ name: "a" }, { name: "b" }];
    const env = makeEnv({
      deps: {
        assembly: {
          generateCustomStepGroups: () => twoGroups,
          maybeApplyAssemblySequence: () => {},
        },
      },
    });
    try {
      env.run("m.glb");
      const stepPatch = env.calls.find(c => c[0] === "setState" && "stepGroups" in c[1]);
      assert(stepPatch[1].stepGroups === twoGroups, "stepGroups 取返回值同引用");
      assert(stepPatch[1].totalSteps === 2, "totalSteps 跟随返回值长度（2 组）");
    } finally {
      env.restore();
    }
  });

  it("modelType 透传给 autoScaleModel", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb", { modelType: "ai-gen" });
      const auto = env.calls.find(c => c[0] === "autoScaleModel");
      assert(auto[1] === "ai-gen", "autoScaleModel 收到类型标签");
    } finally {
      env.restore();
    }
  });

  it("adjustExplode: false 时跳过智能爆炸距离", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb", { adjustExplode: false });
      assert(!env.calls.some(c => c[0] === "adjustSmartExplodeDistances"), "adjustSmartExplodeDistances 未被调用");
      assert(env.calls.some(c => c[0] === "autoScaleModel"), "autoScaleModel 仍被调用");
    } finally {
      env.restore();
    }
  });

  it("applyStyle: false 时跳过 applyModelStyle", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb", { applyStyle: false });
      assert(!env.calls.some(c => c[0] === "applyModelStyle"), "applyModelStyle 未被调用");
    } finally {
      env.restore();
    }
  });

  it("默认 applyStyle 为真且取当前样式", async() => {
    const env = makeEnv();
    try {
      env.currentModelStyle = "lego";
      env.run("m.glb");
      const s = env.calls.find(c => c[0] === "applyModelStyle");
      assert(s[1] === "lego", "applyModelStyle 收当前样式标签");
    } finally {
      env.restore();
    }
  });
});

describe("finalizeCustomModelLoad 少点击自动播放", async() => {
  it("explodeLoop 为假：清旧计时器并排 500ms 新计时器", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb");
      const clr = env.calls.find(c => c[0] === "clearTimeout");
      assert(clr[1] === "TIMER-OLD", "clearTimeout 收旧计时器句柄");
      const st = env.calls.find(c => c[0] === "setTimeout");
      assert(st[1] === 500, "setTimeout 延迟 500ms");
      assert(env.state.autoExplodeTimer === "TIMER-1", "autoExplodeTimer 回落新句柄");
    } finally {
      env.restore();
    }
  });

  it("回调触发：先回落 null，状态满足时 toggleExplode", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb");
      env.scheduled[0].fn();
      const nulls = env.calls.filter(c => c[0] === "setState" && c[1].autoExplodeTimer === null);
      assert(nulls.length >= 1, "回调先把 autoExplodeTimer 回落 null");
      assert(env.calls.some(c => c[0] === "toggleExplode"), "回调触发 toggleExplode");
    } finally {
      env.restore();
    }
  });

  it("回调触发时 isExploded 已翻真 → 不播放", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb");
      env.state.isExploded = true;
      env.scheduled[0].fn();
      assert(!env.calls.some(c => c[0] === "toggleExplode"), "已炸开时不重复播放");
    } finally {
      env.restore();
    }
  });

  it("回调触发前 explodeLoop 翻真 → 不播放", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb");
      env.state.explodeLoop = true;
      env.scheduled[0].fn();
      assert(!env.calls.some(c => c[0] === "toggleExplode"), "循环播放已开启时不打扰");
    } finally {
      env.restore();
    }
  });

  it("explodeLoop 为真：不排计时器也不动旧句柄", async() => {
    const env = makeEnv();
    try {
      env.state.explodeLoop = true;
      env.run("m.glb");
      assert(!env.calls.some(c => c[0] === "setTimeout"), "未排新计时器");
      assert(!env.calls.some(c => c[0] === "clearTimeout"), "未清旧计时器");
      assert(env.state.autoExplodeTimer === "TIMER-OLD", "旧句柄原样保留");
    } finally {
      env.restore();
    }
  });
});

describe("finalizeCustomModelLoad 惰性读取", async() => {
  it("customModelParts 换数组后 updateCustomModelUI 收新长度", async() => {
    const env = makeEnv();
    try {
      env.setParts([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]);
      env.run("m.glb");
      const ui = env.calls.find(c => c[0] === "updateCustomModelUI");
      assert(ui[1] === 4, "部件计数取调用时刻的最新数组");
    } finally {
      env.restore();
    }
  });

  it("generateCustomStepGroups 收到惰性读取的同一部件数组", async() => {
    const env = makeEnv();
    try {
      env.run("m.glb");
      const g = env.calls.find(c => c[0] === "generateCustomStepGroups");
      assert(g[1] === true, "传入的正是 getCustomModelParts() 现取的数组");
    } finally {
      env.restore();
    }
  });
});

// ===== 顺序执行（与仓库既有测试一致）=====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.error("❌ 存在失败用例:");
    failures.forEach(f => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
