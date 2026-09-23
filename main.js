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
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { defaultStepGroups } from "./src/quest3-steps.js";
import {
  isQuest3Model,
  computeStepGroupCount,
  sortPartsForDisassembly,
} from "./src/utils.js";
import { createARPreview } from "./src/ar-preview.js";
import { createExportPanel } from "./src/export-panel.js";
import {
  calculateExplodePos,
  calculateSmartExplodeDist,
} from "./src/explode-geometry.js";
import {
  splitByConnectedComponents,
  splitByMaterialGroups,
  generatePartName,
} from "./src/geometry-split.js";
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

/**
 * 清除自定义模型组中的所有子对象
 * 同时 dispose 几何体和材质以释放 GPU 内存
 */
function clearCustomModelGroup() {
  // material.dispose() 不会释放贴图的 GPU 资源，需先单独 dispose 所有纹理
  const disposeMaterialTextures = m => {
    for (const value of Object.values(m)) {
      if (value && value.isTexture) value.dispose();
    }
  };
  const disposeMaterial = m => {
    disposeMaterialTextures(m);
    m.dispose();
  };
  while (customModelGroup.children.length > 0) {
    const child = customModelGroup.children[0];
    // traverse 覆盖嵌套的 Group/Mesh（GLTF 场景可能是多层结构）
    child.traverse(node => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        if (Array.isArray(node.material)) {
          node.material.forEach(disposeMaterial);
        } else {
          disposeMaterial(node.material);
        }
      }
    });
    child.userData = {};
    customModelGroup.remove(child);
  }
  customModelParts = [];
  customModelGroup.scale.set(1, 1, 1);
  customModelGroup.position.set(0, 0, 0);
  // 清除上一个模型的装配顺序，避免误用
  assemblySequenceOrder = null;
}

function disposeSceneRecursively(node) {
  if (!node) return;
  const disposeMaterialTextures = m => {
    for (const value of Object.values(m)) {
      if (value && value.isTexture) value.dispose();
    }
  };
  const disposeMaterial = m => {
    disposeMaterialTextures(m);
    m.dispose();
  };
  node.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(disposeMaterial);
      } else {
        disposeMaterial(child.material);
      }
    }
  });
}

let isLoadingCustomModel = false;

function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * 自动放大微小模型
 * 如果模型最大维度小于 5，自动缩放到约 10 单位
 * @param {string} modelType - 模型类型名称（用于日志）
 * @returns {number} 实际应用的缩放比例
 */
function autoScaleModel(modelType = "模型") {
  const autoBox = new Box3().setFromObject(customModelGroup);
  const autoSize = new Vector3();
  autoBox.getSize(autoSize);
  const autoMaxDim = Math.max(autoSize.x, autoSize.y, autoSize.z);

  let autoScale = 1.0;
  if (autoMaxDim < 5.0 && autoMaxDim > 0.001) {
    autoScale = 10.0 / autoMaxDim;
    autoScale = Math.min(autoScale, 20);
  }

  if (autoScale > 1.0) {
    customModelGroup.scale.set(autoScale, autoScale, autoScale);
    console.log(`🔍 ${modelType}自动放大 ${autoScale.toFixed(1)} 倍`);
  }

  return autoScale;
}

/**
 * 智能调整所有自定义部件的爆炸距离
 * 根据相机位置和模型大小计算合适的爆炸距离
 */
function adjustSmartExplodeDistances() {
  requestAnimationFrame(() => {
    const groupScale = customModelGroup.scale.x || 1;
    for (let i = 0; i < customModelParts.length; i++) {
      const part = customModelParts[i];
      let explodeDir = part.explodePos.clone();
      if (explodeDir.length() < 0.001) {
        explodeDir = part.partCenter.clone();
        if (explodeDir.length() < 0.001) {
          const angle = (i / customModelParts.length) * Math.PI * 2;
          explodeDir.set(Math.cos(angle), 0.5, Math.sin(angle));
        }
      }
      explodeDir.normalize();
      const smartDist = calculateSmartExplodeDist(customModelGroup, explodeDir, camera);
      part.explodePos.copy(explodeDir.multiplyScalar(smartDist / groupScale));
    }
    console.log("✅ 爆炸距离已智能调整");
  });
}

/**
 * 自定义模型加载后的统一收尾流程（消除三个 loader 中的重复代码）。
 * 调用方在加载/拆分完成后调用此函数，传入差异化参数。
 * @param {string} fileName
 * @param {object} [opts]
 * @param {string} [opts.modelType]   autoScaleModel 的类型标签
 * @param {boolean} [opts.adjustExplode=true] 是否调用 adjustSmartExplodeDistances
 * @param {boolean} [opts.applyStyle=true]    是否调用 applyModelStyle
 */
function finalizeCustomModelLoad(fileName, opts = {}) {
  const { modelType, adjustExplode = true, applyStyle = true } = opts;

  hasCustomModel = true;
  questGroup.visible = false;
  customModelGroup.visible = true;

  if (applyStyle) applyModelStyle(currentModelStyle);

  // 生成动态步骤
  stepGroups = generateCustomStepGroups(customModelParts, fileName);
  totalSteps = stepGroups.length;
  currentStep = 0;
  displayedStep = 0;
  animatingStep = 0;

  // 更新 UI
  updateCustomModelUI(customModelParts.length, fileName);
  explodeCtl.updateStepUI();

  // 自动缩放
  autoScaleModel(modelType);

  // 自动适配相机
  fitCameraToModel(customModelGroup, false);

  // 智能调整爆炸距离
  if (adjustExplode) adjustSmartExplodeDistances();

  // 装配分析（非阻塞）
  maybeApplyAssemblySequence(fileName);

  // 回到合体状态
  explodeCtl.goToStep(0);
  isExploded = false;
  explodeBtn.classList.remove("exploded");
  explodeBtn.textContent = "💥 爆炸";

  // 「少点击」：上传/AI 生成完成后自动播一次爆炸，用户无需再点「💥爆炸视图」
  // 就能直接看到拆解结果（若用户已开启循环播放则不打扰）。
  if (!explodeLoop) {
    clearTimeout(autoExplodeTimer);
    autoExplodeTimer = setTimeout(() => {
      autoExplodeTimer = null;
      if (!isExploded && !explodeLoop) explodeCtl.toggleExplode();
    }, 500);
  }
}

// ===== 模型自动拆分系统 =====
// 几何体拆分工具已抽到 ./src/geometry-split.js（extractFacesToGeometry / splitBy* / generatePartName）

// 自动拆分编排器：收集 mesh，按材质和连通分量准确拆分
function autoSplitModel(model) {
  // 第一步：收集所有 mesh 及其世界变换
  const rawMeshes = [];
  model.traverse(child => {
    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      rawMeshes.push(child);
    }
  });

  // 如果 mesh 数量 >= 2，直接使用原始 mesh（保持准确）
  if (rawMeshes.length >= 2) {
    return rawMeshes.map((mesh, i) => {
      const name = mesh.name || mesh.userData.name || `部件${i + 1}`;
      return { mesh, name, isOriginal: true };
    });
  }

  // 只有一个 mesh 时，尝试按材质组或连通分量拆分（自然拆分，不强制）
  const splitParts = [];
  for (const mesh of rawMeshes) {
    const geometry = mesh.geometry;
    const material = mesh.material;

    // 尝试材质组拆分（如果模型本身有多个材质组，说明设计上就是多部件）
    const groupResults = splitByMaterialGroups(geometry);
    if (groupResults.length >= 2) {
      for (const gr of groupResults) {
        const newMesh = new Mesh(
          gr.geometry,
          Array.isArray(material) ? material[gr.materialIndex] || material[0] : material,
        );
        newMesh.matrix.copy(mesh.matrixWorld);
        newMesh.matrixAutoUpdate = false;
        splitParts.push({ mesh: newMesh, name: "", isOriginal: false });
      }
      continue;
    }

    // 尝试连通分量拆分（检测物理上分离的部件）
    const ccResults = splitByConnectedComponents(geometry);
    if (ccResults.length >= 2) {
      for (const ccGeo of ccResults) {
        const newMesh = new Mesh(ccGeo, material);
        newMesh.matrix.copy(mesh.matrixWorld);
        newMesh.matrixAutoUpdate = false;
        splitParts.push({ mesh: newMesh, name: "", isOriginal: false });
      }
      continue;
    }

    // 无法自然拆分，保留原始 mesh（不强制空间切分，保持准确）
    splitParts.push({ mesh, name: mesh.name || "", isOriginal: true });
  }

  // 计算整体包围盒用于命名
  const bbox = new Box3();
  for (const part of splitParts) {
    const partBox = new Box3().setFromObject(part.mesh);
    bbox.union(partBox);
  }

  // 为拆分后的部件命名
  return splitParts.map((part, i) => {
    if (!part.name) {
      const pos = new Vector3();
      part.mesh.getWorldPosition(pos);
      part.name = generatePartName(i, pos, bbox);
    }
    return part;
  });
}

// ===== Blender MCP 装配顺序对接 =====
// assemblySequenceOrder 声明见文件上方「模块共享状态与引用」

/**
 * 从后端（server.js -> Blender MCP addon）拉取装配拆解顺序。
 * @param {string} method distance|size|hierarchy
 * @returns {Promise<string[]|null>} 部件名称数组；不可用时返回 null
 */
async function fetchAssemblySequenceOrder(method = "distance") {
  try {
    const resp = await fetch(`${API_BASE}/api/assembly/sequence?method=${encodeURIComponent(method)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.success && Array.isArray(data.order) && data.order.length) {
      return data.order;
    }
  } catch {
    /* 后端或 Blender 未就绪，静默回退 */
  }
  return null;
}

/**
 * 尝试用 Blender 装配分析结果优化当前自定义模型的拆解步骤。
 * 仅当返回顺序与当前部件名称有足够重叠（判定为同一模型）时才应用。
 * 非阻塞：失败时保持原有距离排序。
 * @param {string} fileName 当前模型文件名（用于重建步骤）
 */
async function maybeApplyAssemblySequence(fileName) {
  if (!hasCustomModel || !customModelParts.length) return;
  const order = await fetchAssemblySequenceOrder();
  if (!order || !order.length) return;

  // 校验：Blender 场景中的部件名称需与前端模型有足够重叠
  const names = new Set(customModelParts.map(p => p.name));
  const overlap = order.filter(n => names.has(n));
  if (overlap.length < 2) return; // 判定为不同模型，跳过

  assemblySequenceOrder = order;
  stepGroups = generateCustomStepGroups(customModelParts, fileName);
  totalSteps = stepGroups.length;
  if (currentStep >= totalSteps) currentStep = totalSteps - 1;
  if (typeof explodeCtl.updateStepUI === "function") explodeCtl.updateStepUI();
  showStatus(`🔧 已根据 Blender 装配分析优化拆解顺序（匹配 ${overlap.length} 个部件）`, "success");

  // 同一份 Blender 数据可用：自动拉取可制造性评分并展开面板
  const panel = document.getElementById("assembly-panel");
  if (panel && typeof panel.open !== "undefined") panel.open = true;
  runAssemblyAnalysis();
}

/**
 * 调用后端装配分析接口，在「装配分析」面板展示可制造性评分（0-100）、
 * 等级、扣分明细与建议。Blender/后端不可用时给出友好提示。
 */
async function runAssemblyAnalysis() {
  const btn = document.getElementById("assembly-analyze-btn");
  const resultEl = document.getElementById("assembly-result");
  if (!resultEl) return;

  if (btn) btn.disabled = true;
  resultEl.classList.remove("hidden");
  resultEl.innerHTML = "⏳ 正在分析…（需 Blender 后端运行）";

  try {
    const resp = await fetch("/api/assembly/analysis");
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      resultEl.innerHTML =
        `⚠️ 装配分析不可用：<br>${data.error || resp.status}<br><br>` +
        "请确认 Blender 已启动且 MCP addon 已连接（侧栏 BlenderMCP → Connect to MCP server）。";
      return;
    }

    const pr = data.production_readiness || {};
    const score = typeof pr.score === "number" ? pr.score : null;
    const level = pr.level || "—";
    const color =
      score == null ? "#888" : score >= 80 ? "#2e7d32" : score >= 55 ? "#f9a825" : "#c62828";

    const recs =
      Array.isArray(pr.recommendations) && pr.recommendations.length ?
        pr.recommendations.map(r => `<li>${r}</li>`).join("") :
        "<li>无明显制造风险</li>";

    const bd = pr.breakdown || {};
    const bdRows = Object.keys(bd).length ?
      "<table class=\"asm-table\"><tr><th>扣分项</th><th>分值</th></tr>" +
        Object.entries(bd)
          .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
          .join("") +
        "</table>" :
      "";

    resultEl.innerHTML = `
      <div class="asm-score">
        <div class="asm-score-badge" style="border-color:${color};color:${color}">${score == null ? "—" : score}</div>
        <div class="asm-score-meta">
          <div>可制造性评分 <strong style="color:${color}">${level}</strong></div>
          <div class="asm-sub">部件数：${data.part_count ?? "—"} ｜ 干涉：${data.interference_count ?? "—"} ｜ 配合面：${data.interface_count ?? "—"}</div>
        </div>
      </div>
      ${bdRows}
      <div class="asm-rec-title">改进建议</div>
      <ul class="asm-rec">${recs}</ul>
    `;
  } catch (e) {
    resultEl.innerHTML = `⚠️ 请求失败：${e.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 为自定义模型生成动态步骤
function generateCustomStepGroups(customParts, fileName) {
  const partCount = customParts.length;
  const groupCount = computeStepGroupCount(partCount);

  const groups = [];

  // 步骤 0：欢迎
  groups.push({
    name: "👋 模型概览",
    parts: [],
    tools: [],
    description: `已加载模型：<strong>${fileName}</strong><br><br>
📦 检测到 <strong>${partCount}</strong> 个独立部件<br>
🤖 已自动完成拆分分析<br><br>
💡 点击"下一步"开始逐步拆解，或点击"爆炸视图"一键展开。`,
  });

  // 部件拆解排序：优先使用 Blender MCP 装配分析给出的顺序
  const sortedParts = sortPartsForDisassembly(customParts, assemblySequenceOrder);

  // 将部件分组到各步骤
  const partsPerGroup = Math.ceil(partCount / groupCount);
  for (let g = 0; g < groupCount; g++) {
    const groupParts = sortedParts.slice(g * partsPerGroup, (g + 1) * partsPerGroup);
    const partNames = groupParts.map(p => p.name);
    groups.push({
      name: `${g + 1}️⃣ 第 ${g + 1} 组部件`,
      parts: partNames,
      tools: ["🖱️ 鼠标拖拽旋转", "🔍 滚轮缩放观察"],
      description: `正在拆解第 ${g + 1} 组（共 ${groupCount} 组）<br><br>
📦 本组包含 ${groupParts.length} 个部件：<br>
${partNames.map(n => `• ${n}`).join("<br>")}<br><br>
💡 拖动旋转视角，仔细观察每个部件的细节。`,
    });
  }

  // 最后一步：完成
  groups.push({
    name: "🎉 拆解完成",
    parts: [],
    tools: [],
    description: `拆解完成！共展示 ${partCount} 个部件。<br><br>
💡 你可以：<br>
• 点击"爆炸视图"重新展开<br>
• 点击"重置"回到初始状态<br>
• 拖动"爆炸深度"滑块控制展开程度<br>
• 上传新的模型继续探索`,
  });

  return groups;
}

async function loadCustomModel(arrayBuffer, fileName, blenderManifest = null) {
  if (isLoadingCustomModel) {
    showStatus("⏳ 正在加载模型，请稍候...", "info");
    return;
  }

  const loadStart = performance.now();
  let previousHasCustomModel = hasCustomModel;
  let previousCustomModelParts = customModelParts.map(part => ({
    mesh: part.mesh,
    homePos: part.homePos.clone(),
    explodePos: part.explodePos.clone(),
    homeRot: part.homeRot.clone(),
    explodeRot: part.explodeRot.clone(),
    name: part.name,
    partCenter: part.partCenter.clone(),
    stepIndex: part.stepIndex,
  }));
  let previousStepGroups = stepGroups;
  let previousTotalSteps = totalSteps;
  let previousCurrentStep = currentStep;
  let previousDisplayedStep = displayedStep;

  try {
    isLoadingCustomModel = true;
    setModelLoading(true, "📦 正在解析模型...");
    const splitMethod = blenderManifest ? "Blender CLI" : "前端 JS";
    showStatus(`📦 正在解析模型（${splitMethod}）...`, "info");

    // 先释放旧模型，降低解析新模型时的显存/内存峰值
    clearCustomModelGroup();

    const LoaderClass = await loadGLTFLoader();
    const loader = new LoaderClass();

    const gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, "", resolve, err => reject(new Error("解析失败：" + err.message)));
    });

    // 立即隐藏默认（Quest 3）模型，确保生成的模型单独显示、不与主模型叠加
    questGroup.visible = false;

    const model = gltf.scene;
    model.updateMatrixWorld(true);

    const isQ3 = isQuest3Model(fileName);

    // ========== 自动拆分 ==========
    let splitParts;
    if (isQ3 && !blenderManifest) {
      // Quest 3 模型且无 Blender 清单（Blender 不可用时回退）：前端按 15 区域切割
      showStatus("🔍 Quest 3 模型：前端按 15 部位区域切割...", "info");
      splitParts = splitModelToQuest3Regions(model);
    } else {
      showStatus("🔍 正在分析模型结构并自动拆分...", "info");
      splitParts = autoSplitModel(model);
    }

    // 原始 GLTF 场景的几何体/材质已复制/拆分为新部件，释放原始场景以回收 GPU 资源
    disposeSceneRecursively(model);

    if (splitParts.length === 0) {
      throw new Error("模型中未找到可渲染的网格");
    }

    setModelLoading(true, "🔧 正在准备部件...");

    // ========== 烘焙世界矩阵到几何体（非前端 Quest 3 路径需要）==========
    if (!(isQ3 && !blenderManifest)) {
      for (let i = 0; i < splitParts.length; i++) {
        await yieldToMain();
        const mesh = splitParts[i].mesh;
        mesh.updateMatrixWorld(true);
        mesh.geometry.applyMatrix4(mesh.matrixWorld);
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(0, 0, 0);
        mesh.scale.set(1, 1, 1);
        mesh.matrixAutoUpdate = true;
        mesh.matrix.identity();
        mesh.castShadow = !lowPowerMode;
        mesh.receiveShadow = !lowPowerMode;
      }

      // 计算模型中心，将几何体居中
      const modelBox = new Box3();
      for (let i = 0; i < splitParts.length; i++) {
        await yieldToMain();
        const partBox = new Box3().setFromObject(splitParts[i].mesh);
        modelBox.union(partBox);
      }
      const modelCenter = modelBox.getCenter(new Vector3());
      for (let i = 0; i < splitParts.length; i++) {
        await yieldToMain();
        splitParts[i].mesh.geometry.translate(-modelCenter.x, -modelCenter.y, -modelCenter.z);
      }
    }

    // ========== 创建部件数据 ==========
    const splitPartMap = new Map(splitParts.map(part => [part.mesh, part]));
    customModelParts.length = 0;
    while (customModelGroup.children.length > 0) {
      customModelGroup.remove(customModelGroup.children[0]);
    }

    for (let i = 0; i < splitParts.length; i++) {
      await yieldToMain();
      const mesh = splitParts[i].mesh;

      // 计算部件中心（相对于模型中心，即原点）
      const partBox = new Box3().setFromObject(mesh);
      const partCenter = partBox.getCenter(new Vector3());

      // 爆炸方向：从模型中心指向部件中心
      const explodePos = calculateExplodePos(partCenter, i, splitParts.length);

      const part = {
        mesh,
        homePos: new Vector3(0, 0, 0),
        explodePos,
        homeRot: new Euler(0, 0, 0),
        explodeRot: new Euler(0, 0, 0),
        name: "", // 稍后分配
        partCenter: partCenter.clone(),
        stepIndex: 1,
      };
      customModelParts.push(part);

      customModelGroup.add(mesh);
    }

    // ========== 按距离中心排序（外层先拆）==========
    // 如果有 Blender 清单，按清单顺序排列；否则按距离排序
    if (blenderManifest && blenderManifest.parts) {
      await sortPartsByManifestAsync(blenderManifest);
    } else {
      customModelParts.sort((a, b) => b.partCenter.length() - a.partCenter.length());
    }

    // ========== 分配步骤索引和名称 ==========
    const partCount = customModelParts.length;
    const groupCount = Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);
    const partsPerGroup = Math.ceil(partCount / groupCount);

    // 重新计算包围盒（已居中）
    const centeredBox = new Box3();
    for (let i = 0; i < partCount; i++) {
      centeredBox.union(new Box3().setFromObject(customModelParts[i].mesh));
      if (i % 40 === 0) await yieldToMain();
    }

    // ========== 命名 ==========
    if (isQ3 && blenderManifest && blenderManifest.parts) {
      // Quest 3 模型 + Blender 清单：使用 Blender 分配的名称
      for (let i = 0; i < partCount; i++) {
        await yieldToMain();
        const part = customModelParts[i];
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        if (blenderManifest.parts[i]) {
          part.name =
            blenderManifest.parts[i].display_name ||
            blenderManifest.parts[i].name ||
            `部件${i + 1}`;
        }
        part.mesh.userData = { name: part.name };
        part.mesh.name = part.name;
      }
    } else if (isQ3) {
      // Quest 3 模型 + 前端拆解：splitModelToQuest3Regions 已分配名称
      for (let i = 0; i < partCount; i++) {
        await yieldToMain();
        const part = customModelParts[i];
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        const origName = splitPartMap.get(part.mesh)?.name;
        if (origName) part.name = origName;
        part.mesh.userData = { name: part.name };
        part.mesh.name = part.name;
      }
    } else {
      // 非 Quest 3 模型：Blender 清单名称 → GLB 原始名称 → 位置生成名称
      for (let i = 0; i < partCount; i++) {
        await yieldToMain();
        const part = customModelParts[i];
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        if (blenderManifest && blenderManifest.parts && blenderManifest.parts[i]) {
          part.name =
            blenderManifest.parts[i].display_name ||
            blenderManifest.parts[i].name ||
            `部件${i + 1}`;
        } else {
          const origName = splitPartMap.get(part.mesh)?.name;
          if (origName && !origName.startsWith("部件")) {
            part.name = origName;
          } else {
            part.name = generatePartName(i, part.partCenter, centeredBox);
          }
        }
        part.mesh.userData = { name: part.name };
        part.mesh.name = part.name;
      }
    }

    // 统一收尾：隐藏默认模型、生成步骤、适配相机、回到合体
    finalizeCustomModelLoad(fileName, { adjustExplode: true });

    const elapsed = ((performance.now() - loadStart) / 1000).toFixed(1);
    showStatus(`✅ 成功加载：${fileName}\n自动拆分为 ${partCount} 个部件（${elapsed}s）`, "success");

    console.log(`✅ 自定义模型加载完成：${partCount} 个部件（自动拆分，${groupCount} 个步骤组）`);
  } catch (err) {
    console.error("加载模型失败：", err);
    showStatus(`❌ 加载失败：${err.message}`, "error");
    // 加载失败：尽量回滚到上一个可用状态，避免空白/混合显示
    clearCustomModelGroup();
    if (previousHasCustomModel && previousCustomModelParts.length) {
      customModelParts = previousCustomModelParts;
      customModelGroup.visible = true;
      questGroup.visible = false;
      hasCustomModel = true;
      stepGroups = previousStepGroups;
      totalSteps = previousTotalSteps;
      currentStep = previousCurrentStep;
      displayedStep = previousDisplayedStep;
      explodeCtl.updateStepUI();
      fitCameraToModel(customModelGroup, false);
    } else {
      questGroup.visible = true;
      hasCustomModel = false;
      stepGroups = defaultStepGroups;
      totalSteps = stepGroups.length;
      currentStep = 0;
      displayedStep = 0;
      explodeCtl.updateStepUI();
      fitCameraToModel(questGroup, false);
    }
  } finally {
    isLoadingCustomModel = false;
    setModelLoading(false);
  }
}

async function sortPartsByManifestAsync(blenderManifest) {
  const manifestOrder = blenderManifest.parts.map((p, idx) => ({
    name: p.display_name || p.name,
    idx,
  }));
  const used = new Set();
  const reordered = [];
  for (const mp of manifestOrder) {
    await yieldToMain();
    const targetCenter = blenderManifest.parts[mp.idx].center;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < customModelParts.length; i++) {
      if (used.has(i)) continue;
      const d = customModelParts[i].partCenter.distanceTo(
        new Vector3(targetCenter[0], targetCenter[1], targetCenter[2]),
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      reordered.push(customModelParts[bestIdx]);
    }
  }
  for (let i = 0; i < customModelParts.length; i++) {
    if (!used.has(i)) reordered.push(customModelParts[i]);
    if (i % 40 === 0) await yieldToMain();
  }
  customModelParts.length = 0;
  customModelParts.push(...reordered);
}

function updateCustomModelUI(partCount, fileName) {
  const countEl = document.getElementById("part-count");
  if (countEl) countEl.textContent = partCount;

  // 记录模型名（去掉扩展名），供截图 / 教案导出命名
  if (fileName) currentModelName = String(fileName).replace(/\.[^.]+$/, "");

  const uploadSection = document.querySelector(".panel");
  if (uploadSection) {
    const fileNameEl = document.getElementById("uploaded-file-name");
    if (fileNameEl) fileNameEl.textContent = `当前模型：${fileName}`;
  }

  const clearBtn = document.getElementById("clear-model-btn");
  if (clearBtn) clearBtn.style.display = "inline-block";

  // 更新时间轴总数
  const timelineTotalEl = document.getElementById("timeline-total");
  if (timelineTotalEl) timelineTotalEl.textContent = totalSteps;

  // 更新时间轴滑块范围
  if (timelineSlider) {
    timelineSlider.max = totalSteps;
  }

  // ========== 动态生成部件清单 ==========
  const partsGrid = document.querySelector(".parts-grid");
  if (partsGrid && customModelParts.length > 0) {
    partsGrid.innerHTML = "";
    customModelParts.forEach(part => {
      const item = document.createElement("div");
      item.className = "part-item";
      item.dataset.part = part.name;
      // 提取材质颜色作为圆点颜色
      let dotColor = "#888";
      if (part.mesh && part.mesh.material) {
        const mat = part.mesh.material;
        if (mat.color) dotColor = "#" + mat.color.getHexString();
      }
      item.innerHTML = `<span class="part-dot" style="background:${dotColor}"></span>${part.name}`;
      partsGrid.appendChild(item);
    });
  }
}

function clearCustomModel() {
  clearCustomModelGroup();
  hasCustomModel = false;
  currentModelName = "Meta Quest 3";

  // 恢复默认模型可见性
  questGroup.visible = true;

  // 恢复默认步骤系统
  stepGroups = defaultStepGroups;
  totalSteps = stepGroups.length;
  currentStep = 0;
  displayedStep = 0;
  animatingStep = 0;

  // 恢复 UI
  const countEl = document.getElementById("part-count");
  if (countEl) countEl.textContent = "15";

  // 恢复默认部件清单
  const partsGrid = document.querySelector(".parts-grid");
  if (partsGrid) {
    partsGrid.innerHTML = `
      <div class="part-item" data-part="前面板"><span class="part-dot" style="background:#f2f2f2"></span>前面板</div>
      <div class="part-item" data-part="主机身"><span class="part-dot" style="background:#222225"></span>主机身</div>
      <div class="part-item" data-part="左透镜模组"><span class="part-dot" style="background:#1e3a5f"></span>透镜 x2</div>
      <div class="part-item" data-part="左摄像头"><span class="part-dot" style="background:#0a0a0a"></span>摄像头 x4</div>
      <div class="part-item" data-part="左头带臂"><span class="part-dot" style="background:#3a3a3c"></span>头带臂 x2</div>
      <div class="part-item" data-part="面罩海绵"><span class="part-dot" style="background:#2c2c2e"></span>海绵</div>
      <div class="part-item" data-part="主板/显示屏"><span class="part-dot" style="background:#0d4a22"></span>主板</div>
      <div class="part-item" data-part="头带"><span class="part-dot" style="background:#3a3a3c"></span>头带</div>
    `;
  }

  const timelineTotalEl = document.getElementById("timeline-total");
  if (timelineTotalEl) timelineTotalEl.textContent = totalSteps;

  if (timelineSlider) {
    timelineSlider.max = totalSteps;
    timelineSlider.value = 0;
  }

  const clearBtn = document.getElementById("clear-model-btn");
  if (clearBtn) clearBtn.style.display = "none";

  const status = document.getElementById("upload-status");
  if (status) {
    status.classList.add("hidden");
    status.textContent = "";
  }

  const fileNameEl = document.getElementById("uploaded-file-name");
  if (fileNameEl) fileNameEl.textContent = "";

  // 重置爆炸状态
  isExploded = false;
  if (explodeBtn) {
    explodeBtn.classList.remove("exploded");
    explodeBtn.textContent = "💥 爆炸视图";
  }

  // 重新分配 Quest 3 部件的步骤索引
  parts.forEach(part => {
    const meshName = part.mesh.userData.name;
    let stepIndex = totalSteps;
    stepGroups.forEach((group, idx) => {
      if (group.parts.includes(meshName)) {
        stepIndex = idx;
      }
    });
    part.stepIndex = stepIndex;
  });

  // 更新 UI
  explodeCtl.updateStepUI();
  fitCameraToModel(questGroup, false);

  showStatus("已清除自定义模型，恢复默认", "info");
  console.log("✅ 已恢复默认 Quest 3 模型和步骤系统");
}

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
  assemblyAnalyzeBtn.addEventListener("click", () => runAssemblyAnalysis());
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
      loadCustomModel(buf, name, null);
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
  loadCustomModel,
  clearCustomModelGroup,
  finalizeCustomModelLoad,
  clearCustomModel,
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
    setupAIPaint({ loadCustomModel, showStatus }),
  );
} else {
  setupAIPaint({ loadCustomModel, showStatus });
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
