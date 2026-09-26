import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  TOUCH,
  WebGLRenderer,
} from "three";
import { createCameraFitter } from "./src/camera-fit.js";
import { createGLTFLoaderProvider } from "./src/gltf-loader.js";
import { createStatusUI } from "./src/status-ui.js";
import { createLighting } from "./src/lighting.js";
import { createExplodeController } from "./src/explode-controller.js";
import { createPartInteractions } from "./src/part-interactions.js";
import { createModelStyleSwitcher } from "./src/model-style.js";
import { createAssemblyAnalysis } from "./src/assembly-analysis.js";
import { createModelDisposal, disposeNodeTree } from "./src/model-disposal.js";
import { createModelFit } from "./src/model-fit.js";
import { createCustomModelFinalizer } from "./src/custom-model-finalize.js";
import { createCustomModelLoader } from "./src/custom-model-loader.js";
import { createCustomModelPanel } from "./src/custom-model-panel.js";
import { assignPartStepIndices, defaultStepGroups } from "./src/quest3-steps.js";
import { isQuest3Model, yieldToMain } from "./src/utils.js";
import { createARPreview } from "./src/ar-preview.js";
import { createExportPanel } from "./src/export-panel.js";
import { calculateExplodePos } from "./src/explode-geometry.js";
import { autoSplitModel, generatePartName } from "./src/geometry-split.js";
import { createQuest3Model } from "./src/quest3-model.js";
import { splitModelToQuest3Regions } from "./src/quest3-parts.js";
import { setupUpload } from "./src/upload-panel.js";
import { setupGeneratedLibrary } from "./src/generated-library.js";
import { setupKeyboardShortcuts } from "./src/keyboard-shortcuts.js";
import { createStepDescAnimation } from "./src/step-desc.js";
import { createRenderLoop } from "./src/render-loop.js";
import { createSceneSetup } from "./src/scene-setup.js";
import { setupThemeToggle } from "./src/theme-toggle.js";
import { setupStyleToggle } from "./src/style-toggle.js";
import { setupAIPaint } from "./src/panels/ai-paint-panel.js";
// 副作用导入：确保 config-panel.js 加载并初始化 Blender 健康检测/配置高亮（不依赖 ai-paint 面板是否启用）
import "./src/panels/config-panel.js";

// 实现迁至 src/gltf-loader.js：loadGLTFLoader 与惰性缓存整段搬迁，行为不变
const { loadGLTFLoader } = createGLTFLoaderProvider();

// 实现迁至 src/status-ui.js：showStatus / setModelLoading 与 MODEL_LOADING_BTN_IDS
// 整段搬迁，行为不变（状态条写 #upload-status；loading 覆盖层显隐 + 按钮统一切换）。
// 必须建在「场景初始化」之前：下方 WebGL 上下文丢失/恢复回调引用 showStatus。
const { showStatus, setModelLoading } = createStatusUI();

// ===== WebGL 支持检测 =====
try {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (!gl) throw new Error("浏览器不支持 WebGL");
} catch (err) {
  const el = document.getElementById("error");
  if (el) {
    el.classList.remove("hidden");
    el.textContent = err.message;
  }
  throw err;
}

// ===== 场景初始化 =====
// 实现迁至 src/scene-setup.js：container/scene/背景网格/环境粒子/camera/
// renderer/OrbitControls 与低功耗判定整段搬迁，行为不变。
// WebGLRenderer 需 GL 上下文，经 createRenderer 接缝注入（Node 测试用替身）；
// showStatus 来自 src/status-ui.js（WebGL 上下文丢失/恢复回调引用它）。
const { container, scene, camera, renderer, controls, particlesMesh, lowPowerMode, isMobile } =
  createSceneSetup({
    showStatus,
    createRenderer: opts => new WebGLRenderer(opts),
  });
// ============================================================
// 模块共享状态与引用
// 这些状态会被文件前部的函数（createPart / 装配分析 / 拆解动画…）引用，
// 必须在使用前声明：main.js 的历史事故就是「先用后声明」的 TDZ 崩溃
// （lowPowerMode，见 fix(frontend) dda6b5c）。集中声明在此，并由
// ESLint 的 no-use-before-define 持续守护该约定。
// ============================================================
const questGroup = new Group(); // Quest 3 默认模型组
const customModelGroup = new Group(); // 自定义模型组
let assemblySequenceOrder = null; // Blender MCP 返回的部件拆解顺序（索引小者先拆）
let stepGroups = defaultStepGroups; // 当前生效的拆解步骤方案
let totalSteps = stepGroups.length; // 步骤总数
let currentStep = 0; // 实际显示步骤（动画中）
let displayedStep = 0; // 当前 UI 显示的步骤（已完成）
let animatingStep = 0; // 动画目标步骤
let explodeLoop = false; // 爆炸/合体动画是否自动循环播放
let isExploded = false; // 是否已完全炸开
let autoExplodeTimer = null; // 「少点击」优化：完成拆解/生成后自动播一次爆炸动画

// 共享 DOM 引用（脚本以 module 形式置于 body 末尾，此时 DOM 已就绪）
const explodeBtn = document.getElementById("explode-btn");
const timelineSlider = document.getElementById("timeline-slider");
const toolsListEl = document.getElementById("tools-list");

// 步骤 / 爆炸控制相关的 DOM 元素（实现迁至 src/explode-controller.js）
const stepUi = {
  explodeBtn,
  timelineSlider,
  toolsListEl,
  prevBtn: document.getElementById("prev-step"),
  nextBtn: document.getElementById("next-step"),
  resetBtn: document.getElementById("reset-step"),
  stepNumberEl: document.getElementById("step-number"),
  stepNameEl: document.getElementById("step-name"),
  stepDescEl: document.getElementById("step-desc"),
  progressFillEl: document.getElementById("progress-fill"),
  autoRotateCheck: document.getElementById("auto-rotate"),
  depthSlider: document.getElementById("explode-depth"),
  depthValueEl: document.getElementById("depth-value"),
  timelineStepEl: document.getElementById("timeline-step"),
  timelinePlayBtn: document.getElementById("timeline-play"),
  timelineResetBtn: document.getElementById("timeline-reset"),
  timelineSpeedSelect: document.getElementById("timeline-speed"),
  explodeLoopBtn: document.getElementById("explode-loop"),
  explodeLoopSpeed: document.getElementById("explode-loop-speed"),
};
// 早声明、后赋值：finalizeCustomModelLoad 等前部函数要在运行时调用它，
// 而 createExplodeController 需要 axisMat（下方才创建）等依赖
let explodeCtl = null;
let partInteractions = null; // src/part-interactions.js 实例
let assembly = null; // 装配顺序对接 / 自定义步骤生成（src/assembly-analysis.js）
let modelDisposal = null; // 自定义模型拆卸与 GPU 资源释放（src/model-disposal.js）
let modelFit = null; // 模型加载后归一化（src/model-fit.js）
let customModelLoader = null; // 自定义模型加载主链路（src/custom-model-loader.js）
let customModelPanel = null; // 自定义模型面板 UI 同步与清除复位（src/custom-model-panel.js）
// 主模块另有两处直接使用（步骤描述淡入 / 自动旋转快捷键）
const { stepDescEl, autoRotateCheck } = stepUi;

// ===== 自动适配相机到模型 =====
// 实现迁至 src/camera-fit.js：fitCameraToModel 整段搬迁，行为不变（包围盒 →
// 距离夹取 → 缓动/直落两路 → 日志）。camera / controls 为稳定 const 引用，
// 工厂创建时传入；requestAnimationFrame 仍走全局。
const { fitCameraToModel } = createCameraFitter({ camera, controls });

// ===== 增强灯光系统 =====
// 实现迁至 src/lighting.js：五盏灯（环境光 / 主光 / 补光 / 轮廓光 /
// 底部反射光）的构造、position 布置与 lowPowerMode 分档参数整段搬迁，
// 行为不变。返回值未接收：原 main.js 也不持有这些引用（scene 遍历取用）。
createLighting({ scene, lowPowerMode });
// 材质与乐高外观系统已抽到 ./src/lego-materials.js（导出 materials / legoMaterials / getLegoMaterialForMesh 等）

// ===== 乐高 / 原生 外观切换（2026-07 新增）=====
// 乐高风格：亮色塑料质感、无金属、轻微自发光，营造积木玩具观感（不改几何体）
let currentModelStyle = "native"; // 'native' | 'lego'

// 应用模型外观风格：'native' | 'lego'
// 实现迁至 src/model-style.js：applyModelStyle 整段搬迁，行为不变（样式状态
// 经桥接读写，两个模型组深度遍历换材质，首次见到的 mesh 缓存原生材质）。
const { applyModelStyle } = createModelStyleSwitcher({
  questGroup,
  customModelGroup,
  getState: () => ({ currentModelStyle }),
  setState: patch => {
    if ("currentModelStyle" in patch) currentModelStyle = patch.currentModelStyle;
  },
});

// ===== Quest 3 简化模型构建 =====
// questGroup 声明见文件上方「模块共享状态与引用」
scene.add(questGroup);

const parts = []; // 存储所有可拆解部件

// 实现迁至 src/quest3-model.js：createPart / addCamLens 与十个默认部件的几何
// 构造整段搬迁，行为不变。questGroup / parts / lowPowerMode 均为稳定 const
// 引用直接传入（parts 只 push 不重赋值，无需桥接）。
createQuest3Model({ questGroup, parts, lowPowerMode });

// ===== 自定义模型处理 =====
// customModelGroup 声明见文件上方「模块共享状态与引用」
scene.add(customModelGroup);
let customModelParts = []; // 存储自定义模型的部件
let hasCustomModel = false;
// 当前展示的模型名（默认 Quest 3；上传/生成后替换），用于截图与教案导出命名
let currentModelName = "Meta Quest 3";

// ===== 自定义模型公共工具函数（提取重复逻辑）=====

// ===== 自定义模型公共工具函数（提取重复逻辑）=====
// 实现迁至 src/model-disposal.js：
//   - disposeSceneRecursively -> disposeNodeTree；原两个函数各自内联的同一份
//     「先 dispose 材质贴图、再 dispose 材质与几何体」遍历已去重为一份；
//   - clearCustomModelGroup -> modelDisposal.clearCustomModelGroup（下方创建，
//     收尾重置的 customModelParts / assemblySequenceOrder 经 s.* 桥接回写）；
//   - yieldToMain 迁至 src/utils.js，调用点不变。
modelDisposal = createModelDisposal({
  customModelGroup,
  getState: () => ({ customModelParts, assemblySequenceOrder }),
  setState: patch => {
    if ("customModelParts" in patch) customModelParts = patch.customModelParts;
    if ("assemblySequenceOrder" in patch) assemblySequenceOrder = patch.assemblySequenceOrder;
  },
});


let isLoadingCustomModel = false;


// ===== 模型加载后归一化（自动缩放 / 爆炸距离智能调整）=====
// 实现迁至 src/model-fit.js：autoScaleModel -> modelFit.autoScaleModel，
// adjustSmartExplodeDistances -> modelFit.adjustSmartExplodeDistances（算式
// 部分另抽为纯函数 computeAutoScale）。
modelFit = createModelFit({
  customModelGroup,
  camera,
  getCustomModelParts: () => customModelParts,
});


// ===== 自定义模型加载统一收尾 =====
// 实现迁至 src/custom-model-finalize.js：finalizeCustomModelLoad 整段搬迁，
// 行为不变（可见性切换/样式/动态步骤/UI/缩放相机/爆炸距离/装配分析/回到合体/
// 少点击自动播放）。九个共享状态经文件末尾 customModelFinalize 实例的
// getState/setState 桥接读写，与 explodeCtl / customModelPanel 同一约定。
// 早声明、后赋值：createCustomModelLoader（下方）与 uploadDeps（文件尾）都
// 注入此函数引用，运行期才调用，而 finalizer 需要 explodeCtl / assembly 等
// 更下方才创建的实例，故实例在 assembly 实例之后统一创建。
let customModelFinalize = null;
function finalizeCustomModelLoad(fileName, opts = {}) {
  customModelFinalize.finalizeCustomModelLoad(fileName, opts);
}

// ===== 模型自动拆分系统 =====
// 实现迁至 src/geometry-split.js：autoSplitModel 整段搬迁，行为不变
//（收集 mesh → 材质组 / 连通分量自然拆分 → 整体包围盒命名）。与
// extractFacesToGeometry / splitBy* / generatePartName 同属纯函数模块，
// 无共享状态依赖，拆分化简后就近编排；单测见 tests/geometry-split-test.mjs。

// ===== Blender MCP 装配顺序对接 =====
// 实现迁至 src/assembly-analysis.js：
//   - fetchAssemblySequenceOrder / maybeApplyAssemblySequence / runAssemblyAnalysis /
//     generateCustomStepGroups 四函数整段搬迁，行为不变；
//   - assemblySequenceOrder 等六个共享状态经下方 assembly 实例的 s.* 桥接读写，
//     与本文件的 let 是同一份（ explodeCtl 同一约定）；
//   - updateStepUI 钩子接 explodeCtl.updateStepUI（保留 typeof 守卫）；
//   - showStatus 轻提示注入。

// ===== 自定义模型加载主链路 =====
// 实现迁至 src/custom-model-loader.js：
//   - loadCustomModel / sortPartsByManifestAsync 整段搬迁，行为不变（重入
//     守卫、拆分分支、烘焙居中、排序命名、收尾与失败回滚均原样）；
//   - isLoadingCustomModel / hasCustomModel / customModelParts / stepGroups /
//     totalSteps / currentStep / displayedStep 七个共享状态经下方实例的
//     getState/setState 桥接读写，与本文件的 let 是同一份；
//   - 失败回滚恢复旧模型时仍走 updateStepUI 钩子（保留 typeof 守卫）与
//     fitCameraToModel；
//   - 步骤组数学抽为纯函数 computeGroupCount / computeStepIndex，烘焙与居中
//     循环抽为 bakeAndCenterParts，清单重排抽为 reorderPartsByManifest，
//     均有对应单测（tests/custom-model-loader-test.mjs）。
customModelLoader = createCustomModelLoader({
  getState: () => ({
    isLoadingCustomModel,
    hasCustomModel,
    customModelParts,
    stepGroups,
    totalSteps,
    currentStep,
    displayedStep,
  }),
  setState: patch => {
    if ("isLoadingCustomModel" in patch) isLoadingCustomModel = patch.isLoadingCustomModel;
    if ("hasCustomModel" in patch) hasCustomModel = patch.hasCustomModel;
    if ("customModelParts" in patch) customModelParts = patch.customModelParts;
    if ("stepGroups" in patch) stepGroups = patch.stepGroups;
    if ("totalSteps" in patch) totalSteps = patch.totalSteps;
    if ("currentStep" in patch) currentStep = patch.currentStep;
    if ("displayedStep" in patch) displayedStep = patch.displayedStep;
  },
  customModelGroup,
  questGroup,
  loadGLTFLoader,
  isQuest3Model,
  splitModelToQuest3Regions,
  autoSplitModel,
  disposeNodeTree,
  yieldToMain,
  calculateExplodePos,
  generatePartName,
  finalizeCustomModelLoad,
  fitCameraToModel,
  showStatus,
  setModelLoading,
  updateStepUI: () => {
    if (typeof explodeCtl?.updateStepUI === "function") explodeCtl.updateStepUI();
  },
  clearCustomModelGroup: modelDisposal.clearCustomModelGroup,
  defaultStepGroups,
  isLowPowerMode: () => lowPowerMode,
});

// ===== 自定义模型面板（UI 同步 / 清除复位）=====
// 实现迁至 src/custom-model-panel.js：
//   - updateCustomModelUI / clearCustomModel 整段搬迁，行为不变（缺失 DOM
//     元素静默跳过、默认清单复原、Quest 3 部件步骤索引重排均原样）；
//   - hasCustomModel / currentModelName / stepGroups / totalSteps / currentStep /
//     displayedStep / animatingStep / isExploded 八个共享状态经下方实例的
//     getState/setState 桥接读写，与本文件的 let 是同一份；
//   - customModelParts 经 getCustomModelParts() 惰性读取（与 upload-panel /
//     model-fit 同一约定）；clearCustomModel 经 upload-panel 的注入面不变。
customModelPanel = createCustomModelPanel({
  getState: () => ({
    hasCustomModel,
    currentModelName,
    stepGroups,
    totalSteps,
    currentStep,
    displayedStep,
    animatingStep,
    isExploded,
  }),
  setState: patch => {
    if ("hasCustomModel" in patch) hasCustomModel = patch.hasCustomModel;
    if ("currentModelName" in patch) currentModelName = patch.currentModelName;
    if ("stepGroups" in patch) stepGroups = patch.stepGroups;
    if ("totalSteps" in patch) totalSteps = patch.totalSteps;
    if ("currentStep" in patch) currentStep = patch.currentStep;
    if ("displayedStep" in patch) displayedStep = patch.displayedStep;
    if ("animatingStep" in patch) animatingStep = patch.animatingStep;
    if ("isExploded" in patch) isExploded = patch.isExploded;
  },
  getCustomModelParts: () => customModelParts,
  questGroup,
  parts,
  timelineSlider,
  explodeBtn,
  defaultStepGroups,
  clearCustomModelGroup: modelDisposal.clearCustomModelGroup,
  updateStepUI: () => {
    if (typeof explodeCtl?.updateStepUI === "function") explodeCtl.updateStepUI();
  },
  fitCameraToModel,
  showStatus,
});

// ===== 中心轴线（拆解时显示）=====
const axisGeo = new CylinderGeometry(0.01, 0.01, 4, 8);
axisGeo.rotateX(Math.PI / 2);
const axisMat = new MeshBasicMaterial({ color: 0x44464f, transparent: true, opacity: 0 });
const axisLine = new Mesh(axisGeo, axisMat);
questGroup.add(axisLine);

// quest3Specs 已从 ./src/quest3-data.js 导入

// 自动适配相机到默认模型
fitCameraToModel(questGroup, false);

// ===== 分步骤拆解（教学导向，参考 iFixit 风格）=====
// defaultStepGroups 已从 ./src/quest3-steps.js 导入
// stepGroups / totalSteps 声明见文件上方「模块共享状态与引用」

// 给每个部件分配步骤序号（默认最后一步）
// 实现迁至 src/quest3-steps.js：命名补齐 + 按 stepGroups 落 stepIndex 整段
// 搬迁，行为不变。parts / stepGroups / totalSteps 以实参传入：stepGroups
// 是会重赋值的 let，实参取调用瞬间的当前值，与原闭包读取同一时刻。
assignPartStepIndices({ parts, stepGroups, totalSteps });

console.log(
  "部件步骤分配：",
  parts.map(p => `${p.mesh.userData.name}->步骤${p.stepIndex}`),
);

// ===== 步骤控制 / 爆炸动画控制器 =====
// 实现迁至 src/explode-controller.js。
//   - camera / controls / renderer / parts / axisMat 是本文件的 const 稳定引用；
//   - stepUi 是上方集中的 DOM 元素集合；
//   - getState / setState 桥接「模块共享状态与引用」里那批会被多处重赋值的 let：
//     控制器读 s.xxx 走 getState 现取，写 s.xxx 走 setState 立即回写，
//     因此两边看到的是同一份状态，不会各写一份写成岔路。
explodeCtl = createExplodeController({
  camera,
  controls,
  renderer,
  parts,
  axisMat,
  ui: stepUi,
  getState: () => ({
    stepGroups,
    totalSteps,
    currentStep,
    displayedStep,
    animatingStep,
    isExploded,
    explodeLoop,
    hasCustomModel,
    customModelParts,
  }),
  setState: patch => {
    // 与控制器里的 SHARED_STATE_KEYS 一一对应；目前控制器只写前五项，其余为对称保留
    if ("stepGroups" in patch) stepGroups = patch.stepGroups;
    if ("totalSteps" in patch) totalSteps = patch.totalSteps;
    if ("currentStep" in patch) currentStep = patch.currentStep;
    if ("displayedStep" in patch) displayedStep = patch.displayedStep;
    if ("animatingStep" in patch) animatingStep = patch.animatingStep;
    if ("isExploded" in patch) isExploded = patch.isExploded;
    if ("explodeLoop" in patch) explodeLoop = patch.explodeLoop;
    if ("hasCustomModel" in patch) hasCustomModel = patch.hasCustomModel;
    if ("customModelParts" in patch) customModelParts = patch.customModelParts;
  },
});

// 装配顺序对接与自定义模型步骤生成（实现迁至 src/assembly-analysis.js）。
// 桥接的六个键与原 main.js 直接操作的那些 let 完全对应。
assembly = createAssemblyAnalysis({
  getState: () => ({
    hasCustomModel,
    customModelParts,
    assemblySequenceOrder,
    stepGroups,
    totalSteps,
    currentStep,
  }),
  setState: patch => {
    if ("hasCustomModel" in patch) hasCustomModel = patch.hasCustomModel;
    if ("customModelParts" in patch) customModelParts = patch.customModelParts;
    if ("assemblySequenceOrder" in patch) assemblySequenceOrder = patch.assemblySequenceOrder;
    if ("stepGroups" in patch) stepGroups = patch.stepGroups;
    if ("totalSteps" in patch) totalSteps = patch.totalSteps;
    if ("currentStep" in patch) currentStep = patch.currentStep;
  },
  updateStepUI: () => {
    if (typeof explodeCtl?.updateStepUI === "function") explodeCtl.updateStepUI();
  },
  showStatus,
});

// 自定义模型加载统一收尾（实现迁至 src/custom-model-finalize.js）。
// 桥接的九个键与原 finalizeCustomModelLoad 直接操作的那些 let 完全对应；
// customModelParts / currentModelStyle 惰性读取；四个协作者至此已全部创建。
customModelFinalize = createCustomModelFinalizer({
  getState: () => ({
    hasCustomModel,
    stepGroups,
    totalSteps,
    currentStep,
    displayedStep,
    animatingStep,
    isExploded,
    explodeLoop,
    autoExplodeTimer,
  }),
  setState: patch => {
    if ("hasCustomModel" in patch) hasCustomModel = patch.hasCustomModel;
    if ("stepGroups" in patch) stepGroups = patch.stepGroups;
    if ("totalSteps" in patch) totalSteps = patch.totalSteps;
    if ("currentStep" in patch) currentStep = patch.currentStep;
    if ("displayedStep" in patch) displayedStep = patch.displayedStep;
    if ("animatingStep" in patch) animatingStep = patch.animatingStep;
    if ("isExploded" in patch) isExploded = patch.isExploded;
    if ("explodeLoop" in patch) explodeLoop = patch.explodeLoop;
    if ("autoExplodeTimer" in patch) autoExplodeTimer = patch.autoExplodeTimer;
  },
  getCustomModelParts: () => customModelParts,
  customModelGroup,
  questGroup,
  explodeBtn,
  assembly,
  customModelPanel,
  explodeCtl,
  modelFit,
  fitCameraToModel,
  applyModelStyle,
  getCurrentModelStyle: () => currentModelStyle,
});

// 移动端检测
if (isMobile) {
  // 移动端优化
  document.body.classList.add("mobile-device");

  // 调整相机距离
  camera.position.set(3, 1.5, 4);
  controls.minDistance = 1.5;
  controls.maxDistance = 10;

  // 触摸优化
  controls.touches = {
    ONE: TOUCH.ROTATE,
    TWO: TOUCH.DOLLY_PAN,
  };
}

// 装配分析面板按钮
const assemblyAnalyzeBtn = document.getElementById("assembly-analyze-btn");
if (assemblyAnalyzeBtn) {
  assemblyAnalyzeBtn.addEventListener("click", () => assembly.runAssemblyAnalysis());
}

// 从生成库加载已拆解模型（models/generated/）
// 实现迁至 src/generated-library.js：选项填充 + 点击加载整段搬迁，行为不变。
// showStatus 来自 src/status-ui.js；loadCustomModel 注入 custom-model-loader 实例。
setupGeneratedLibrary({
  showStatus,
  loadCustomModel: customModelLoader.loadCustomModel,
});


// ===== 导出与轻提示（截图 / 教案 / GLB）=====
// 依赖注入：renderer/scene/camera/questGroup/customModelGroup 是 const 稳定引用；
// currentModelName/totalSteps/displayedStep/hasCustomModel/customModelParts/stepGroups/parts
// 都是会重赋值的 let / 会被替换的数组，经 getState() 现取，避免闭包钉住旧值。
const exportPanel = createExportPanel({
  renderer,
  scene,
  camera,
  questGroup,
  customModelGroup,
  getState: () => ({
    currentModelName,
    totalSteps,
    displayedStep,
    hasCustomModel,
    customModelParts,
    stepGroups,
    parts,
  }),
});

// 键盘快捷键
// 实现迁至 src/keyboard-shortcuts.js：keydown 分发 + autoRotate change 整段
// 搬迁，行为不变。displayedStep 经 getDisplayedStep() 惰性读取（let 会重赋值）。
setupKeyboardShortcuts({
  explodeCtl,
  controls,
  autoRotateCheck,
  exportPanel,
  getDisplayedStep: () => displayedStep,
});

explodeCtl.updateStepUI();


// ===== 响应窗口大小 + 渲染循环 =====
// 实现迁至 src/render-loop.js：resize 监听与 animate 自递归整段搬迁，行为
// 不变（窗口变化只重设 size 与 aspect、不重设 pixelRatio，初值只在
// createSceneSetup 里设一次；后台标签页在进 updateExplodedView 之前就
// return）。六个依赖均为稳定 const 引用，直接传入。
createRenderLoop({ camera, renderer, scene, controls, explodeCtl, particlesMesh });

// 隐藏加载提示
const loadingEl = document.getElementById("loading");
setTimeout(() => {
  if (loadingEl) loadingEl.classList.add("hidden");
}, 100);

// ===== 文件上传与自定义模型 =====
// 实现迁至 src/upload-panel.js（setupUpload，依赖注入）。
// showStatus 已由 src/status-ui.js 持有（十余处复用它写进度）；
// customModelParts 是会被整体替换的 let，必须经 getCustomModelParts() 现取。
const uploadDeps = {
  showStatus,
  customModelGroup,
  getCustomModelParts: () => customModelParts,
  loadCustomModel: customModelLoader.loadCustomModel,
  clearCustomModelGroup: modelDisposal.clearCustomModelGroup,
  finalizeCustomModelLoad,
  clearCustomModel: customModelPanel.clearCustomModel,
};

// 等待 DOM 完全加载后再初始化上传功能
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setupUpload(uploadDeps));
} else {
  setupUpload(uploadDeps);
}

// ===== AI 绘画功能 =====
// AI 绘画面板已迁移到 src/panels/ai-paint-panel.js（setupAIPaint，依赖注入 loadCustomModel/showStatus）

// 读取 ai-config.json：缺失 provider 或 key 时高亮「配置 AI」按钮
// （已抽取到 src/panels/config-panel.js 的 fetchConfigAndHighlight）

// 配置弹窗保存成功的消息监听已迁移到 src/panels/config-panel.js

// 等待 DOM 完全加载后初始化 AI 绘画（面板已迁移到 src/panels/ai-paint-panel.js）
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () =>
    setupAIPaint({ loadCustomModel: customModelLoader.loadCustomModel, showStatus }),
  );
} else {
  setupAIPaint({ loadCustomModel: customModelLoader.loadCustomModel, showStatus });
}

// ===== 主题切换 =====
// 实现迁至 src/theme-toggle.js：setupThemeToggle 整段搬迁，行为不变。
// uiOverlay 由本模块持有并传入：下方 createARPreview 共用同一引用。
const uiOverlay = document.querySelector(".ui-overlay");
setupThemeToggle({ uiOverlay });

// ===== 乐高 / 原生 外观切换 =====
// 实现迁至 src/style-toggle.js：setupStyleToggle 整段搬迁，行为不变。
// applyModelStyle 注入本文件的 model-style 工厂实例（运行期才调用）。
setupStyleToggle({ applyModelStyle });

// ===== Blender 状态检测 + 一键启动（已迁移到 src/panels/config-panel.js） =====

// ===== 步骤描述淡入动画 =====
// 实现迁至 src/step-desc.js：updateStepDescAnimation 与 lastStepDesc 整段
// 搬迁，行为不变。stepDescEl 与本文件上方 stepUi 解构同一引用。
const { updateStepDescAnimation } = createStepDescAnimation({ stepDescEl });

// 在 updateStepUI 的最后调用动画（替代原先对 updateStepUI 的猴子补丁）。
// 挂载时机与原版一致：首屏那次 updateStepUI() 之后才挂上钩子。
// 钩子上再挂一件正事：换步骤时退出「单独显示」——只在实际换步时判断，
// 鼠标微调炸开深度触发的那批 updateStepUI 不打扰用户。
let lastHookStep = -1;
explodeCtl.setStepUIHook(() => {
  updateStepDescAnimation();
  if (displayedStep !== lastHookStep) {
    lastHookStep = displayedStep;
    partInteractions.exitIsolate();
  }
});

// ===== 部件清单交互（点击高亮 / 相机聚焦 / 单独显示）=====
// 实现迁至 src/part-interactions.js。部件行有两个产出方：index.html 的静态清单与
// src/custom-model-panel.js 动态生成的清单，因此模块内部做事件委托 + MutationObserver，
// 主模块只需把「当前全部部件」和 explode-controller 的 focusPart / highlightPart 接上。
// getParts 用 getter 而不是快照：parts 只 push，customModelParts 会被整体替换。
partInteractions = createPartInteractions({
  getParts: () => [...parts, ...customModelParts],
  focusPart: name => explodeCtl.focusPart(name),
  highlightPart: name => explodeCtl.highlightPart(name),
  root: document,
  showAllBtn: document.getElementById("parts-show-all"),
});


// ===== WebXR AR 预览（实现迁至 src/ar-preview.js）=====
// ar* 状态与启停逻辑收敛在 createARPreview 闭包内；主模块只保留引导代码。
// 传入的 7 个引用均为本文件的 const（container/camera/renderer/controls/questGroup/
// parts/uiOverlay），不会重赋值，因此直接传引用即可，无需 getter。
const arPreview = createARPreview({
  container,
  uiOverlay,
  questGroup,
  parts,
  controls,
  renderer,
  camera,
});

// 页面加载后检测 AR
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", arPreview.initAR);
} else {
  arPreview.initAR();
}
