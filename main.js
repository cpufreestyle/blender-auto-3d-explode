import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  Fog,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  BasicShadowMap,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  SpotLight,
  TOUCH,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createExplodeController } from "./src/explode-controller.js";
import { createAssemblyAnalysis } from "./src/assembly-analysis.js";
import { createModelDisposal, disposeNodeTree } from "./src/model-disposal.js";
import { createModelFit } from "./src/model-fit.js";
import { createCustomModelFinalizer } from "./src/custom-model-finalize.js";
import { createCustomModelLoader } from "./src/custom-model-loader.js";
import { createCustomModelPanel } from "./src/custom-model-panel.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { defaultStepGroups } from "./src/quest3-steps.js";
import { isQuest3Model, yieldToMain } from "./src/utils.js";
import { createARPreview } from "./src/ar-preview.js";
import { createExportPanel } from "./src/export-panel.js";
import {
  calculateExplodePos,
  calculateSmartExplodeDist,
} from "./src/explode-geometry.js";
import { autoSplitModel, generatePartName } from "./src/geometry-split.js";
import { materials, getLegoMaterialForMesh } from "./src/lego-materials.js";
import { splitModelToQuest3Regions } from "./src/quest3-parts.js";
import { setupUpload } from "./src/upload-panel.js";
import { setupAIPaint } from "./src/panels/ai-paint-panel.js";
// 副作用导入：确保 config-panel.js 加载并初始化 Blender 健康检测/配置高亮（不依赖 ai-paint 面板是否启用）
import "./src/panels/config-panel.js";
import { API_BASE } from "./src/config.js";

// 动态导入 GLTFLoader（npm 包，webpack 自动 tree-shake）
let GLTFLoader = null;
async function loadGLTFLoader() {
  if (!GLTFLoader) {
    const module = await import("three/examples/jsm/loaders/GLTFLoader.js");
    GLTFLoader = module.GLTFLoader;
  }
  return GLTFLoader;
}

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
const container = document.getElementById("canvas-container");
const scene = new Scene();
scene.background = new Color(0x0a0c12);
scene.fog = new Fog(0x0a0c12, 10, 40);

// 添加背景网格（装饰性）
const gridHelper = new GridHelper(30, 30, 0x1a1b23, 0x1a1b23);
gridHelper.position.y = -1.5;
gridHelper.material.opacity = 0.3;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// 移动端/一体机（Quest 3 等）GPU 为填充率瓶颈：低功耗模式判定
// ⚠️ 必须在下方粒子的 lowPowerMode 使用之前声明，否则触发 TDZ 报错
// "Cannot access 'lowPowerMode' before initialization"
const isTouchDevice = navigator.maxTouchPoints > 0;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const lowPowerMode = isTouchDevice || isMobile;

// 添加环境粒子（增强空间感）
const particlesGeometry = new BufferGeometry();
const particlesCount = lowPowerMode ? 150 : 500;
const posArray = new Float32Array(particlesCount * 3);

for (let i = 0; i < particlesCount * 3; i++) {
  posArray[i] = (Math.random() - 0.5) * 30;
}

particlesGeometry.setAttribute("position", new BufferAttribute(posArray, 3));
const particlesMaterial = new PointsMaterial({
  size: 0.02,
  color: 0x4a9eff,
  transparent: true,
  opacity: 0.4,
});
const particlesMesh = new Points(particlesGeometry, particlesMaterial);
// 低功耗（移动端/一体机）：粒子纯装饰，直接不画，省一次 draw call 与每帧矩阵更新
particlesMesh.visible = !lowPowerMode;
scene.add(particlesMesh);

const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(4, 2.5, 5);

const renderer = new WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
// 限制 DPR：移动端/一体机避免过度采样（防填充率瓶颈）；桌面维持 2
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouchDevice ? 1.5 : 2));
renderer.shadowMap.enabled = !lowPowerMode;
renderer.shadowMap.type = lowPowerMode ? BasicShadowMap : PCFSoftShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

// WebGL 上下文丢失/恢复处理（Quest 浏览器长时间运行或内存压力下常见）
renderer.domElement.addEventListener("webglcontextlost", e => {
  // preventDefault 允许 three.js 自动重建上下文并重新上传 GPU 资源
  e.preventDefault();
  showStatus("⚠️ GPU 上下文丢失，正在尝试恢复...", "error");
});
renderer.domElement.addEventListener("webglcontextrestored", () => {
  showStatus("✅ GPU 上下文已恢复", "success");
});

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 2.5;
controls.maxDistance = 15;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.target.set(0, 0.15, 0);

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
let assembly = null; // 装配顺序对接 / 自定义步骤生成（src/assembly-analysis.js）
let modelDisposal = null; // 自定义模型拆卸与 GPU 资源释放（src/model-disposal.js）
let modelFit = null; // 模型加载后归一化（src/model-fit.js）
let customModelLoader = null; // 自定义模型加载主链路（src/custom-model-loader.js）
let customModelPanel = null; // 自定义模型面板 UI 同步与清除复位（src/custom-model-panel.js）
// 主模块另有两处直接使用（步骤描述淡入 / 自动旋转快捷键）
const { stepDescEl, autoRotateCheck } = stepUi;

// ===== 自动适配相机到模型 =====
function fitCameraToModel(modelGroup, smooth = true) {
  // 计算包围盒
  const box = new Box3().setFromObject(modelGroup);
  const center = box.getCenter(new Vector3());
  const size = new Vector3();
  box.getSize(size);

  // 计算最大尺寸
  const maxDim = Math.max(size.x, size.y, size.z);

  // 计算合适的相机距离（根据模型大小）
  const fov = camera.fov * (Math.PI / 180);
  let cameraDistance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5;

  // 设置最小/最大距离限制
  cameraDistance = Math.max(0.8, Math.min(cameraDistance, 20));

  // 设置相机目标位置
  const targetPos = new Vector3(center.x, center.y + size.y * 0.3, center.z);
  controls.target.copy(targetPos);

  // 计算新的相机位置（保持当前角度）
  const direction = new Vector3().subVectors(camera.position, controls.target).normalize();
  const newCameraPos = targetPos.clone().add(direction.multiplyScalar(cameraDistance));

  if (smooth) {
    // 平滑过渡
    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    let progress = 0;

    function animateCamera() {
      progress += 0.03;
      if (progress >= 1) {
        camera.position.copy(newCameraPos);
        controls.target.copy(targetPos);
        return;
      }

      // 使用缓动函数
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(startPos, newCameraPos, easeProgress);
      controls.target.lerpVectors(startTarget, targetPos, easeProgress);

      requestAnimationFrame(animateCamera);
    }
    animateCamera();
  } else {
    camera.position.copy(newCameraPos);
    controls.target.copy(targetPos);
  }

  console.log("📐 相机适配:", {
    center: `(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`,
    size: `(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)})`,
    maxDim: maxDim.toFixed(2),
    cameraDistance: cameraDistance.toFixed(2),
  });
}

// ===== 增强灯光系统 =====
const ambientLight = new AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);

const mainLight = new DirectionalLight(0xffffff, lowPowerMode ? 1.2 : 1.5);
mainLight.position.set(6, 10, 7);
mainLight.castShadow = true;
// 阴影贴图：桌面 1024（2048 观感提升有限、开销却是 4 倍），低功耗 512
mainLight.shadow.mapSize.set(lowPowerMode ? 512 : 1024, lowPowerMode ? 512 : 1024);
mainLight.shadow.bias = -0.0001;
mainLight.shadow.camera.near = 0.5;
mainLight.shadow.camera.far = 30;
scene.add(mainLight);

const fillLight = new DirectionalLight(0x99bbff, lowPowerMode ? 0.4 : 0.6);
fillLight.position.set(-6, 4, -5);
scene.add(fillLight);

const rimLight = new SpotLight(0xffffff, lowPowerMode ? 1.0 : 1.8);
rimLight.position.set(0, 8, -7);
rimLight.angle = Math.PI / 5;
rimLight.penumbra = 0.5;
rimLight.decay = 2;
rimLight.distance = 35;
// 移除 rimLight.castShadow 以减少移动端 GPU 填充率消耗（仅保留 mainLight 投射阴影）
scene.add(rimLight);

// 补充底部反射光
const bottomLight = new DirectionalLight(0x334466, lowPowerMode ? 0.15 : 0.3);
bottomLight.position.set(0, -5, 0);
scene.add(bottomLight);

// 材质与乐高外观系统已抽到 ./src/lego-materials.js（导出 materials / legoMaterials / getLegoMaterialForMesh 等）

// ===== 乐高 / 原生 外观切换（2026-07 新增）=====
// 乐高风格：亮色塑料质感、无金属、轻微自发光，营造积木玩具观感（不改几何体）
let currentModelStyle = "native"; // 'native' | 'lego'

// 应用模型外观风格：'native' | 'lego'
function applyModelStyle(style) {
  currentModelStyle = style;
  const setLego = style === "lego";
  const groups = [questGroup];
  if (typeof customModelGroup !== "undefined") groups.push(customModelGroup);
  groups.forEach(group => {
    group.traverse(child => {
      if (!child.isMesh) return;
      if (child.userData._nativeMaterial === undefined) {
        child.userData._nativeMaterial = child.material;
      }
      child.material = setLego ? getLegoMaterialForMesh(child) : child.userData._nativeMaterial;
    });
  });
}

// ===== Quest 3 简化模型构建 =====
// questGroup 声明见文件上方「模块共享状态与引用」
scene.add(questGroup);

const parts = []; // 存储所有可拆解部件

function createPart({
  mesh,
  homePos,
  explodePos,
  homeRot = [0, 0, 0],
  explodeRot = [0, 0, 0],
  name,
}) {
  mesh.position.set(...homePos);
  mesh.rotation.set(...homeRot);
  mesh.castShadow = !lowPowerMode;
  mesh.receiveShadow = !lowPowerMode;
  mesh.userData = { name };
  questGroup.add(mesh);
  parts.push({
    mesh,
    homePos: new Vector3(...homePos),
    explodePos: new Vector3(...explodePos),
    homeRot: new Euler(...homeRot),
    explodeRot: new Euler(...explodeRot),
    name: name,
  });
  return mesh;
}

// 1. 主机身（中部黑色主体）
const bodyGeo = new RoundedBoxGeometry(2.2, 1.15, 1.0, 4, 0.12);
const bodyMesh = new Mesh(bodyGeo, materials.body);
createPart({
  mesh: bodyMesh,
  homePos: [0, 0, 0],
  explodePos: [0, 0, 0],
  name: "主机身",
});

// 2. 前面板（白色外壳）
const frontGeo = new RoundedBoxGeometry(2.3, 1.25, 0.25, 4, 0.1);
const frontMesh = new Mesh(frontGeo, materials.frontPlate);
createPart({
  mesh: frontMesh,
  homePos: [0, 0, 0.55],
  explodePos: [0, 0, 1.45],
  name: "前面板",
});

// 3. 后面罩/泡沫垫
const foamGeo = new RoundedBoxGeometry(2.0, 0.95, 0.18, 4, 0.08);
const foamMesh = new Mesh(foamGeo, materials.foam);
createPart({
  mesh: foamMesh,
  homePos: [0, 0, -0.55],
  explodePos: [0, 0, -1.35],
  name: "面罩海绵",
});

// 4. 左右透镜模组
const barrelGeo = new CylinderGeometry(0.32, 0.32, 0.45, 32);
barrelGeo.rotateX(Math.PI / 2);
const leftBarrel = new Mesh(barrelGeo, materials.lensBarrel);
createPart({
  mesh: leftBarrel,
  homePos: [-0.52, 0.05, -0.12],
  explodePos: [-0.52, 0.05, -0.7],
  name: "左透镜模组",
});

const rightBarrel = new Mesh(barrelGeo.clone(), materials.lensBarrel);
createPart({
  mesh: rightBarrel,
  homePos: [0.52, 0.05, -0.12],
  explodePos: [0.52, 0.05, -0.7],
  name: "右透镜模组",
});

// 5. 透镜玻璃片
const glassGeo = new CylinderGeometry(0.26, 0.26, 0.04, 32);
glassGeo.rotateX(Math.PI / 2);
const leftGlass = new Mesh(glassGeo, materials.lensGlass);
createPart({
  mesh: leftGlass,
  homePos: [-0.52, 0.05, -0.34],
  explodePos: [-0.52, 0.05, -1.1],
  name: "左透镜",
});

const rightGlass = new Mesh(glassGeo.clone(), materials.lensGlass);
createPart({
  mesh: rightGlass,
  homePos: [0.52, 0.05, -0.34],
  explodePos: [0.52, 0.05, -1.1],
  name: "右透镜",
});

// 6. 显示屏/主板
const pcbGeo = new BoxGeometry(1.6, 0.7, 0.06);
const pcbMesh = new Mesh(pcbGeo, materials.pcb);
createPart({
  mesh: pcbMesh,
  homePos: [0, 0.05, -0.05],
  explodePos: [0, 0.05, -0.95],
  name: "主板/显示屏",
});

// 7. 前置摄像头（左右两颗 + 中间一颗）
const camGeo = new CylinderGeometry(0.09, 0.09, 0.08, 24);
camGeo.rotateX(Math.PI / 2);

const leftCam = new Mesh(camGeo, materials.camera);
createPart({
  mesh: leftCam,
  homePos: [-0.75, 0.18, 0.68],
  explodePos: [-0.95, 0.35, 1.8],
  name: "左摄像头",
});

const rightCam = new Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: rightCam,
  homePos: [0.75, 0.18, 0.68],
  explodePos: [0.95, 0.35, 1.8],
  name: "右摄像头",
});

const centerCam = new Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: centerCam,
  homePos: [0, 0.28, 0.68],
  explodePos: [0, 0.55, 1.9],
  name: "中置摄像头",
});

// 摄像头镜头小圆点
const lensDotGeo = new CircleGeometry(0.055, 24);
function addCamLens(parent, zOffset) {
  const dot = new Mesh(lensDotGeo, materials.sensor);
  dot.position.z = zOffset;
  parent.add(dot);
}
addCamLens(leftCam, 0.045);
addCamLens(rightCam, 0.045);
addCamLens(centerCam, 0.045);

// 8. 下侧摄像头/传感器
const bottomCam = new Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: bottomCam,
  homePos: [0, -0.35, 0.6],
  explodePos: [0, -0.75, 1.7],
  name: "下置追踪摄像头",
});
addCamLens(bottomCam, 0.045);

// 9. 头带臂（左右）
const armGeo = new RoundedBoxGeometry(0.25, 0.7, 0.18, 2, 0.04);
const leftArm = new Mesh(armGeo, materials.strapArm);
createPart({
  mesh: leftArm,
  homePos: [-1.25, 0, 0],
  explodePos: [-2.1, 0, 0],
  name: "左头带臂",
});

const rightArm = new Mesh(armGeo.clone(), materials.strapArm);
createPart({
  mesh: rightArm,
  homePos: [1.25, 0, 0],
  explodePos: [2.1, 0, 0],
  name: "右头带臂",
});

// 10. 头带（简化弧线）
const strapCurve = new CatmullRomCurve3([
  new Vector3(-1.25, 0.25, -0.1),
  new Vector3(-0.8, 1.4, -0.5),
  new Vector3(0, 1.6, -0.6),
  new Vector3(0.8, 1.4, -0.5),
  new Vector3(1.25, 0.25, -0.1),
]);
const strapGeo = new TubeGeometry(strapCurve, 32, 0.14, 12, false);
const strapMesh = new Mesh(strapGeo, materials.strapArm);
createPart({
  mesh: strapMesh,
  homePos: [0, 0, 0],
  explodePos: [0, 0.9, -0.8],
  name: "头带",
});

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
parts.forEach(part => {
  // 确保 mesh.userData.name 存在
  if (!part.mesh.userData.name) {
    part.mesh.userData.name = part.mesh.name || `part_${parts.indexOf(part)}`;
  }
  // 确保 mesh.name 可用
  if (!part.mesh.name) {
    part.mesh.name = part.mesh.userData.name;
  }
  const meshName = part.mesh.userData.name;
  let stepIndex = totalSteps;
  stepGroups.forEach((group, idx) => {
    if (group.parts.includes(meshName)) {
      stepIndex = idx;
    }
  });
  part.stepIndex = stepIndex;
});

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
const generatedSelect = document.getElementById("generated-select");
const generatedLoadBtn = document.getElementById("generated-load");
if (generatedSelect && generatedLoadBtn) {
  fetch(`${API_BASE}/api/generated`)
    .then(r => r.json())
    .then(data => {
      if (!data.success || !data.files || !data.files.length) return;
      data.files.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.url;
        const kb = (f.size / 1024).toFixed(0);
        opt.textContent = `${f.name} (${kb} KB)`;
        generatedSelect.appendChild(opt);
      });
    })
    .catch(() => {
      /* 忽略：无生成库时不展示 */
    });

  generatedLoadBtn.addEventListener("click", async() => {
    const url = generatedSelect.value;
    if (!url) return;
    try {
      showStatus("📦 正在从生成库加载模型...", "info");
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("加载失败 " + resp.status);
      const buf = await resp.arrayBuffer();
      const name = decodeURIComponent(url.split("/").pop());
      customModelLoader.loadCustomModel(buf, name, null);
    } catch (err) {
      showStatus("❌ 从生成库加载失败: " + err.message, "error");
    }
  });
}


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
document.addEventListener("keydown", e => {
  // 忽略在输入框中的按键
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  switch (e.key) {
    case "ArrowRight":
      e.preventDefault();
      explodeCtl.goToStep(displayedStep + 1);
      break;
    case "ArrowLeft":
      e.preventDefault();
      explodeCtl.goToStep(displayedStep - 1);
      break;
    case " ":
      e.preventDefault();
      explodeCtl.toggleExplode();
      break;
    case "r":
    case "R":
      e.preventDefault();
      explodeCtl.goToStep(0);
      break;
    case "a":
    case "A":
      e.preventDefault();
      autoRotateCheck.checked = !autoRotateCheck.checked;
      controls.autoRotate = autoRotateCheck.checked;
      break;
    case "f":
    case "F":
      e.preventDefault();
      explodeCtl.focusCurrentPart();
      break;
    case "s":
    case "S":
      e.preventDefault();
      exportPanel.exportScreenshot();
      break;
  }
});

autoRotateCheck.addEventListener("change", e => {
  controls.autoRotate = e.target.checked;
});

explodeCtl.updateStepUI();


// ===== 响应窗口大小 =====
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== 渲染循环 =====
function animate(now) {
  requestAnimationFrame(animate);
  // 后台标签页不做任何计算与渲染（浏览器已节流 rAF，这里再兜一层）
  if (document.hidden) return;
  explodeCtl.updateExplodedView(now);

  // 粒子动画（缓慢旋转）— 仅在可见时更新
  if (particlesMesh && particlesMesh.visible) {
    particlesMesh.rotation.y = now * 0.00005;
    particlesMesh.rotation.x = now * 0.00003;
  }

  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// 隐藏加载提示
const loadingEl = document.getElementById("loading");
const uploadStatusEl = document.getElementById("upload-status"); // 全局上传状态元素
setTimeout(() => {
  if (loadingEl) loadingEl.classList.add("hidden");
}, 100);

// ===== 文件上传与自定义模型 =====
// base64ToUtf8 已从 src/utils.js 导入（支持浏览器和 Node.js 双环境）

function showStatus(msg, type = "info") {
  if (!uploadStatusEl) return;
  uploadStatusEl.textContent = msg;
  uploadStatusEl.className = "status-box " + type;
  uploadStatusEl.classList.remove("hidden");
}

const modelLoadingEl = document.getElementById("model-loading");
const modelLoadingTextEl = document.getElementById("model-loading-text");
const MODEL_LOADING_BTN_IDS = [
  "upload-btn",
  "clear-model-btn",
  "prev-step",
  "next-step",
  "reset-step",
  "style-toggle",
  "explode-btn",
  "explode-loop",
  "timeline-play",
  "timeline-reset",
  "generated-load",
  "img-to-3d-btn",
  "open-config-btn",
  "blender-launch",
];

function setModelLoading(loading, text = "正在准备模型...") {
  if (modelLoadingEl) modelLoadingEl.classList.toggle("hidden", !loading);
  if (modelLoadingTextEl) modelLoadingTextEl.textContent = text;
  MODEL_LOADING_BTN_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = loading;
  });
}

// ===== 文件上传与自定义模型 =====
// 实现迁至 src/upload-panel.js（setupUpload，依赖注入）。
// showStatus 的状态条 DOM 归 main.js 持有（十余处复用它写进度）；
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
const themeToggle = document.getElementById("theme-toggle");
const uiOverlay = document.querySelector(".ui-overlay");

if (themeToggle && uiOverlay) {
  // 检查本地存储的主题设置
  const savedTheme = localStorage.getItem("quest3-theme");
  if (savedTheme === "light") {
    uiOverlay.classList.add("light-theme");
    themeToggle.textContent = "☀️";
  }

  themeToggle.addEventListener("click", () => {
    uiOverlay.classList.toggle("light-theme");
    const isLight = uiOverlay.classList.contains("light-theme");

    // 保存主题设置
    localStorage.setItem("quest3-theme", isLight ? "light" : "dark");

    // 更新按钮图标
    themeToggle.textContent = isLight ? "☀️" : "🌙";

    // 添加切换动画
    themeToggle.style.transform = "rotate(360deg) scale(1.2)";
    setTimeout(() => {
      themeToggle.style.transform = "";
    }, 300);
  });
}

// ===== 乐高 / 原生 外观切换 =====
const styleToggle = document.getElementById("style-toggle");
if (styleToggle) {
  let modelStyle = localStorage.getItem("quest3-model-style") || "native";
  applyModelStyle(modelStyle);
  styleToggle.textContent = modelStyle === "lego" ? "🧱 乐高风格" : "🛠️ 原生风格";
  styleToggle.classList.toggle("lego", modelStyle === "lego");

  styleToggle.addEventListener("click", () => {
    modelStyle = modelStyle === "lego" ? "native" : "lego";
    applyModelStyle(modelStyle);
    localStorage.setItem("quest3-model-style", modelStyle);
    styleToggle.textContent = modelStyle === "lego" ? "🧱 乐高风格" : "🛠️ 原生风格";
    styleToggle.classList.toggle("lego", modelStyle === "lego");
    styleToggle.style.transform = "rotate(360deg) scale(1.05)";
    setTimeout(() => {
      styleToggle.style.transform = "";
    }, 300);
  });
}

// ===== Blender 状态检测 + 一键启动（已迁移到 src/panels/config-panel.js） =====

// ===== 步骤描述淡入动画 =====
let lastStepDesc = "";
function updateStepDescAnimation() {
  if (!stepDescEl) return;

  const currentDesc = stepDescEl.textContent;
  if (currentDesc !== lastStepDesc) {
    stepDescEl.style.animation = "none";
    // 触发重排
    void stepDescEl.offsetHeight;
    stepDescEl.style.animation = "fadeInUp 0.5s ease-out";
    lastStepDesc = currentDesc;
  }
}

// 在 updateStepUI 的最后调用动画（替代原先对 updateStepUI 的猴子补丁）。
// 挂载时机与原版一致：首屏那次 updateStepUI() 之后才挂上钩子。
explodeCtl.setStepUIHook(updateStepDescAnimation);

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
