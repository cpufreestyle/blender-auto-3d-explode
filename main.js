import * as THREE from "./vendor/three.module.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoundedBoxGeometry } from "./vendor/RoundedBoxGeometry.js";
import { partInfo } from "./src/quest3-data.js";
import { defaultStepGroups } from "./src/quest3-steps.js";
import {
  UnionFind,
  easeOutCubic,
  smoothStep,
  isQuest3Model,
  base64ToUtf8,
  generatePartName as _generatePartName,
} from "./src/utils.js";

// 动态导入 GLTFLoader（本地化 + Import Map 支持）
let GLTFLoader = null;
async function loadGLTFLoader() {
  if (!GLTFLoader) {
    // 直接使用 import，依赖 import map 解析 'three'
    const module = await import("./vendor/GLTFLoader.js");
    GLTFLoader = module.GLTFLoader;
  }
  return GLTFLoader;
}

// 动态导入 STLLoader
let STLLoader = null;
async function loadSTLLoader() {
  if (!STLLoader) {
    const module = await import("./vendor/STLLoader.js");
    STLLoader = module.STLLoader;
  }
  return STLLoader;
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
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c12);
scene.fog = new THREE.Fog(0x0a0c12, 10, 40);

// 添加背景网格（装饰性）
const gridHelper = new THREE.GridHelper(30, 30, 0x1a1b23, 0x1a1b23);
gridHelper.position.y = -1.5;
gridHelper.material.opacity = 0.3;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// 添加环境粒子（增强空间感）
const particlesGeometry = new THREE.BufferGeometry();
const particlesCount = 500;
const posArray = new Float32Array(particlesCount * 3);

for (let i = 0; i < particlesCount * 3; i++) {
  posArray[i] = (Math.random() - 0.5) * 30;
}

particlesGeometry.setAttribute("position", new THREE.BufferAttribute(posArray, 3));
const particlesMaterial = new THREE.PointsMaterial({
  size: 0.02,
  color: 0x4a9eff,
  transparent: true,
  opacity: 0.4,
});
const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
scene.add(particlesMesh);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(4, 2.5, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 2.5;
controls.maxDistance = 15;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.target.set(0, 0.15, 0);

// ===== 自动适配相机到模型 =====
function fitCameraToModel(modelGroup, smooth = true) {
  // 计算包围盒
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = new THREE.Vector3();
  box.getSize(size);

  // 计算最大尺寸
  const maxDim = Math.max(size.x, size.y, size.z);

  // 计算合适的相机距离（根据模型大小）
  const fov = camera.fov * (Math.PI / 180);
  let cameraDistance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5;

  // 设置最小/最大距离限制
  cameraDistance = Math.max(0.8, Math.min(cameraDistance, 20));

  // 设置相机目标位置
  const targetPos = new THREE.Vector3(center.x, center.y + size.y * 0.3, center.z);
  controls.target.copy(targetPos);

  // 计算新的相机位置（保持当前角度）
  const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
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

// ===== 智能爆炸距离计算 =====
function calculateSmartExplodeDist(modelGroup, explodeDir) {
  // 1. 获取当前模型包围盒
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  // 2. 计算相机相关信息
  const fov = camera.fov * (Math.PI / 180);
  const distToCamera = camera.position.distanceTo(center);

  // 3. 计算视野边界
  // 在爆炸方向上的最大可见距离（基于 FOV 和相机距离）
  // 留 40% 的边距，确保部件不会太靠近屏幕边缘
  const maxVisibleDist = distToCamera * Math.tan(fov / 2) * 0.6;

  // 4. 计算从相机到中心的方向
  const toCamera = new THREE.Vector3().subVectors(camera.position, center).normalize();

  // 5. 计算爆炸方向与相机方向的夹角
  const angleWithCamera = explodeDir.angleTo(toCamera);

  // 6. 如果爆炸方向朝向相机，需要更小的爆炸距离
  let angleFactor = 1.0;
  if (angleWithCamera < Math.PI / 4) {
    // 朝向相机爆炸，需要减小距离
    angleFactor = 0.5 + angleWithCamera / (Math.PI / 2);
  }

  // 7. 计算建议的爆炸距离
  // 基础距离：模型尺寸的 40%（明显但不夸张）
  let suggestedDist = maxDim * 0.4;

  // 确保最小可见性
  suggestedDist = Math.max(suggestedDist, 1.0);

  // 确保不会飞出屏幕
  suggestedDist = Math.min(suggestedDist, maxVisibleDist * angleFactor);

  // 确保不会太小
  suggestedDist = Math.max(suggestedDist, 0.8);

  console.log("🧮 智能爆炸距离计算:", {
    modelSize: maxDim.toFixed(2),
    distToCamera: distToCamera.toFixed(2),
    maxVisibleDist: maxVisibleDist.toFixed(2),
    angleWithCamera: ((angleWithCamera * 180) / Math.PI).toFixed(1) + "°",
    angleFactor: angleFactor.toFixed(2),
    suggestedDist: suggestedDist.toFixed(2),
  });

  return suggestedDist;
}

// ===== 增强灯光系统 =====
const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);

const mainLight = new THREE.DirectionalLight(0xffffff, 1.5);
mainLight.position.set(6, 10, 7);
mainLight.castShadow = true;
mainLight.shadow.mapSize.set(2048, 2048);
mainLight.shadow.bias = -0.0001;
mainLight.shadow.camera.near = 0.5;
mainLight.shadow.camera.far = 30;
scene.add(mainLight);

const fillLight = new THREE.DirectionalLight(0x99bbff, 0.6);
fillLight.position.set(-6, 4, -5);
scene.add(fillLight);

const rimLight = new THREE.SpotLight(0xffffff, 1.8);
rimLight.position.set(0, 8, -7);
rimLight.angle = Math.PI / 5;
rimLight.penumbra = 0.5;
rimLight.decay = 2;
rimLight.distance = 35;
rimLight.castShadow = true;
scene.add(rimLight);

// 补充底部反射光
const bottomLight = new THREE.DirectionalLight(0x334466, 0.3);
bottomLight.position.set(0, -5, 0);
scene.add(bottomLight);

// ===== 材质（升级真实感）=====
const materials = {
  // 白色前面板（亚光塑料质感）
  frontPlate: new THREE.MeshPhysicalMaterial({
    color: 0xf8f8f8,
    roughness: 0.35,
    metalness: 0.02,
    clearcoat: 0.5,
    clearcoatRoughness: 0.2,
  }),
  // 黑色主机身（哑光塑料）
  body: new THREE.MeshStandardMaterial({
    color: 0x1e1e21,
    roughness: 0.6,
    metalness: 0.08,
  }),
  // 深空蓝透镜外环（金属质感）
  lensBarrel: new THREE.MeshPhysicalMaterial({
    color: 0x1a2f4a,
    roughness: 0.2,
    metalness: 0.55,
    clearcoat: 0.9,
    clearcoatRoughness: 0.1,
  }),
  // 透镜玻璃（透明蓝色）
  lensGlass: new THREE.MeshPhysicalMaterial({
    color: 0x99ccff,
    roughness: 0.03,
    metalness: 0.0,
    transmission: 0.95,
    thickness: 0.5,
    transparent: true,
    opacity: 0.8,
  }),
  // 摄像头（深色玻璃纤维）
  camera: new THREE.MeshStandardMaterial({
    color: 0x0d0d0d,
    roughness: 0.25,
    metalness: 0.65,
  }),
  // 传感器镜头
  sensor: new THREE.MeshBasicMaterial({ color: 0x0a1a33 }),
  // 头带臂（深灰色塑料）
  strapArm: new THREE.MeshStandardMaterial({
    color: 0x2d2d30,
    roughness: 0.7,
    metalness: 0.12,
  }),
  // 记忆海绵（深灰色，高粗糙度）
  foam: new THREE.MeshStandardMaterial({
    color: 0x1a1a1c,
    roughness: 0.95,
    metalness: 0.0,
  }),
  // 主板 PCB（深绿色）
  pcb: new THREE.MeshStandardMaterial({
    color: 0x094022,
    roughness: 0.75,
    metalness: 0.05,
  }),
};

// ===== 乐高 / 原生 外观切换（2026-07 新增）=====
// 乐高风格：亮色塑料质感、无金属、轻微自发光，营造积木玩具观感（不改几何体）
let currentModelStyle = "native"; // 'native' | 'lego'

function makeLegoMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.38,
    metalness: 0.0,
    emissive: new THREE.Color(color).multiplyScalar(0.05),
  });
}
function makeLegoGlass() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x6fd0ff,
    roughness: 0.05,
    metalness: 0.0,
    transmission: 0.9,
    thickness: 0.4,
    transparent: true,
    opacity: 0.7,
  });
}
const legoMaterials = {
  frontPlate: makeLegoMaterial(0xf4f5f6),
  body: makeLegoMaterial(0x15161a),
  lensBarrel: makeLegoMaterial(0x0a69c2),
  lensGlass: makeLegoGlass(),
  camera: makeLegoMaterial(0x3b3b3b),
  sensor: new THREE.MeshBasicMaterial({ color: 0x0a1a33 }),
  strapArm: makeLegoMaterial(0xc91a22),
  foam: makeLegoMaterial(0x4a4a4a),
  pcb: makeLegoMaterial(0x1e9e4a),
};

// 原生材质 → 乐高材质 映射
const nativeToLego = new Map();
nativeToLego.set(materials.frontPlate, legoMaterials.frontPlate);
nativeToLego.set(materials.body, legoMaterials.body);
nativeToLego.set(materials.lensBarrel, legoMaterials.lensBarrel);
nativeToLego.set(materials.lensGlass, legoMaterials.lensGlass);
nativeToLego.set(materials.camera, legoMaterials.camera);
nativeToLego.set(materials.sensor, legoMaterials.sensor);
nativeToLego.set(materials.strapArm, legoMaterials.strapArm);
nativeToLego.set(materials.foam, legoMaterials.foam);
nativeToLego.set(materials.pcb, legoMaterials.pcb);

// 自定义模型：根据原始颜色推导亮色积木色
function brightenToLego(hex) {
  const tmp = new THREE.Color(hex);
  const hsl = {};
  tmp.getHSL(hsl);
  if (hsl.l < 0.08) return 0x2b2b2b; // 近黑 → 暗塑料
  return new THREE.Color().setHSL(hsl.h, Math.max(0.6, hsl.s), 0.5).getHex();
}
function getLegoMaterialForMesh(child) {
  const nativeMat = child.userData._nativeMaterial;
  if (nativeToLego.has(nativeMat)) return nativeToLego.get(nativeMat);
  if (child.userData._legoMaterial) return child.userData._legoMaterial;
  let color = 0x3498db;
  if (nativeMat && nativeMat.color) color = brightenToLego(nativeMat.color.getHex());
  const lm = makeLegoMaterial(color);
  child.userData._legoMaterial = lm;
  return lm;
}

// 应用模型外观风格：'native' | 'lego'
function applyModelStyle(style) {
  currentModelStyle = style;
  const setLego = style === "lego";
  const groups = [questGroup];
  if (typeof customModelGroup !== "undefined") groups.push(customModelGroup);
  groups.forEach((group) => {
    group.traverse((child) => {
      if (!child.isMesh) return;
      if (child.userData._nativeMaterial === undefined) {
        child.userData._nativeMaterial = child.material;
      }
      child.material = setLego ? getLegoMaterialForMesh(child) : child.userData._nativeMaterial;
    });
  });
}

// ===== Quest 3 简化模型构建 =====
const questGroup = new THREE.Group();
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
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { name };
  questGroup.add(mesh);
  parts.push({
    mesh,
    homePos: new THREE.Vector3(...homePos),
    explodePos: new THREE.Vector3(...explodePos),
    homeRot: new THREE.Euler(...homeRot),
    explodeRot: new THREE.Euler(...explodeRot),
    name: name,
  });
  return mesh;
}

// 1. 主机身（中部黑色主体）
const bodyGeo = new RoundedBoxGeometry(2.2, 1.15, 1.0, 4, 0.12);
const bodyMesh = new THREE.Mesh(bodyGeo, materials.body);
createPart({
  mesh: bodyMesh,
  homePos: [0, 0, 0],
  explodePos: [0, 0, 0],
  name: "主机身",
});

// 2. 前面板（白色外壳）
const frontGeo = new RoundedBoxGeometry(2.3, 1.25, 0.25, 4, 0.1);
const frontMesh = new THREE.Mesh(frontGeo, materials.frontPlate);
createPart({
  mesh: frontMesh,
  homePos: [0, 0, 0.55],
  explodePos: [0, 0, 1.45],
  name: "前面板",
});

// 3. 后面罩/泡沫垫
const foamGeo = new RoundedBoxGeometry(2.0, 0.95, 0.18, 4, 0.08);
const foamMesh = new THREE.Mesh(foamGeo, materials.foam);
createPart({
  mesh: foamMesh,
  homePos: [0, 0, -0.55],
  explodePos: [0, 0, -1.35],
  name: "面罩海绵",
});

// 4. 左右透镜模组
const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.45, 32);
barrelGeo.rotateX(Math.PI / 2);
const leftBarrel = new THREE.Mesh(barrelGeo, materials.lensBarrel);
createPart({
  mesh: leftBarrel,
  homePos: [-0.52, 0.05, -0.12],
  explodePos: [-0.52, 0.05, -0.7],
  name: "左透镜模组",
});

const rightBarrel = new THREE.Mesh(barrelGeo.clone(), materials.lensBarrel);
createPart({
  mesh: rightBarrel,
  homePos: [0.52, 0.05, -0.12],
  explodePos: [0.52, 0.05, -0.7],
  name: "右透镜模组",
});

// 5. 透镜玻璃片
const glassGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.04, 32);
glassGeo.rotateX(Math.PI / 2);
const leftGlass = new THREE.Mesh(glassGeo, materials.lensGlass);
createPart({
  mesh: leftGlass,
  homePos: [-0.52, 0.05, -0.34],
  explodePos: [-0.52, 0.05, -1.1],
  name: "左透镜",
});

const rightGlass = new THREE.Mesh(glassGeo.clone(), materials.lensGlass);
createPart({
  mesh: rightGlass,
  homePos: [0.52, 0.05, -0.34],
  explodePos: [0.52, 0.05, -1.1],
  name: "右透镜",
});

// 6. 显示屏/主板
const pcbGeo = new THREE.BoxGeometry(1.6, 0.7, 0.06);
const pcbMesh = new THREE.Mesh(pcbGeo, materials.pcb);
createPart({
  mesh: pcbMesh,
  homePos: [0, 0.05, -0.05],
  explodePos: [0, 0.05, -0.95],
  name: "主板/显示屏",
});

// 7. 前置摄像头（左右两颗 + 中间一颗）
const camGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 24);
camGeo.rotateX(Math.PI / 2);

const leftCam = new THREE.Mesh(camGeo, materials.camera);
createPart({
  mesh: leftCam,
  homePos: [-0.75, 0.18, 0.68],
  explodePos: [-0.95, 0.35, 1.8],
  name: "左摄像头",
});

const rightCam = new THREE.Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: rightCam,
  homePos: [0.75, 0.18, 0.68],
  explodePos: [0.95, 0.35, 1.8],
  name: "右摄像头",
});

const centerCam = new THREE.Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: centerCam,
  homePos: [0, 0.28, 0.68],
  explodePos: [0, 0.55, 1.9],
  name: "中置摄像头",
});

// 摄像头镜头小圆点
const lensDotGeo = new THREE.CircleGeometry(0.055, 24);
function addCamLens(parent, zOffset) {
  const dot = new THREE.Mesh(lensDotGeo, materials.sensor);
  dot.position.z = zOffset;
  parent.add(dot);
}
addCamLens(leftCam, 0.045);
addCamLens(rightCam, 0.045);
addCamLens(centerCam, 0.045);

// 8. 下侧摄像头/传感器
const bottomCam = new THREE.Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: bottomCam,
  homePos: [0, -0.35, 0.6],
  explodePos: [0, -0.75, 1.7],
  name: "下置追踪摄像头",
});
addCamLens(bottomCam, 0.045);

// 9. 头带臂（左右）
const armGeo = new RoundedBoxGeometry(0.25, 0.7, 0.18, 2, 0.04);
const leftArm = new THREE.Mesh(armGeo, materials.strapArm);
createPart({
  mesh: leftArm,
  homePos: [-1.25, 0, 0],
  explodePos: [-2.1, 0, 0],
  name: "左头带臂",
});

const rightArm = new THREE.Mesh(armGeo.clone(), materials.strapArm);
createPart({
  mesh: rightArm,
  homePos: [1.25, 0, 0],
  explodePos: [2.1, 0, 0],
  name: "右头带臂",
});

// 10. 头带（简化弧线）
const strapCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-1.25, 0.25, -0.1),
  new THREE.Vector3(-0.8, 1.4, -0.5),
  new THREE.Vector3(0, 1.6, -0.6),
  new THREE.Vector3(0.8, 1.4, -0.5),
  new THREE.Vector3(1.25, 0.25, -0.1),
]);
const strapGeo = new THREE.TubeGeometry(strapCurve, 32, 0.14, 12, false);
const strapMesh = new THREE.Mesh(strapGeo, materials.strapArm);
createPart({
  mesh: strapMesh,
  homePos: [0, 0, 0],
  explodePos: [0, 0.9, -0.8],
  name: "头带",
});

// ===== 自定义模型处理 =====
const customModelGroup = new THREE.Group();
scene.add(customModelGroup);
let customModelParts = []; // 存储自定义模型的部件
let hasCustomModel = false;

// ===== 自定义模型公共工具函数（提取重复逻辑）=====

/**
 * 清除自定义模型组中的所有子对象
 * 同时 dispose 几何体和材质以释放 GPU 内存
 */
function clearCustomModelGroup() {
  while (customModelGroup.children.length > 0) {
    const child = customModelGroup.children[0];
    // dispose 几何体和材质
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else {
        child.material.dispose();
      }
    }
    customModelGroup.remove(child);
  }
  customModelParts = [];
  customModelGroup.scale.set(1, 1, 1);
  customModelGroup.position.set(0, 0, 0);
  // 清除上一个模型的装配顺序，避免误用
  assemblySequenceOrder = null;
}

/**
 * 自动放大微小模型
 * 如果模型最大维度小于 5，自动缩放到约 10 单位
 * @param {string} modelType - 模型类型名称（用于日志）
 * @returns {number} 实际应用的缩放比例
 */
function autoScaleModel(modelType = "模型") {
  const autoBox = new THREE.Box3().setFromObject(customModelGroup);
  const autoSize = new THREE.Vector3();
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
      const smartDist = calculateSmartExplodeDist(customModelGroup, explodeDir);
      part.explodePos.copy(explodeDir.multiplyScalar(smartDist / groupScale));
    }
    console.log("✅ 爆炸距离已智能调整");
  });
}

/**
 * 为自定义部件计算爆炸方向和位置
 * @param {THREE.Vector3} partCenter - 部件中心
 * @param {number} index - 部件索引
 * @param {number} totalParts - 总部件数
 * @returns {THREE.Vector3} 爆炸位置
 */
function calculateExplodePos(partCenter, index, totalParts) {
  let explodeDir;
  const distFromCenter = partCenter.length();
  if (distFromCenter < 0.001) {
    const angle = (index / totalParts) * Math.PI * 2;
    explodeDir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
  } else {
    explodeDir = partCenter.clone().normalize();
  }
  const initialDist = Math.max(distFromCenter * 3, 1.0);
  return explodeDir.multiplyScalar(initialDist);
}

// ===== 模型自动拆分系统 =====
// UnionFind 已从 src/utils.js 导入（统一使用已测试版本）

// 从几何体中提取指定面，创建新的非索引几何体
function extractFacesToGeometry(geometry, faceIndices) {
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const index = geometry.index;
  const hasIndex = !!index;

  const newPositions = [];
  const newNormals = norm ? [] : null;
  const newUVs = uv ? [] : null;

  for (const f of faceIndices) {
    for (let v = 0; v < 3; v++) {
      const srcIdx = hasIndex ? index.getX(f * 3 + v) : f * 3 + v;
      newPositions.push(pos.getX(srcIdx), pos.getY(srcIdx), pos.getZ(srcIdx));
      if (norm) newNormals.push(norm.getX(srcIdx), norm.getY(srcIdx), norm.getZ(srcIdx));
      if (uv) newUVs.push(uv.getX(srcIdx), uv.getY(srcIdx));
    }
  }

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
  if (newNormals) newGeo.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
  if (newUVs) newGeo.setAttribute("uv", new THREE.Float32BufferAttribute(newUVs, 2));
  return newGeo;
}

// 按连通分量拆分几何体（将单个 mesh 拆成多个独立部件）
function splitByConnectedComponents(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const vertexCount = pos.count;
  if (vertexCount === 0) return [];

  const uf = new UnionFind(vertexCount);

  // 连接共享面的顶点
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      uf.union(index.getX(i), index.getX(i + 1));
      uf.union(index.getX(i + 1), index.getX(i + 2));
      uf.union(index.getX(i + 2), index.getX(i));
    }
  } else {
    for (let i = 0; i < vertexCount; i += 3) {
      uf.union(i, i + 1);
      uf.union(i + 1, i + 2);
      uf.union(i + 2, i);
    }
  }

  // 按根节点分组面
  const componentFaces = new Map();
  const faceCount = index ? index.count / 3 : vertexCount / 3;

  for (let f = 0; f < faceCount; f++) {
    const v0 = index ? index.getX(f * 3) : f * 3;
    const root = uf.find(v0);
    if (!componentFaces.has(root)) componentFaces.set(root, []);
    componentFaces.get(root).push(f);
  }

  // 按面数降序排列，过滤太小的分量（< 12 个面）
  const sorted = [...componentFaces.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([, faces]) => faces.length >= 12);

  // 为每个分量创建新几何体
  const results = [];
  for (const [, faces] of sorted) {
    const newGeo = extractFacesToGeometry(geometry, faces);
    if (newGeo) results.push(newGeo);
  }

  // 如果有被过滤掉的小分量，合并成一个大分量
  const smallFaces = [];
  for (const [, faces] of [...componentFaces.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([, faces]) => faces.length < 12)) {
    smallFaces.push(...faces);
  }
  if (smallFaces.length >= 3) {
    const newGeo = extractFacesToGeometry(geometry, smallFaces);
    if (newGeo) results.push(newGeo);
  }

  return results;
}

// 按材质组拆分
function splitByMaterialGroups(geometry) {
  if (!geometry.groups || geometry.groups.length <= 1) return [];
  const index = geometry.index;
  const results = [];

  for (const group of geometry.groups) {
    const faceStart = Math.floor(group.start / 3);
    const faceCount = Math.floor(group.count / 3);
    const faces = [];
    for (let f = faceStart; f < faceStart + faceCount; f++) faces.push(f);
    if (faces.length > 0) {
      const newGeo = extractFacesToGeometry(geometry, faces);
      if (newGeo) results.push({ geometry: newGeo, materialIndex: group.materialIndex || 0 });
    }
  }
  return results;
}

// 空间切分（按包围盒最长轴均分）
function splitSpatially(geometry, material, targetParts) {
  const pos = geometry.attributes.position;
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxAxis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  const axisSize = size[maxAxis];
  if (axisSize < 0.001) return [];

  const getter = maxAxis === "x" ? "getX" : maxAxis === "y" ? "getY" : "getZ";
  const index = geometry.index;
  const faceCount = index ? index.count / 3 : pos.count / 3;
  const results = [];

  for (let i = 0; i < targetParts; i++) {
    const minBound = box.min[maxAxis] + (i / targetParts) * axisSize;
    const maxBound = box.min[maxAxis] + ((i + 1) / targetParts) * axisSize;
    const faces = [];

    for (let f = 0; f < faceCount; f++) {
      const v0 = index ? index.getX(f * 3) : f * 3;
      const val = pos[getter](v0);
      if (val >= minBound && (i === targetParts - 1 ? val <= maxBound : val < maxBound)) {
        faces.push(f);
      }
    }

    if (faces.length >= 3) {
      const newGeo = extractFacesToGeometry(geometry, faces);
      if (newGeo) results.push(newGeo);
    }
  }
  return results;
}

// generatePartName 适配层：将 THREE.Box3 转换为 utils.js 需要的 {center, size} 格式
function generatePartName(index, position, bbox) {
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  return _generatePartName(index, position, { center, size });
}

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
        const newMesh = new THREE.Mesh(
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
        const newMesh = new THREE.Mesh(ccGeo, material);
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
  const bbox = new THREE.Box3();
  for (const part of splitParts) {
    const partBox = new THREE.Box3().setFromObject(part.mesh);
    bbox.union(partBox);
  }

  // 为拆分后的部件命名
  return splitParts.map((part, i) => {
    if (!part.name) {
      const pos = new THREE.Vector3();
      part.mesh.getWorldPosition(pos);
      part.name = generatePartName(i, pos, bbox);
    }
    return part;
  });
}

// ===== Blender MCP 装配顺序对接 =====
// 由 /api/assembly/sequence 获取的部件拆解顺序（名称数组，索引小者先拆）
let assemblySequenceOrder = null;

/**
 * 从后端（server.js -> Blender MCP addon）拉取装配拆解顺序。
 * @param {string} method distance|size|hierarchy
 * @returns {Promise<string[]|null>} 部件名称数组；不可用时返回 null
 */
async function fetchAssemblySequenceOrder(method = "distance") {
  try {
    const resp = await fetch(`/api/assembly/sequence?method=${encodeURIComponent(method)}`);
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
  if (typeof updateStepUI === "function") updateStepUI();
  showStatus(
    `🔧 已根据 Blender 装配分析优化拆解顺序（匹配 ${overlap.length} 个部件）`,
    "success",
  );

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
        `请确认 Blender 已启动且 MCP addon 已连接（侧栏 BlenderMCP → Connect to MCP server）。`;
      return;
    }

    const pr = data.production_readiness || {};
    const score = typeof pr.score === "number" ? pr.score : null;
    const level = pr.level || "—";
    const color = score == null ? "#888" : score >= 80 ? "#2e7d32" : score >= 55 ? "#f9a825" : "#c62828";

    const recs = Array.isArray(pr.recommendations) && pr.recommendations.length
      ? pr.recommendations.map(r => `<li>${r}</li>`).join("")
      : "<li>无明显制造风险</li>";

    const bd = pr.breakdown || {};
    const bdRows = Object.keys(bd).length
      ? `<table class="asm-table"><tr><th>扣分项</th><th>分值</th></tr>` +
        Object.entries(bd)
          .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
          .join("") +
        `</table>`
      : "";

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
  // 步骤数：欢迎(1) + 部件分组 + 完成(1)，最多 8 步
  const groupCount = Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);

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

  // 部件拆解排序：优先使用 Blender MCP 装配分析给出的顺序，
  // 否则回退到"按距离中心降序（外层先拆）"。
  let sortedParts;
  if (assemblySequenceOrder && assemblySequenceOrder.length) {
    const orderIndex = new Map(assemblySequenceOrder.map((n, i) => [n, i]));
    sortedParts = [...customParts].sort((a, b) => {
      const ia = orderIndex.has(a.name) ? orderIndex.get(a.name) : Infinity;
      const ib = orderIndex.has(b.name) ? orderIndex.get(b.name) : Infinity;
      if (ia !== ib) return ia - ib; // MCP 顺序：索引小者先拆
      // 未匹配的部件按距离中心降序回退
      const distA = (a.partCenter || a.homePos).length();
      const distB = (b.partCenter || b.homePos).length();
      return distB - distA;
    });
  } else {
    sortedParts = [...customParts].sort((a, b) => {
      const distA = (a.partCenter || a.homePos).length();
      const distB = (b.partCenter || b.homePos).length();
      return distB - distA; // 距离远的先拆
    });
  }

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

// ===== Quest 3 原始 15 部位名称及归一化位置模板 =====
// 从共享配置文件 quest3_config.json 加载，回退到内置默认值
// 坐标系: X=左右 Y=上下 Z=前后, 归一化到 [-1, 1]
// 模型包围盒: X[-1.25,1.25] Y[-0.575,1.6] Z[-0.64,0.72]
// 中心=(0, 0.5125, 0.04) 半幅=(1.25, 1.0875, 0.68)
let QUEST3_PART_TEMPLATES = [
  { name: "主机身", pos: [0.0, -0.47, -0.06] },
  { name: "前面板", pos: [0.0, -0.47, 0.75] },
  { name: "面罩海绵", pos: [0.0, -0.47, -0.87] },
  { name: "左透镜模组", pos: [-0.42, -0.43, -0.24] },
  { name: "右透镜模组", pos: [0.42, -0.43, -0.24] },
  { name: "左透镜", pos: [-0.42, -0.43, -0.56] },
  { name: "右透镜", pos: [0.42, -0.43, -0.56] },
  { name: "主板", pos: [0.0, -0.43, -0.13] },
  { name: "左摄像头", pos: [-0.6, -0.31, 0.94] },
  { name: "右摄像头", pos: [0.6, -0.31, 0.94] },
  { name: "中置摄像头", pos: [0.0, -0.21, 0.94] },
  { name: "下置追踪摄像头", pos: [0.0, -0.79, 0.82] },
  { name: "左头带臂", pos: [-1.0, -0.47, -0.06] },
  { name: "右头带臂", pos: [1.0, -0.47, -0.06] },
  { name: "头带", pos: [0.0, 0.45, -0.59] },
];

// 异步加载共享配置文件，覆盖内置默认值
fetch("quest3_config.json")
  .then(r => r.json())
  .then(cfg => {
    if (cfg.parts && cfg.parts.length > 0) {
      QUEST3_PART_TEMPLATES = cfg.parts;
      console.log(`📋 已加载 quest3_config.json (${cfg.parts.length} 个部位)`);
    }
  })
  .catch(() => {
    console.log("📋 使用内置 Quest 3 配置（quest3_config.json 不可用）");
  });

/**
 * 根据部件空间位置，将检测到的部件匹配到 Quest 3 原始 15 部位名称
 * 使用贪心最近邻匹配算法：计算所有 部件-模板 对的加权距离，
 * 按距离升序贪心分配，确保全局最优近似。
 *
 * @param {Array} parts  - customModelParts 数组，每个元素含 partCenter
 * @param {THREE.Box3} modelBox - 已居中的模型包围盒
 * @returns {string[]} 与 parts 等长的名称数组
 */
function assignQuest3PartNames(parts, modelBox) {
  if (parts.length === 0) return [];

  const size = modelBox.getSize(new THREE.Vector3());
  const halfExtents = new THREE.Vector3(
    Math.max(size.x / 2, 0.001),
    Math.max(size.y / 2, 0.001),
    Math.max(size.z / 2, 0.001),
  );

  // 将每个部件的中心位置归一化到 [-1, 1]
  const normalizedCenters = parts.map(part => {
    return new THREE.Vector3(
      part.partCenter.x / halfExtents.x,
      part.partCenter.y / halfExtents.y,
      part.partCenter.z / halfExtents.z,
    );
  });

  // 计算所有 部件-模板 对的加权距离
  const pairs = [];
  for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
    const tpl = QUEST3_PART_TEMPLATES[t];
    for (let p = 0; p < parts.length; p++) {
      const nc = normalizedCenters[p];
      const dx = nc.x - tpl.pos[0];
      const dy = nc.y - tpl.pos[1];
      const dz = nc.z - tpl.pos[2];
      // 加权距离：X、Z 权重 1.0（左右/前后更可靠），Y 权重 0.7（高度可能因头带比例变化）
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      pairs.push({ templateIdx: t, partIdx: p, dist });
    }
  }

  // 按距离升序排列，贪心匹配
  pairs.sort((a, b) => a.dist - b.dist);

  const usedParts = new Set();
  const usedTemplates = new Set();
  const assignments = new Array(parts.length).fill(null);

  for (const pair of pairs) {
    if (usedParts.has(pair.partIdx) || usedTemplates.has(pair.templateIdx)) continue;
    usedParts.add(pair.partIdx);
    usedTemplates.add(pair.templateIdx);
    assignments[pair.partIdx] = QUEST3_PART_TEMPLATES[pair.templateIdx].name;
  }

  // 未匹配到 Quest 3 模板的部件使用通用名称
  let extraIdx = 1;
  for (let i = 0; i < parts.length; i++) {
    if (!assignments[i]) {
      assignments[i] = `附加部件${extraIdx++}`;
    }
  }

  console.log(
    "🏷️ Quest 3 部件名称匹配结果:",
    parts.map((p, i) => ({
      name: assignments[i],
      center: p.partCenter.toArray().map(v => v.toFixed(2)),
    })),
  );

  return assignments;
}

// isQuest3Model 已从 src/utils.js 导入

/**
 * 合并多个 BufferGeometry 为一个（手动拼接 position/normal/uv 属性）
 * @param {THREE.BufferGeometry[]} geometries
 * @returns {THREE.BufferGeometry}
 */
function mergeGeometries(geometries) {
  if (geometries.length === 0) return new THREE.BufferGeometry();
  if (geometries.length === 1) return geometries[0].clone();

  // 统一转为非索引几何体
  const nonIndexed = geometries.map(g => (g.index ? g.toNonIndexed() : g));

  // 确定要合并的属性
  const attrNames = ["position", "normal", "uv"];
  const activeAttrs = attrNames.filter(name => nonIndexed.every(g => g.attributes[name]));

  // 计算总顶点数
  let totalVerts = 0;
  for (const g of nonIndexed) totalVerts += g.attributes.position.count;

  const merged = new THREE.BufferGeometry();
  for (const attrName of activeAttrs) {
    const itemSize = nonIndexed[0].attributes[attrName].itemSize;
    const array = new Float32Array(totalVerts * itemSize);
    let offset = 0;
    for (const g of nonIndexed) {
      const data = g.attributes[attrName].array;
      array.set(data, offset);
      offset += data.length;
    }
    merged.setAttribute(attrName, new THREE.BufferAttribute(array, itemSize));
  }

  return merged;
}

/**
 * 将拆解后的多个部件按 Quest 3 原始 15 部位模板聚类合并
 * 把属于同一 Quest 3 区域的部件几何体合并为一个 mesh
 *
 * @param {Array} splitParts - autoSplitModel 返回的数组，每项含 mesh
 * @param {THREE.Box3} modelBox - 已居中的模型包围盒
 * @returns {Array} 合并后的 splitParts（最多 15 个），每项已含 Quest 3 名称
 */
function mergePartsToQuest3(splitParts, modelBox) {
  if (splitParts.length === 0) return splitParts;

  const size = modelBox.getSize(new THREE.Vector3());
  const halfExtents = new THREE.Vector3(
    Math.max(size.x / 2, 0.001),
    Math.max(size.y / 2, 0.001),
    Math.max(size.z / 2, 0.001),
  );

  // 为每个 splitPart 找最近的 Quest 3 模板
  const groups = {}; // templateIdx -> [splitParts indices]
  for (let p = 0; p < splitParts.length; p++) {
    const mesh = splitParts[p].mesh;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());

    // 归一化到 [-1, 1]
    const nx = center.x / halfExtents.x;
    const ny = center.y / halfExtents.y;
    const nz = center.z / halfExtents.z;

    let bestT = 0,
      bestDist = Infinity;
    for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
      const tpl = QUEST3_PART_TEMPLATES[t];
      const dx = nx - tpl.pos[0];
      const dy = ny - tpl.pos[1];
      const dz = nz - tpl.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestT = t;
      }
    }

    if (!groups[bestT]) groups[bestT] = [];
    groups[bestT].push(p);
  }

  console.log(`🏷️ Quest 3 聚类: ${splitParts.length} 个部件 -> ${Object.keys(groups).length} 组`);

  // 对每组合并几何体
  const mergedParts = [];
  for (const tStr of Object.keys(groups)) {
    const t = parseInt(tStr);
    const indices = groups[t];
    const name = QUEST3_PART_TEMPLATES[t].name;

    if (indices.length === 1) {
      // 只有一个部件，直接使用
      const part = splitParts[indices[0]];
      part.name = name;
      mergedParts.push(part);
    } else {
      // 合并多个几何体
      const meshes = indices.map(i => splitParts[i].mesh);
      const geometries = meshes.map(m => {
        m.updateMatrixWorld(true);
        const geo = m.geometry.clone();
        geo.applyMatrix4(m.matrixWorld);
        return geo;
      });
      const mergedGeo = mergeGeometries(geometries);
      // 使用第一个 mesh 的材质
      const firstMesh = meshes[0];
      const material = Array.isArray(firstMesh.material) ?
        firstMesh.material[0] :
        firstMesh.material;
      const newMesh = new THREE.Mesh(mergedGeo, material);
      newMesh.position.set(0, 0, 0);
      newMesh.rotation.set(0, 0, 0);
      newMesh.scale.set(1, 1, 1);
      newMesh.matrixAutoUpdate = true;
      newMesh.matrix.identity();
      newMesh.castShadow = true;
      newMesh.receiveShadow = true;
      newMesh.name = name;
      newMesh.userData = { name };
      mergedParts.push({ mesh: newMesh, name, isOriginal: false });
    }
  }

  return mergedParts;
}

/**
 * 直接将模型几何体按面分配到 Quest 3 原始 15 个区域
 * 不经过"先拆后合"，而是对每个三角面计算其归一化中心，
 * 分配到最近的 Quest 3 模板区域，保证 15 个部位都有几何体。
 *
 * @param {THREE.Group} model - gltf.scene
 * @returns {Array} splitParts 数组，恰好 15 个（跳过完全空的）
 */
function splitModelToQuest3Regions(model) {
  // 1. 收集所有 mesh，烘焙世界变换到几何体
  const allGeometries = [];
  const allMaterials = [];
  model.traverse(child => {
    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      child.updateMatrixWorld(true);
      const geo = child.geometry.clone();
      geo.applyMatrix4(child.matrixWorld);
      allGeometries.push(geo);
      const mat = Array.isArray(child.material) ? child.material[0] : child.material;
      allMaterials.push(mat);
    }
  });

  if (allGeometries.length === 0) return [];

  // 2. 计算整体包围盒，用于归一化
  const bbox = new THREE.Box3();
  for (const geo of allGeometries) {
    geo.computeBoundingBox();
    bbox.union(geo.boundingBox);
  }
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const halfExtents = new THREE.Vector3(
    Math.max(size.x / 2, 0.001),
    Math.max(size.y / 2, 0.001),
    Math.max(size.z / 2, 0.001),
  );

  // 3. 居中所有几何体
  for (const geo of allGeometries) {
    geo.translate(-center.x, -center.y, -center.z);
  }

  // 4. 为每个面分配到最近的 Quest 3 模板
  //    templateIdx -> [{geo, faces}]
  const templateFaces = Array.from({ length: QUEST3_PART_TEMPLATES.length }, () => ({
    faces: [],
    material: null,
  }));

  const tmpCenter = new THREE.Vector3();
  const tmpV = new THREE.Vector3();

  for (let gi = 0; gi < allGeometries.length; gi++) {
    const geo = allGeometries[gi];
    const pos = geo.attributes.position;
    const index = geo.index;
    const faceCount = index ? index.count / 3 : pos.count / 3;

    for (let f = 0; f < faceCount; f++) {
      // 计算三角面中心的归一化坐标
      tmpCenter.set(0, 0, 0);
      for (let v = 0; v < 3; v++) {
        const srcIdx = index ? index.getX(f * 3 + v) : f * 3 + v;
        tmpV.fromBufferAttribute(pos, srcIdx);
        tmpCenter.add(tmpV);
      }
      tmpCenter.divideScalar(3);

      const nx = tmpCenter.x / halfExtents.x;
      const ny = tmpCenter.y / halfExtents.y;
      const nz = tmpCenter.z / halfExtents.z;

      // 找最近的 Quest 3 模板
      let bestT = 0,
        bestDist = Infinity;
      for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
        const tpl = QUEST3_PART_TEMPLATES[t];
        const dx = nx - tpl.pos[0];
        const dy = ny - tpl.pos[1];
        const dz = nz - tpl.pos[2];
        const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
        if (dist < bestDist) {
          bestDist = dist;
          bestT = t;
        }
      }

      templateFaces[bestT].faces.push({ geoIndex: gi, faceIndex: f, nx, ny, nz });
      if (!templateFaces[bestT].material) {
        templateFaces[bestT].material = allMaterials[gi];
      }
    }
  }

  // 4.5. 面重分配：对于没有分配到任何面的空模板，
  //      从最近的已占用模板中「借取」距离空模板最近的面。
  //      这解决了透镜/透镜模组、主板/主机身等位置过近导致的面被「抢走」问题。
  for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
    if (templateFaces[t].faces.length > 0) continue;

    const emptyPos = QUEST3_PART_TEMPLATES[t].pos;

    // 找到距离空模板最近的已占用模板
    let bestSourceT = -1,
      bestSourceDist = Infinity;
    for (let s = 0; s < QUEST3_PART_TEMPLATES.length; s++) {
      if (s === t || templateFaces[s].faces.length === 0) continue;
      const sPos = QUEST3_PART_TEMPLATES[s].pos;
      const dx = emptyPos[0] - sPos[0];
      const dy = emptyPos[1] - sPos[1];
      const dz = emptyPos[2] - sPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      if (dist < bestSourceDist) {
        bestSourceDist = dist;
        bestSourceT = s;
      }
    }

    if (bestSourceT === -1) continue;

    // 按到空模板的距离升序排列源模板的所有面
    const sourceFaces = templateFaces[bestSourceT].faces;
    sourceFaces.sort((a, b) => {
      const da = Math.sqrt(
        (a.nx - emptyPos[0]) ** 2 + (a.ny - emptyPos[1]) ** 2 * 0.7 + (a.nz - emptyPos[2]) ** 2,
      );
      const db = Math.sqrt(
        (b.nx - emptyPos[0]) ** 2 + (b.ny - emptyPos[1]) ** 2 * 0.7 + (b.nz - emptyPos[2]) ** 2,
      );
      return da - db;
    });

    // 借取最近的 15% 面（至少 5 个，最多 50%）
    const stealCount = Math.max(
      5,
      Math.min(Math.floor(sourceFaces.length * 0.15), Math.floor(sourceFaces.length * 0.5)),
    );
    const stolenFaces = sourceFaces.splice(0, stealCount);
    templateFaces[t].faces = stolenFaces;
    if (!templateFaces[t].material && templateFaces[bestSourceT].material) {
      templateFaces[t].material = templateFaces[bestSourceT].material;
    }

    console.log(
      `🔄 面重分配: "${QUEST3_PART_TEMPLATES[t].name}" 从 "${QUEST3_PART_TEMPLATES[bestSourceT].name}" 借取 ${stealCount} 个面`,
    );
  }

  // 5. 为每个模板创建 mesh
  const splitParts = [];
  for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
    const tf = templateFaces[t];
    if (tf.faces.length === 0) continue;

    const name = QUEST3_PART_TEMPLATES[t].name;

    // 收集属于这个模板的所有面，按源几何体分组
    const byGeo = new Map();
    for (const { geoIndex, faceIndex } of tf.faces) {
      if (!byGeo.has(geoIndex)) byGeo.set(geoIndex, []);
      byGeo.get(geoIndex).push(faceIndex);
    }

    // 提取面到新几何体
    const geometries = [];
    for (const [gi, faceIndices] of byGeo) {
      const srcGeo = allGeometries[gi];
      const newGeo = extractFacesToGeometry(srcGeo, faceIndices);
      if (newGeo && newGeo.attributes.position.count > 0) {
        geometries.push(newGeo);
      }
    }

    if (geometries.length === 0) continue;

    const mergedGeo = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
    const material = tf.material || new THREE.MeshStandardMaterial({ color: 0x888888 });
    const mesh = new THREE.Mesh(mergedGeo, material);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.matrixAutoUpdate = true;
    mesh.matrix.identity();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    mesh.userData = { name };

    splitParts.push({ mesh, name, isOriginal: false });
  }

  console.log(`🏷️ Quest 3 区域切割: ${splitParts.length} 个部件`);
  return splitParts;
}

// ===== STL 模型加载 =====
async function loadSTLModel(arrayBuffer, fileName) {
  try {
    showStatus("📦 正在解析 STL 模型...", "info");

    const STLLoaderClass = await loadSTLLoader();
    const loader = new STLLoaderClass();
    const geometry = loader.parse(arrayBuffer);

    // 清除之前的自定义模型
    clearCustomModelGroup();

    // 居中几何体
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);

    // 计算缩放使模型适配视图
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? 2.0 / maxDim : 1.0;
    geometry.scale(scale, scale, scale);

    // 创建材质和 mesh
    const material = new THREE.MeshStandardMaterial({
      color: 0x808080,
      metalness: 0.3,
      roughness: 0.7,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = fileName;

    // 计算部件中心和爆炸方向
    const partBox = new THREE.Box3().setFromObject(mesh);
    const partCenter = partBox.getCenter(new THREE.Vector3());

    customModelParts.push({
      mesh,
      homePos: new THREE.Vector3(0, 0, 0),
      explodePos: new THREE.Vector3(0, 2, 0),
      homeRot: new THREE.Euler(0, 0, 0),
      explodeRot: new THREE.Euler(0, 0, 0),
      name: fileName, // 稍后由命名步骤覆盖
      partCenter: partCenter.clone(),
      stepIndex: 1,
    });

    customModelGroup.add(mesh);

    // ========== 命名 ==========
    if (isQuest3Model(fileName)) {
      // Quest 3 模型：使用 Quest 3 原始部位名称
      const stlBox = new THREE.Box3().setFromObject(mesh);
      const stlNames = assignQuest3PartNames(customModelParts, stlBox);
      customModelParts[0].name = stlNames[0];
      customModelParts[0].mesh.userData = { name: stlNames[0] };
      customModelParts[0].mesh.name = stlNames[0];
    } else {
      // 非 Quest 3 模型：使用文件名
      customModelParts[0].name = fileName;
      customModelParts[0].mesh.userData = { name: fileName };
      customModelParts[0].mesh.name = fileName;
    }

    // 隐藏默认模型，显示自定义模型
    questGroup.visible = false;
    customModelGroup.visible = true;
    hasCustomModel = true;

    // 生成动态步骤
    stepGroups = generateCustomStepGroups(customModelParts, fileName);
    totalSteps = stepGroups.length;
    currentStep = 0;
    displayedStep = 0;
    animatingStep = 0;

    // 更新 UI
    updateCustomModelUI(1, fileName);
    if (typeof updateStepUI === "function") updateStepUI();
    showStatus(
      "✅ STL 模型加载完成（单部件）\n💡 提示: 启动 Blender 后端可获得自动拆解",
      "success",
    );

    // 若 Blender MCP 可用，尝试用装配分析优化拆解顺序（非阻塞）
    maybeApplyAssemblySequence(fileName);

    // ========== 自动放大微小的模型 ==========
    autoScaleModel("STL");

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // 默认合体状态（不自动爆炸）
    goToStep(0);
    isExploded = false;
    if (typeof explodeBtn !== "undefined") {
      explodeBtn.classList.remove("exploded");
      explodeBtn.textContent = "💥 爆炸";
    }

    console.log(`✅ STL 模型加载完成：${fileName}`);
  } catch (err) {
    console.error("STL 加载错误:", err);
    showStatus(`❌ STL 加载失败: ${err.message}`, "error");
  }
}

// ===== URDF 模型加载 =====
async function loadURDFModel(urdfText, fileName) {
  try {
    showStatus("🔍 正在解析 URDF 结构...", "info");

    // 解析 URDF XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(urdfText, "text/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      throw new Error("URDF XML 解析错误");
    }

    // 提取所有 links
    const linkEls = doc.querySelectorAll("link");
    if (linkEls.length === 0) {
      throw new Error("URDF 中未找到任何 link");
    }

    // 提取所有 joints（建立父子关系）
    const jointEls = doc.querySelectorAll("joint");
    const jointMap = {}; // child_link_name -> joint info
    jointEls.forEach(joint => {
      const jointType = joint.getAttribute("type") || "fixed";
      const parent = joint.querySelector("parent")?.getAttribute("link");
      const child = joint.querySelector("child")?.getAttribute("link");
      const origin = joint.querySelector("origin");
      const originXYZ = origin?.getAttribute("xyz")?.trim().split(/\s+/)
        .map(parseFloat) || [
        0, 0, 0,
      ];
      const originRPY = origin?.getAttribute("rpy")?.trim().split(/\s+/)
        .map(parseFloat) || [
        0, 0, 0,
      ];
      const jointName = joint.getAttribute("name") || "joint";
      if (child) {
        jointMap[child] = {
          parent,
          child,
          type: jointType,
          xyz: originXYZ,
          rpy: originRPY,
          name: jointName,
        };
      }
    });

    // ── 辅助函数：从 xyz + rpy 构建 4×4 变换矩阵 ──
    function makeTransform(xyz, rpy) {
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3(xyz[0], xyz[1], xyz[2]);
      const euler = new THREE.Euler(rpy[0], rpy[1], rpy[2], "ZYX");
      const quat = new THREE.Quaternion().setFromEuler(euler);
      m.compose(pos, quat, new THREE.Vector3(1, 1, 1));
      return m;
    }

    // ── 递归计算每个 link 的世界变换矩阵 ──
    const linkWorldMatrix = {};
    function computeLinkWorldMatrix(linkName) {
      if (linkWorldMatrix[linkName]) return linkWorldMatrix[linkName];
      if (!jointMap[linkName]) {
        linkWorldMatrix[linkName] = new THREE.Matrix4();
        return linkWorldMatrix[linkName];
      }
      const joint = jointMap[linkName];
      const parentWorld = computeLinkWorldMatrix(joint.parent);
      const jointTransform = makeTransform(joint.xyz, joint.rpy);
      const world = new THREE.Matrix4().multiplyMatrices(parentWorld, jointTransform);
      linkWorldMatrix[linkName] = world;
      return world;
    }

    // 预计算所有 link 的世界变换
    linkEls.forEach(linkEl => {
      const name = linkEl.getAttribute("name");
      if (name) computeLinkWorldMatrix(name);
    });

    // 清除之前的自定义模型
    clearCustomModelGroup();

    // ── 为每个 link 创建 mesh，变换烘焙到几何体 ──
    const splitParts = [];
    let partIndex = 0;

    linkEls.forEach(linkEl => {
      const linkName = linkEl.getAttribute("name") || `link_${partIndex}`;

      // 获取 visual geometry 信息
      const visual = linkEl.querySelector("visual");
      const geometryEl = visual?.querySelector("geometry");
      const meshEl = geometryEl?.querySelector("mesh");
      const meshFile = meshEl?.getAttribute("filename") || "";

      // 获取 visual origin
      const visOrigin = visual?.querySelector("origin");
      const visXYZ = visOrigin?.getAttribute("xyz")?.trim().split(/\s+/)
        .map(parseFloat) || [
        0, 0, 0,
      ];
      const visRPY = visOrigin?.getAttribute("rpy")?.trim().split(/\s+/)
        .map(parseFloat) || [
        0, 0, 0,
      ];

      // 获取 box/cylinder/sphere 尺寸
      const boxEl = geometryEl?.querySelector("box");
      const cylEl = geometryEl?.querySelector("cylinder");
      const sphereEl = geometryEl?.querySelector("sphere");

      // 创建几何体
      let geometry;
      if (boxEl) {
        const size = boxEl.getAttribute("size")?.trim().split(/\s+/)
          .map(parseFloat) || [
          0.1, 0.1, 0.1,
        ];
        geometry = new THREE.BoxGeometry(size[0] || 0.1, size[1] || 0.1, size[2] || 0.1);
      } else if (cylEl) {
        const radius = parseFloat(cylEl.getAttribute("radius")) || 0.05;
        const length = parseFloat(cylEl.getAttribute("length")) || 0.1;
        geometry = new THREE.CylinderGeometry(radius, radius, length, 32);
        geometry.rotateX(Math.PI / 2); // URDF 圆柱沿 Z 轴
      } else if (sphereEl) {
        const radius = parseFloat(sphereEl.getAttribute("radius")) || 0.05;
        geometry = new THREE.SphereGeometry(radius, 32, 24);
      } else {
        geometry = new THREE.BoxGeometry(0.08, 0.08, 0.08);
      }

      // 计算 visual 的世界变换矩阵 = link世界 × visual origin
      const linkWorld = linkWorldMatrix[linkName] || new THREE.Matrix4();
      const visLocal = makeTransform(visXYZ, visRPY);
      const visWorld = new THREE.Matrix4().multiplyMatrices(linkWorld, visLocal);

      // 烘焙世界变换到几何体（与 GLB 一致）
      geometry.applyMatrix4(visWorld);

      // 创建材质
      const hue = (partIndex * 137.5) % 360;
      const color = new THREE.Color().setHSL(hue / 360, 0.6, 0.5);
      const material = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.3,
        roughness: 0.6,
      });

      // mesh 归零（变换已烘焙到几何体）
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = linkName;
      mesh.userData = { name: linkName, isURDF: true, meshFile };

      splitParts.push({ mesh, name: linkName, isOriginal: true });
      partIndex++;
    });

    // ========== 计算模型中心，将几何体居中 ==========
    const modelBox = new THREE.Box3();
    for (const part of splitParts) {
      const partBox = new THREE.Box3().setFromObject(part.mesh);
      modelBox.union(partBox);
    }
    const modelCenter = modelBox.getCenter(new THREE.Vector3());

    for (const part of splitParts) {
      part.mesh.geometry.translate(-modelCenter.x, -modelCenter.y, -modelCenter.z);
    }

    // ========== Quest 3 模型：按 15 部位聚类合并 ==========
    const isQ3URDF = isQuest3Model(fileName);
    if (isQ3URDF && splitParts.length > 15) {
      showStatus("🔧 Quest 3 模型：按 15 部位聚类合并...", "info");
      const merged = mergePartsToQuest3(splitParts, modelBox);
      splitParts.length = 0;
      splitParts.push(...merged);
      console.log(`✅ Quest 3 URDF 合并完成：${splitParts.length} 个部件`);
    }

    // ========== 创建部件数据 ==========
    for (let i = 0; i < splitParts.length; i++) {
      const mesh = splitParts[i].mesh;

      // 计算部件中心（相对于模型中心，即原点）
      const partBox = new THREE.Box3().setFromObject(mesh);
      const partCenter = partBox.getCenter(new THREE.Vector3());

      // 爆炸方向：从模型中心指向部件中心
      const explodePos = calculateExplodePos(partCenter, i, splitParts.length);

      customModelParts.push({
        mesh,
        homePos: new THREE.Vector3(0, 0, 0),
        explodePos,
        homeRot: new THREE.Euler(0, 0, 0),
        explodeRot: new THREE.Euler(0, 0, 0),
        name: splitParts[i].name,
        partCenter: partCenter.clone(),
        stepIndex: 1,
      });

      customModelGroup.add(mesh);
    }

    // ========== 按距离中心排序（外层先拆）==========
    customModelParts.sort((a, b) => b.partCenter.length() - a.partCenter.length());

    // ========== 分配步骤索引 ==========
    const partCount = customModelParts.length;
    const groupCount = Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);
    const partsPerGroup = Math.ceil(partCount / groupCount);

    // 重新计算包围盒（已居中）
    const centeredBoxURDF = new THREE.Box3();
    for (const part of customModelParts) {
      centeredBoxURDF.union(new THREE.Box3().setFromObject(part.mesh));
    }

    // ========== 命名 ==========
    if (isQ3URDF) {
      // Quest 3 模型：使用 Quest 3 原始 15 部位名称
      const quest3NamesURDF = assignQuest3PartNames(customModelParts, centeredBoxURDF);
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        part.name = quest3NamesURDF[i];
        part.mesh.userData = { name: part.name, isURDF: true };
        part.mesh.name = part.name;
      });
    } else {
      // 非 Quest 3 模型：使用 URDF link 原始名称
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        part.mesh.userData = { name: part.name, isURDF: true };
        part.mesh.name = part.name;
      });
    }

    hasCustomModel = true;

    // 隐藏默认模型
    questGroup.visible = false;
    customModelGroup.visible = true;

    // 套用当前外观风格（乐高 / 原生）
    applyModelStyle(currentModelStyle);

    // 生成动态步骤
    stepGroups = generateCustomStepGroups(customModelParts, fileName);
    totalSteps = stepGroups.length;
    currentStep = 0;
    displayedStep = 0;
    animatingStep = 0;

    // 更新 UI
    updateCustomModelUI(partCount, fileName);
    updateStepUI();

    const meshNote =
      partCount > 0 && splitParts[0]?.mesh?.userData?.meshFile ?
        `\n⚠️ 注意: URDF 引用的 mesh 文件 (${splitParts[0].mesh.userData.meshFile}) 需单独上传\n当前使用占位几何体` :
        "";
    showStatus(`✅ URDF 解析完成：${partCount} 个 link（部件）${meshNote}`, "success");

    // 若 Blender MCP 可用，尝试用装配分析优化拆解顺序（非阻塞）
    maybeApplyAssemblySequence(fileName);

    // ========== 自动放大微小的模型 ==========
    autoScaleModel("URDF");

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // ========== 智能调整爆炸距离 ==========
    adjustSmartExplodeDistances();

    // 默认合体状态（不自动爆炸）
    goToStep(0);
    isExploded = false;
    explodeBtn.classList.remove("exploded");
    explodeBtn.textContent = "💥 爆炸";

    console.log(`✅ URDF 模型加载完成：${partCount} 个部件`);
  } catch (err) {
    console.error("URDF 加载错误:", err);
    showStatus(`❌ URDF 解析失败: ${err.message}`, "error");
  }
}

async function loadCustomModel(arrayBuffer, fileName, blenderManifest = null) {
  try {
    const splitMethod = blenderManifest ? "Blender CLI" : "前端 JS";
    showStatus(`📦 正在解析模型（${splitMethod}）...`, "info");

    const LoaderClass = await loadGLTFLoader();
    const loader = new LoaderClass();

    const gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, "", resolve, err => reject(new Error("解析失败：" + err.message)));
    });

    // 清除之前的自定义模型
    clearCustomModelGroup();
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

    if (splitParts.length === 0) {
      throw new Error("模型中未找到可渲染的网格");
    }

    // ========== 烘焙世界矩阵到几何体（非前端 Quest 3 路径需要）==========
    if (!(isQ3 && !blenderManifest)) {
      for (const part of splitParts) {
        const mesh = part.mesh;
        mesh.updateMatrixWorld(true);
        mesh.geometry.applyMatrix4(mesh.matrixWorld);
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(0, 0, 0);
        mesh.scale.set(1, 1, 1);
        mesh.matrixAutoUpdate = true;
        mesh.matrix.identity();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }

      // 计算模型中心，将几何体居中
      const modelBox = new THREE.Box3();
      for (const part of splitParts) {
        const partBox = new THREE.Box3().setFromObject(part.mesh);
        modelBox.union(partBox);
      }
      const modelCenter = modelBox.getCenter(new THREE.Vector3());
      for (const part of splitParts) {
        part.mesh.geometry.translate(-modelCenter.x, -modelCenter.y, -modelCenter.z);
      }
    }

    // ========== 创建部件数据 ==========
    for (let i = 0; i < splitParts.length; i++) {
      const mesh = splitParts[i].mesh;

      // 计算部件中心（相对于模型中心，即原点）
      const partBox = new THREE.Box3().setFromObject(mesh);
      const partCenter = partBox.getCenter(new THREE.Vector3());

      // 爆炸方向：从模型中心指向部件中心
      const explodePos = calculateExplodePos(partCenter, i, splitParts.length);

      customModelParts.push({
        mesh,
        homePos: new THREE.Vector3(0, 0, 0),
        explodePos,
        homeRot: new THREE.Euler(0, 0, 0),
        explodeRot: new THREE.Euler(0, 0, 0),
        name: "", // 稍后分配
        partCenter: partCenter.clone(),
        stepIndex: 1,
      });

      customModelGroup.add(mesh);
    }

    // ========== 按距离中心排序（外层先拆）==========
    // 如果有 Blender 清单，按清单顺序排列；否则按距离排序
    if (blenderManifest && blenderManifest.parts) {
      // 清单已按距离降序排列，直接使用清单顺序
      const manifestOrder = blenderManifest.parts.map((p, idx) => ({
        name: p.display_name || p.name,
        idx,
      }));
      // 按 manifest 顺序重排 customModelParts（根据 partCenter 匹配）
      const used = new Set();
      const reordered = [];
      for (const mp of manifestOrder) {
        // 用 center 匹配
        const targetCenter = blenderManifest.parts[mp.idx].center;
        let bestIdx = -1,
          bestDist = Infinity;
        for (let i = 0; i < customModelParts.length; i++) {
          if (used.has(i)) continue;
          const d = customModelParts[i].partCenter.distanceTo(
            new THREE.Vector3(targetCenter[0], targetCenter[1], targetCenter[2]),
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
      // 补充未匹配的
      for (let i = 0; i < customModelParts.length; i++) {
        if (!used.has(i)) reordered.push(customModelParts[i]);
      }
      customModelParts.length = 0;
      customModelParts.push(...reordered);
    } else {
      customModelParts.sort((a, b) => b.partCenter.length() - a.partCenter.length());
    }

    // ========== 分配步骤索引和名称 ==========
    const partCount = customModelParts.length;
    const groupCount = Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);
    const partsPerGroup = Math.ceil(partCount / groupCount);

    // 重新计算包围盒（已居中）
    const centeredBox = new THREE.Box3();
    for (const part of customModelParts) {
      centeredBox.union(new THREE.Box3().setFromObject(part.mesh));
    }

    // ========== 命名 ==========
    if (isQ3 && blenderManifest && blenderManifest.parts) {
      // Quest 3 模型 + Blender 清单：使用 Blender 分配的名称
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        if (blenderManifest.parts[i]) {
          part.name =
            blenderManifest.parts[i].display_name ||
            blenderManifest.parts[i].name ||
            `部件${i + 1}`;
        }
        part.mesh.userData = { name: part.name };
        part.mesh.name = part.name;
      });
    } else if (isQ3) {
      // Quest 3 模型 + 前端拆解：splitModelToQuest3Regions 已分配名称
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        const origName = splitParts.find(sp => sp.mesh === part.mesh)?.name;
        if (origName) part.name = origName;
        part.mesh.userData = { name: part.name };
        part.mesh.name = part.name;
      });
    } else {
      // 非 Quest 3 模型：Blender 清单名称 → GLB 原始名称 → 位置生成名称
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        if (blenderManifest && blenderManifest.parts && blenderManifest.parts[i]) {
          part.name =
            blenderManifest.parts[i].display_name ||
            blenderManifest.parts[i].name ||
            `部件${i + 1}`;
        } else {
          const origName = splitParts.find(sp => sp.mesh === part.mesh)?.name;
          if (origName && !origName.startsWith("部件")) {
            part.name = origName;
          } else {
            part.name = generatePartName(i, part.partCenter, centeredBox);
          }
        }
        part.mesh.userData = { name: part.name };
        part.mesh.name = part.name;
      });
    }

    hasCustomModel = true;

    // ========== 生成动态步骤 ==========
    stepGroups = generateCustomStepGroups(customModelParts, fileName);
    totalSteps = stepGroups.length;

    // 重置步骤状态
    currentStep = 0;
    displayedStep = 0;
    animatingStep = 0;

    // 更新 UI
    updateCustomModelUI(partCount, fileName);
    updateStepUI();
    showStatus(`✅ 成功加载：${fileName}\n自动拆分为 ${partCount} 个部件`, "success");

    // ========== 自动放大微小的模型 ==========
    autoScaleModel();

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // ========== 智能调整爆炸距离 ==========
    adjustSmartExplodeDistances();

    // 若 Blender MCP 可用，尝试用装配分析优化拆解顺序（非阻塞）
    maybeApplyAssemblySequence(fileName);

    // 默认合体状态（不自动爆炸）
    goToStep(0);
    isExploded = false;
    explodeBtn.classList.remove("exploded");
    explodeBtn.textContent = "💥 爆炸";

    console.log(`✅ 自定义模型加载完成：${partCount} 个部件（自动拆分，${groupCount} 个步骤组）`);
  } catch (err) {
    console.error("加载模型失败：", err);
    showStatus(`❌ 加载失败：${err.message}`, "error");
    // 加载失败：恢复默认模型可见，并清除可能已部分添加的自定义模型，避免与主模型叠加
    clearCustomModelGroup();
    questGroup.visible = true;
    hasCustomModel = false;
  }
}

function updateCustomModelUI(partCount, fileName) {
  const countEl = document.getElementById("part-count");
  if (countEl) countEl.textContent = partCount;

  const uploadSection = document.querySelector(".panel");
  // 通用查找逻辑，适应新旧 HTML 结构
  const uploadSectionAlt = document.querySelector("details.panel");
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
    customModelParts.forEach((part, i) => {
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
  updateStepUI();
  fitCameraToModel(questGroup, false);

  showStatus("已清除自定义模型，恢复默认", "info");
  console.log("✅ 已恢复默认 Quest 3 模型和步骤系统");
}

// ===== 中心轴线（拆解时显示）=====
const axisGeo = new THREE.CylinderGeometry(0.01, 0.01, 4, 8);
axisGeo.rotateX(Math.PI / 2);
const axisMat = new THREE.MeshBasicMaterial({ color: 0x44464f, transparent: true, opacity: 0 });
const axisLine = new THREE.Mesh(axisGeo, axisMat);
questGroup.add(axisLine);

// quest3Specs 已从 ./src/quest3-data.js 导入

// 自动适配相机到默认模型
fitCameraToModel(questGroup, false);

// ===== 分步骤拆解（教学导向，参考 iFixit 风格）=====
// defaultStepGroups 已从 ./src/quest3-steps.js 导入
let stepGroups = defaultStepGroups;

// 工具清单更新
function updateToolsList(step) {
  if (!toolsListEl) return;

  const stepIndex = stepGroups.indexOf(step);
  const tools = step.tools || [];

  if (tools.length === 0) {
    toolsListEl.innerHTML = "<div class=\"tools-none\">✅ 本步骤无需工具</div>";
  } else {
    toolsListEl.innerHTML = tools.map(tool => `<div class="tool-item">${tool}</div>`).join("");
  }
}

// defaultStepGroups 已从 ./src/quest3-steps.js 导入
let totalSteps = stepGroups.length;
const partStepMap = new Map();

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

// ===== 步骤控制 UI =====
let currentStep = 0; // 实际显示步骤（动画中）
let displayedStep = 0; // 当前 UI 显示的步骤（已完成）
let animatingStep = 0; // 动画目标步骤
let animationStart = 0; // 动画开始时间
let animationFrom = 0; // 动画起始步骤
let mouseFactor = 0; // 鼠标控制炸开因子 (0-1)
let mouseControlEnabled = false; // 是否启用鼠标控制
const stepDuration = 600; // 每步动画时长（毫秒）
let isAnimating = false;

// ===== 一键爆炸/合体的平滑动画（所有部件同时炸开/合体）=====
let explodeAnimActive = false;   // 是否正在播放爆炸/合体动画
let explodeAnimFrom = 0;         // 起始全局炸开因子 (0=合体, 1=完全炸开)
let explodeAnimTo = 0;           // 目标全局炸开因子
let explodeAnimStart = 0;        // 动画开始时间戳
let explodeAnimFactor = 0;       // 当前全局炸开因子
let explodeAllMode = false;      // true 时所有部件按同一因子同时炸开（忽略分步）
let explodeAnimDuration = 1100;  // 爆炸动画时长（毫秒，受循环速度档控制）
let loopHoldMs = 900;            // 循环播放时炸开/合体之间的停留时间（毫秒）
let explodeLoop = false;         // 爆炸/合体动画是否自动循环播放
let explodeLoopTimer = null;     // 循环反向定时器，便于手动接管时取消

const prevBtn = document.getElementById("prev-step");
const nextBtn = document.getElementById("next-step");
const resetBtn = document.getElementById("reset-step");
const stepNumberEl = document.getElementById("step-number");
const stepNameEl = document.getElementById("step-name");
const stepDescEl = document.getElementById("step-desc");
const progressFillEl = document.getElementById("progress-fill");
const autoRotateCheck = document.getElementById("auto-rotate");

// 新增 UI 元素
const depthSlider = document.getElementById("explode-depth");
const depthValueEl = document.getElementById("depth-value");
const timelineSlider = document.getElementById("timeline-slider");
const timelineStepEl = document.getElementById("timeline-step");
const timelineTotalEl = document.getElementById("timeline-total");
const timelinePlayBtn = document.getElementById("timeline-play");
const timelineResetBtn = document.getElementById("timeline-reset");
const timelineSpeedSelect = document.getElementById("timeline-speed");
const toolsListEl = document.getElementById("tools-list");
const partTooltip = document.getElementById("part-tooltip");
const tooltipTitle = document.querySelector(".tooltip-title");
const tooltipContent = document.querySelector(".tooltip-content");

console.log("UI elements:", {
  prevBtn: !!prevBtn,
  nextBtn: !!nextBtn,
  resetBtn: !!resetBtn,
  stepNumberEl: !!stepNumberEl,
  stepNameEl: !!stepNameEl,
  stepDescEl: !!stepDescEl,
  progressFillEl: !!progressFillEl,
  autoRotateCheck: !!autoRotateCheck,
});

// easeOutCubic 已从 src/utils.js 导入

// 部件高亮相关
const highlightEmissive = new THREE.Color(0x4a9eff);
const highlightScale = 1.08;
let highlightedPart = null; // 当前高亮的部件

function highlightPart(partName) {
  // 清除之前的高亮
  if (highlightedPart) {
    if (highlightedPart.mesh.material && highlightedPart.mesh.material.emissive) {
      highlightedPart.mesh.material.emissive.setHex(0x000000);
    }
    highlightedPart.mesh.scale.setScalar(1);
  }

  // 设置新高亮
  if (partName) {
    // 先在默认部件中查找
    let part = parts.find(p => p.name === partName);
    // 如果没找到且正在使用自定义模型，在自定义部件中查找
    if (!part && hasCustomModel) {
      part = customModelParts.find(p => p.name === partName);
    }
    if (part) {
      highlightedPart = part;
      if (part.mesh.material && part.mesh.material.emissive) {
        part.mesh.material.emissive.copy(highlightEmissive);
      }
      part.mesh.scale.setScalar(highlightScale);
    }
  } else {
    highlightedPart = null;
  }
}

// ===== 部件信息卡片 =====
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredPart = null;

// partInfo 已从 ./src/quest3-data.js 导入

// 显示工具提示
function showTooltip(partName, x, y) {
  if (!partTooltip || !tooltipTitle || !tooltipContent) return;

  const info = partInfo[partName];
  if (!info) return;

  tooltipTitle.textContent = info.name;
  tooltipContent.innerHTML = `
    <div style="margin-bottom: 6px;"><strong>材质:</strong> ${info.material}</div>
    <div style="margin-bottom: 6px;"><strong>重量:</strong> ${info.weight}</div>
    <div style="margin-bottom: 6px;"><strong>功能:</strong> ${info.function}</div>
    <div style="margin-bottom: 6px;"><strong>规格:</strong> ${info.specs}</div>
    <div style="color: #8f7aff; font-style: italic; margin-top: 8px;">💡 ${info.funFact}</div>
  `;

  // 定位工具提示
  partTooltip.style.left = `${x + 15}px`;
  partTooltip.style.top = `${y + 15}px`;
  partTooltip.classList.remove("hidden");
}

// 隐藏工具提示
function hideTooltip() {
  if (partTooltip) {
    partTooltip.classList.add("hidden");
  }
}

function updateStepUI() {
  // 在鼠标控制模式下，显示当前的鼠标控制步骤
  const displayStep = mouseControlEnabled ? Math.round(mouseFactor * totalSteps) : displayedStep;
  stepNumberEl.textContent = `步骤 ${displayStep} / ${totalSteps}`;
  stepNameEl.textContent = stepGroups[Math.min(displayStep, totalSteps - 1)].name;

  // 更新步骤说明
  const stepIndex = Math.min(displayStep, totalSteps - 1);
  const step = stepGroups[stepIndex];
  if (step && stepDescEl) {
    stepDescEl.innerHTML = step.description || "";
  }

  // 更新工具清单
  updateToolsList(step);

  // 更新部件高亮
  if (step && step.parts.length > 0) {
    highlightPart(step.parts[0]);
  } else {
    highlightPart(null);
  }

  progressFillEl.style.width = `${(displayStep / totalSteps) * 100}%`;

  // 动画过程中禁用按钮，防止连续点击导致步骤混乱
  prevBtn.disabled = isAnimating || (mouseControlEnabled ? false : displayedStep <= 0);
  nextBtn.disabled = isAnimating || (mouseControlEnabled ? false : displayedStep >= totalSteps);
  resetBtn.disabled = isAnimating || mouseControlEnabled;

  // 更新时间轴
  if (timelineSlider) {
    timelineSlider.value = displayStep;
    timelineStepEl.textContent = displayStep;
  }
}

// 退出鼠标控制模式，将当前 mouseFactor 同步到 currentStep/displayedStep
function exitMouseControl() {
  mouseControlEnabled = false;
  needsExplodeUpdate = true; // 标记需要重新计算
  isExploded = false;
  explodeBtn?.classList.remove("exploded");
  if (explodeBtn) explodeBtn.textContent = "💥 爆炸";
  // 把 mouseFactor 对应的步骤同步到 displayedStep，保证动画从当前位置开始
  displayedStep = Math.round(mouseFactor * totalSteps);
  currentStep = mouseFactor * totalSteps;
}

function goToStep(newStep) {
  newStep = THREE.MathUtils.clamp(newStep, 0, totalSteps);
  if (newStep === displayedStep || isAnimating) return;

  stopExplodeLoop(); // 手动分步控制接管，停止循环播放
  needsExplodeUpdate = true; // 标记需要重新计算部件位置
  animationFrom = currentStep;
  animatingStep = newStep;
  animationStart = performance.now();
  isAnimating = true;
  updateStepUI();
}

function finishAnimation() {
  isAnimating = false;
  currentStep = animatingStep;
  displayedStep = animatingStep;
  updateStepUI();
}

// 时间轴控制
let isPlaying = false;
let playInterval = null;

if (timelineSlider) {
  timelineSlider.addEventListener("input", e => {
    if (mouseControlEnabled) exitMouseControl();
    const step = parseInt(e.target.value);
    goToStep(step);
  });
}

if (timelinePlayBtn) {
  timelinePlayBtn.addEventListener("click", () => {
    if (mouseControlEnabled) exitMouseControl();
    if (isPlaying) {
      // 暂停
      clearInterval(playInterval);
      isPlaying = false;
      timelinePlayBtn.textContent = "▶️ 播放";
    } else {
      // 播放
      isPlaying = true;
      timelinePlayBtn.textContent = "⏸️ 暂停";

      const speed = parseFloat(timelineSpeedSelect?.value || 1);
      const interval = 700 / speed; // 每步时间

      playInterval = setInterval(() => {
        if (displayedStep >= totalSteps) {
          clearInterval(playInterval);
          isPlaying = false;
          timelinePlayBtn.textContent = "▶️ 播放";
          return;
        }
        goToStep(displayedStep + 1);
      }, interval);
    }
  });
}

if (timelineResetBtn) {
  timelineResetBtn.addEventListener("click", () => {
    if (mouseControlEnabled) exitMouseControl();
    if (isPlaying) {
      clearInterval(playInterval);
      isPlaying = false;
      timelinePlayBtn.textContent = "▶️ 播放";
    }
    goToStep(0);
  });
}

// 移动端检测
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

if (isMobile) {
  // 移动端优化
  document.body.classList.add("mobile-device");

  // 调整相机距离
  camera.position.set(3, 1.5, 4);
  controls.minDistance = 1.5;
  controls.maxDistance = 10;

  // 触摸优化
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
}

// 点击步骤按钮时，自动退出鼠标控制模式，让步骤动画接管
prevBtn.addEventListener("click", () => {
  if (mouseControlEnabled) exitMouseControl();
  goToStep(displayedStep - 1);
});
nextBtn.addEventListener("click", () => {
  if (mouseControlEnabled) exitMouseControl();
  goToStep(displayedStep + 1);
});
resetBtn.addEventListener("click", () => {
  if (mouseControlEnabled) exitMouseControl();
  goToStep(0);
});

// 爆炸按钮：在完全合体和完全爆炸之间切换
const explodeBtn = document.getElementById("explode-btn");
let isExploded = false;

// 装配分析面板按钮
const assemblyAnalyzeBtn = document.getElementById("assembly-analyze-btn");
if (assemblyAnalyzeBtn) {
  assemblyAnalyzeBtn.addEventListener("click", () => runAssemblyAnalysis());
}

function toggleExplode() {
  isExploded = !isExploded;
  // 退出其它控制模式，由本次爆炸动画接管
  mouseControlEnabled = false;
  explodeAllMode = true;
  isAnimating = false;
  clearInterval(playInterval);
  if (timelinePlayBtn) timelinePlayBtn.textContent = "▶️ 播放";
  isPlaying = false;

  if (isExploded) {
    // 进入爆炸模式：所有部件平滑炸开到完全展开
    explodeBtn.classList.add("exploded");
    explodeBtn.textContent = "🔄 合体";
    explodeAnimFrom = explodeAnimFactor; // 从当前状态开始
    explodeAnimTo = 1;
  } else {
    // 退出爆炸模式：所有部件平滑合体
    explodeBtn.classList.remove("exploded");
    explodeBtn.textContent = "💥 爆炸";
    explodeAnimFrom = explodeAnimFactor;
    explodeAnimTo = 0;
  }
  explodeAnimStart = performance.now();
  explodeAnimActive = true;
  needsExplodeUpdate = true;
  updateStepUI();
}

explodeBtn.addEventListener("click", toggleExplode);

// ===== 爆炸循环播放 =====
const explodeLoopBtn = document.getElementById("explode-loop");
const explodeLoopSpeed = document.getElementById("explode-loop-speed");

// 更新循环按钮的视觉状态
function setExplodeLoopUI() {
  if (!explodeLoopBtn) return;
  explodeLoopBtn.classList.toggle("active", explodeLoop);
  explodeLoopBtn.textContent = explodeLoop ? "🔁 循环中" : "🔁 循环";
}

// 停止循环播放，并切回分步/滑块控制
function stopExplodeLoop() {
  explodeLoop = false;
  if (explodeLoopTimer) {
    clearTimeout(explodeLoopTimer);
    explodeLoopTimer = null;
  }
  explodeAnimActive = false; // 中止进行中的循环动画
  explodeAllMode = false;
  setExplodeLoopUI();
}

if (explodeLoopBtn) {
  explodeLoopBtn.addEventListener("click", () => {
    explodeLoop = !explodeLoop;
    if (explodeLoop && !isExploded) {
      // 开启循环且当前为合体状态，立即开始炸开并循环
      setExplodeLoopUI();
      toggleExplode();
    } else if (explodeLoop) {
      // 已是炸开状态，继续循环（先合体再往复）
      setExplodeLoopUI();
    } else {
      // 关闭循环：停在当前状态
      stopExplodeLoop();
    }
  });
}

// 循环速度档：影响动画时长与炸开/合体之间的停留时间
if (explodeLoopSpeed) {
  explodeLoopSpeed.addEventListener("change", e => {
    const v = parseFloat(e.target.value) || 1;
    explodeAnimDuration = Math.round(1100 / v);
    loopHoldMs = Math.round(900 / v);
  });
}

// 从生成库加载已拆解模型（models/generated/）
const generatedSelect = document.getElementById("generated-select");
const generatedLoadBtn = document.getElementById("generated-load");
if (generatedSelect && generatedLoadBtn) {
  fetch("/api/generated")
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
    .catch(() => { /* 忽略：无生成库时不展示 */ });

  generatedLoadBtn.addEventListener("click", async () => {
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

// 爆炸深度滑块
if (depthSlider && depthValueEl) {
  depthSlider.addEventListener("input", e => {
    const depth = parseInt(e.target.value);
    depthValueEl.textContent = `${depth}%`;

    // 退出鼠标/整体炸开控制模式，让滑块接管
    if (mouseControlEnabled) exitMouseControl();
    stopExplodeLoop(); // 深度滑块接管，停止循环播放

    // 计算炸开因子 (0-1)
    const factor = depth / 100;

    // 如果不在动画中，直接应用
    if (!isAnimating) {
      needsExplodeUpdate = true; // 标记需要重新计算
      currentStep = factor * totalSteps;
      displayedStep = Math.round(currentStep);
      explodeAnimFactor = factor; // 同步整体炸开因子，供后续动画续接
      updateStepUI();
    }

    // 更新爆炸状态
    if (depth > 0 && !isExploded) {
      isExploded = true;
      explodeBtn.classList.add("exploded");
      explodeBtn.textContent = "🔄 合体";
    } else if (depth === 0 && isExploded) {
      isExploded = false;
      explodeBtn.classList.remove("exploded");
      explodeBtn.textContent = "💥 爆炸";
    }
  });
}

// 键盘快捷键
document.addEventListener("keydown", e => {
  // 忽略在输入框中的按键
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  switch (e.key) {
    case "ArrowRight":
      e.preventDefault();
      goToStep(displayedStep + 1);
      break;
    case "ArrowLeft":
      e.preventDefault();
      goToStep(displayedStep - 1);
      break;
    case " ":
      e.preventDefault();
      toggleExplode();
      break;
    case "r":
    case "R":
      e.preventDefault();
      goToStep(0);
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
      focusCurrentPart();
      break;
  }
});

// 聚焦当前步骤的部件
function focusCurrentPart() {
  const step = stepGroups[Math.min(displayedStep, totalSteps - 1)];
  if (!step || step.parts.length === 0) return;

  // 找到第一个部件的位置
  const partName = step.parts[0];
  let part = parts.find(p => p.name === partName);
  if (!part && hasCustomModel) {
    part = customModelParts.find(p => p.name === partName);
  }
  if (!part) return;

  // 平滑移动相机到部件位置
  const targetPos = part.mesh.position.clone();
  const cameraOffset = new THREE.Vector3(2, 1.5, 2);
  const newCameraPos = targetPos.clone().add(cameraOffset);

  // 简单的动画
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const duration = 800;
  const startTime = performance.now();

  function animateCamera(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);

    camera.position.lerpVectors(startPos, newCameraPos, eased);
    controls.target.lerpVectors(startTarget, targetPos, eased);

    if (progress < 1) {
      requestAnimationFrame(animateCamera);
    }
  }

  requestAnimationFrame(animateCamera);
}

// 鼠标移动控制炸开范围
renderer.domElement.addEventListener("mousemove", e => {
  if (!mouseControlEnabled) return;

  stopExplodeLoop(); // 鼠标接管，停止循环播放

  // 计算鼠标在屏幕上的相对位置（0-1）
  const el = renderer && renderer.domElement;
  if (!el) return; // 渲染器/画布尚未就绪（预览或 WebGL 不可用时）时安全跳过
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;

  // 使用鼠标Y轴位置控制炸开范围：鼠标越往下，炸开越大
  // 加上鼠标X轴影响，让控制更有趣
  mouseFactor = Math.max(0.1, y * 1.2); // 最小保持 0.1 的炸开
  explodeAnimFactor = mouseFactor; // 同步整体炸开因子，供后续动画续接

  // 更新当前步骤显示
  currentStep = mouseFactor * totalSteps;
  displayedStep = Math.round(currentStep);
  updateStepUI();
});

// 鼠标离开画布时，保持当前炸开程度
renderer.domElement.addEventListener("mouseleave", () => {
  if (mouseControlEnabled) {
    // 可选：鼠标离开时暂停控制
    // mouseControlEnabled = false;
  }
});

// 双击恢复按钮控制
explodeBtn.addEventListener("dblclick", () => {
  if (isExploded) {
    mouseControlEnabled = false;
    explodeBtn.textContent = "🔄 合体";
    console.log("已切换回按钮控制模式");
  }
});

autoRotateCheck.addEventListener("change", e => {
  controls.autoRotate = e.target.checked;
});

updateStepUI();

// ===== 部件动画插值 =====
// smoothStep 已从 src/utils.js 导入

// 优化：脏标记，避免每帧都重新计算部件位置
let needsExplodeUpdate = true;

function updateExplodedView(now) {
  if (isAnimating) {
    const elapsed = now - animationStart;
    let progress = elapsed / stepDuration;

    if (progress >= 1) {
      progress = 1;
      finishAnimation();
    }

    const eased = easeOutCubic(progress);
    currentStep = animationFrom + (animatingStep - animationFrom) * eased;
    needsExplodeUpdate = true; // 动画中每帧都需要更新
  } else if (explodeAnimActive) {
    // 一键爆炸/合体的整体平滑动画
    const elapsed = now - explodeAnimStart;
    let progress = elapsed / explodeAnimDuration;
    if (progress >= 1) {
      progress = 1;
      explodeAnimActive = false;
      explodeAnimFactor = explodeAnimTo; // 锁定到目标状态
      // 循环播放：停留片刻后自动反向（合体↔炸开）
      if (explodeLoop) {
        explodeLoopTimer = setTimeout(() => {
          explodeLoopTimer = null;
          if (explodeLoop) toggleExplode();
        }, loopHoldMs);
      }
    } else {
      const eased = easeOutCubic(progress);
      explodeAnimFactor = explodeAnimFrom + (explodeAnimTo - explodeAnimFrom) * eased;
    }
    needsExplodeUpdate = true; // 动画中每帧都需要更新
  }

  // 优化：如果状态未变化，跳过部件位置计算
  if (!needsExplodeUpdate) return;

  // 整体炸开模式下，所有部件使用同一因子；否则按分步/鼠标因子
  const globalFactor = explodeAllMode
    ? explodeAnimFactor
    : (mouseControlEnabled ? mouseFactor : currentStep / totalSteps);
  axisMat.opacity = globalFactor * 0.5;

  // 统一的部件更新函数（避免重复代码）
  const updatePart = part => {
    const partFactor = explodeAllMode
      ? explodeAnimFactor
      : smoothStep(
          part.stepIndex - 1,
          part.stepIndex,
          mouseControlEnabled ? mouseFactor * totalSteps : currentStep
        );

    part.mesh.position.lerpVectors(part.homePos, part.explodePos, partFactor);
    part.mesh.rotation.x = THREE.MathUtils.lerp(part.homeRot.x, part.explodeRot.x, partFactor);
    part.mesh.rotation.y = THREE.MathUtils.lerp(part.homeRot.y, part.explodeRot.y, partFactor);
    part.mesh.rotation.z = THREE.MathUtils.lerp(part.homeRot.z, part.explodeRot.z, partFactor);
  };

  // Quest 3 默认部件
  parts.forEach(updatePart);

  // 自定义模型部件（渐进式拆解，每个部件有自己的 stepIndex）
  if (hasCustomModel && customModelParts.length > 0) {
    customModelParts.forEach(updatePart);
  }

  // 非动画、非鼠标、非整体炸开动画时，标记为已更新（冻结当前状态）
  if (!isAnimating && !mouseControlEnabled && !explodeAnimActive) {
    needsExplodeUpdate = false;
  }
}

// ===== 响应窗口大小 =====
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== 渲染循环 =====
function animate(now) {
  requestAnimationFrame(animate);
  updateExplodedView(now);

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

// 等待 DOM 完全加载后再初始化上传功能
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupUpload);
} else {
  // DOM 已经加载完成
  setupUpload();
}

function setupUpload() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const uploadBtn = document.getElementById("upload-btn");
  const clearBtn = document.getElementById("clear-model-btn");

  console.log("Upload elements:", { dropZone, fileInput, uploadBtn, clearBtn });

  // 如果找不到上传相关元素，跳过上传功能
  if (!uploadBtn || !fileInput || !dropZone) {
    console.warn("上传功能所需元素未找到，跳过上传功能初始化");
    return;
  }

  // ── Blender 后端配置 ──
  const BLENDER_SERVER = "http://localhost:3001";

  /**
   * 尝试调用 Blender 后端拆解 GLB
   * 改进：使用 XMLHttpRequest 获取上传进度 + 二进制响应（不再 base64）
   * @param {File} file 上传的 GLB/GLTF 文件
   * @returns {Promise<{arrayBuffer: ArrayBuffer, manifest: object} | null>}
   */
  function tryBlenderSplit(file) {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append("file", file);

      showStatus("🔧 正在通过 Blender 拆解模型... (上传中)", "info");

      // 上传进度
      xhr.upload.addEventListener("progress", e => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          if (pct < 100) {
            showStatus(
              `📤 上传中... ${pct}% (${(e.loaded / 1024).toFixed(0)} / ${(e.total / 1024).toFixed(0)} KB)`,
              "info",
            );
          } else {
            showStatus("🔧 Blender 正在拆解模型... (已上传)", "info");
          }
        }
      });

      xhr.addEventListener("load", () => {
        try {
          if (xhr.status !== 200) {
            // 错误响应是 JSON
            const errData = JSON.parse(xhr.responseText || "{}");
            throw new Error(errData.error || `服务器错误 ${xhr.status}`);
          }

          // 检查是否是二进制响应（成功）
          const successHeader = xhr.getResponseHeader("X-Success");
          if (successHeader !== "true") {
            // 可能是旧的 JSON 格式，尝试解析
            const data = JSON.parse(xhr.responseText);
            if (!data.success) {
              throw new Error(data.error || "拆解失败");
            }
            // 兼容旧格式（base64）
            const binaryStr = atob(data.glb_base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            showStatus(
              `✅ Blender 拆解完成：${data.total_parts} 个部件 (${data.elapsed_seconds}s)`,
              "success",
            );
            resolve({ arrayBuffer: bytes.buffer, manifest: data });
            return;
          }

          // 新格式：二进制 GLB body + manifest 在 header
          const totalParts = parseInt(xhr.getResponseHeader("X-Total-Parts") || "0");
          const elapsedSeconds = parseFloat(xhr.getResponseHeader("X-Elapsed-Seconds") || "0");
          const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";

          // 解析 manifest（base64 → UTF-8 JSON，正确处理中文）
          let manifest = null;
          if (manifestBase64) {
            const manifestJson = base64ToUtf8(manifestBase64);
            manifest = JSON.parse(manifestJson);
          } else {
            throw new Error("响应中缺少 manifest 头");
          }

          showStatus(`✅ Blender 拆解完成：${totalParts} 个部件 (${elapsedSeconds}s)`, "success");

          resolve({
            arrayBuffer: xhr.response,
            manifest,
          });
        } catch (err) {
          console.warn("Blender 响应解析失败:", err.message);
          resolve(null);
        }
      });

      xhr.addEventListener("error", () => {
        console.warn("Blender 后端不可用，回退到 JS 拆解: 网络错误");
        resolve(null);
      });

      xhr.addEventListener("timeout", () => {
        console.warn("Blender 后端超时，回退到 JS 拆解");
        resolve(null);
      });

      xhr.responseType = "arraybuffer";
      xhr.timeout = 600000; // 10 分钟
      xhr.open("POST", `${BLENDER_SERVER}/api/split`);
      xhr.send(formData);
    });
  }

  async function handleFile(file) {
    if (!file) return;

    const ext = file.name.split(".").pop().toLowerCase();
    if (!["glb", "gltf", "stl", "urdf"].includes(ext)) {
      showStatus("❌ 不支持的文件格式\n请上传 .glb / .gltf / .stl / .urdf 文件", "error");
      return;
    }

    if (file.size > 100 * 1024 * 1024) {
      showStatus("❌ 文件太大\n请上传小于 100MB 的文件", "error");
      return;
    }

    // URDF 文件：前端解析 XML 结构
    if (ext === "urdf") {
      showStatus("📦 正在解析 URDF 文件...", "info");
      const reader = new FileReader();
      reader.onload = e => {
        loadURDFModel(e.target.result, file.name);
      };
      reader.onerror = () => showStatus("❌ 读取文件失败", "error");
      reader.readAsText(file);
      return;
    }

    // STL 文件：前端 STLLoader 加载，或送 Blender 拆解
    if (ext === "stl") {
      // 优先尝试 Blender 后端拆解
      const blenderResult = await tryBlenderSplit(file);
      if (blenderResult) {
        loadCustomModel(blenderResult.arrayBuffer, file.name, blenderResult.manifest);
        return;
      }
      // 回退：前端 STLLoader 直接加载（单部件）
      showStatus("⏳ 正在用前端加载 STL 模型...", "info");
      const reader = new FileReader();
      reader.onload = e => {
        loadSTLModel(e.target.result, file.name);
      };
      reader.onerror = () => showStatus("❌ 读取文件失败", "error");
      reader.readAsArrayBuffer(file);
      return;
    }

    // GLB / GLTF 文件：优先尝试 Blender 后端拆解（包括 Quest 3 模型）
    const blenderResult = await tryBlenderSplit(file);

    if (blenderResult) {
      // Blender 拆解成功，使用拆解后的 GLB + 清单
      loadCustomModel(blenderResult.arrayBuffer, file.name, blenderResult.manifest);
      return;
    }

    // 回退：读取文件用 JS 拆解（包括 Quest 3 面级别切割）
    showStatus("⏳ 正在用前端 JS 拆解模型...", "info");

    const reader = new FileReader();
    reader.onload = e => {
      loadCustomModel(e.target.result, file.name, null);
    };
    reader.onerror = () => showStatus("❌ 读取文件失败", "error");
    reader.readAsArrayBuffer(file);
  }

  // 点击上传按钮
  uploadBtn.addEventListener("click", () => fileInput.click());

  // 文件选择
  fileInput.addEventListener("change", e => {
    handleFile(e.target.files[0]);
    e.target.value = ""; // 重置 input
  });

  // 拖拽上传
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    dropZone.style.borderColor = "#4a9eff";
    dropZone.style.background = "rgba(74, 158, 255, 0.1)";
  });

  dropZone.addEventListener("dragleave", e => {
    e.preventDefault();
    dropZone.style.borderColor = "";
    dropZone.style.background = "";
  });

  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.style.borderColor = "";
    dropZone.style.background = "";
    const file = e.dataTransfer.files[0];
    handleFile(file);
  });

  // 清除自定义模型
  if (clearBtn) {
    clearBtn.addEventListener("click", clearCustomModel);
  }

  console.log("文件上传功能已启用");
}

// ===== AI 绘画功能 =====
const BLENDER_SERVER_AI = "http://localhost:3001";
let aiPaintGallery = []; // 存储已生成的模型 { id, prompt, arrayBuffer, manifest, icon, parts }

function setupAIPaint() {
  const promptInput = document.getElementById("ai-paint-prompt");
  const paintBtn = document.getElementById("ai-paint-btn");
  const presetBtns = document.querySelectorAll(".chip");
  const statusEl = document.getElementById("ai-paint-status");
  const galleryEl = document.getElementById("ai-paint-gallery");

  // 图片上传相关元素
  const dropzone = document.getElementById("ai-paint-dropzone");
  const fileInput = document.getElementById("ai-paint-image");
  const dropzoneText = document.getElementById("ai-paint-dropzone-text");
  const imagePreview = document.getElementById("ai-paint-image-preview");
  const previewImg = document.getElementById("ai-paint-preview-img");
  const removeImgBtn = document.getElementById("ai-paint-remove-image");
  const imgTo3DBtn = document.getElementById("img-to-3d-btn");
  const imgTo3DDeploy = document.getElementById("img-to-3d-deploy");
  const imgTo3DModelLocal = document.getElementById("img-to-3d-model-local");
  const imgTo3DRemoveBg = document.getElementById("img-to-3d-remove-bg");
  const imgTo3DBake = document.getElementById("img-to-3d-bake");
  const imgTo3DModel = document.getElementById("img-to-3d-model");
  const imgTo3DModelCustom = document.getElementById("img-to-3d-model-custom");

  // 当前上传的图片特征
  let uploadedImageFeatures = null;
  // 当前上传图片的 data URL（用于图片转 3D）
  let uploadedImageDataUrl = null;

  if (!promptInput || !paintBtn) {
    console.warn("AI 绘画元素未找到，跳过初始化");
    return;
  }

  function showAIStatus(msg, type = "info") {
    if (!statusEl) return;
    statusEl.innerHTML = msg;
    statusEl.className = "status-box " + type;
    statusEl.classList.remove("hidden");
  }

  function hideAIStatus() {
    if (statusEl) statusEl.classList.add("hidden");
  }

  // 获取提示词对应的图标
  function getPromptIcon(prompt) {
    const p = prompt.toLowerCase();
    if (p.includes("篮球") || p.includes("basketball")) return "🏀";
    if (p.includes("quest") || p.includes("vr") || p.includes("头显")) return "🕶️";
    if (p.includes("机器人") || p.includes("robot")) return "🤖";
    if (p.includes("汽车") || p.includes("车") || p.includes("car")) return "🚗";
    if (p.includes("房子") || p.includes("house")) return "🏠";
    if (p.includes("人") || p.includes("角色") || p.includes("character")) return "🧑";
    if (p.includes("火箭") || p.includes("rocket")) return "🚀";
    if (p.includes("球") || p.includes("sphere") || p.includes("ball")) return "🔴";
    return "🎨";
  }

  // ========== 图片特征提取 ==========
  // 从图片中提取主色调、明暗、宽高比、圆度等特征
  function extractImageFeatures(imgElement) {
    return new Promise(resolve => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const SAMPLE_SIZE = 100; // 缩小采样以加速

      // 计算缩放比例
      const scale = Math.min(
        SAMPLE_SIZE / imgElement.naturalWidth,
        SAMPLE_SIZE / imgElement.naturalHeight,
      );
      const w = Math.max(1, Math.round(imgElement.naturalWidth * scale));
      const h = Math.max(1, Math.round(imgElement.naturalHeight * scale));

      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(imgElement, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      // 颜色量化与统计
      const colorMap = new Map();
      let totalR = 0,
        totalG = 0,
        totalB = 0;
      let pixelCount = 0;
      let brightPixels = 0;
      let darkPixels = 0;
      let edgePixels = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 128) continue; // 跳过透明像素

        totalR += r;
        totalG += g;
        totalB += b;
        pixelCount++;

        // 亮度判断
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 180) brightPixels++;
        if (lum < 60) darkPixels++;

        // 量化颜色（每个通道分8档）
        const qr = Math.round(r / 32) * 32;
        const qg = Math.round(g / 32) * 32;
        const qb = Math.round(b / 32) * 32;
        const key = `${qr},${qg},${qb}`;
        colorMap.set(key, (colorMap.get(key) || 0) + 1);
      }

      if (pixelCount === 0) {
        resolve(null);
        return;
      }

      // 平均色
      const avgR = Math.round(totalR / pixelCount);
      const avgG = Math.round(totalG / pixelCount);
      const avgB = Math.round(totalB / pixelCount);
      const avgLum = (0.299 * avgR + 0.587 * avgG + 0.114 * avgB) / 255;

      // 提取前5个主色
      const sortedColors = [...colorMap.entries()].sort((a, b) => b[1] - a[1]);
      const dominantColors = sortedColors.slice(0, 5).map(([key, count]) => {
        const [r, g, b] = key.split(",").map(Number);
        return { r, g, b, ratio: count / pixelCount };
      });

      // 边缘检测（简单 Sobel）
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = (y * w + x) * 4;
          const idxRight = (y * w + (x + 1)) * 4;
          const idxDown = ((y + 1) * w + x) * 4;
          const lumC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          const lumR =
            0.299 * data[idxRight] + 0.587 * data[idxRight + 1] + 0.114 * data[idxRight + 2];
          const lumD =
            0.299 * data[idxDown] + 0.587 * data[idxDown + 1] + 0.114 * data[idxDown + 2];
          if (Math.abs(lumC - lumR) > 30 || Math.abs(lumC - lumD) > 30) {
            edgePixels++;
          }
        }
      }
      const edgeRatio = edgePixels / (w * h);

      // 判断整体色调
      let mood = "neutral";
      if (avgLum > 0.7) mood = "bright";
      else if (avgLum < 0.3) mood = "dark";
      if (avgR > avgG + 30 && avgR > avgB + 30) mood = "warm";
      if (avgB > avgR + 20 && avgB > avgG) mood = "cool";
      if (avgG > avgR + 20 && avgG > avgB + 10) mood = "natural";

      // 宽高比
      const aspectRatio = imgElement.naturalWidth / imgElement.naturalHeight;

      // 是否对称（左右翻转差异大说明不对称）
      let symScore = 0;
      const halfW = Math.floor(w / 2);
      let symCount = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < halfW; x += 2) {
          const idxL = (y * w + x) * 4;
          const idxR = (y * w + (w - 1 - x)) * 4;
          const diff =
            Math.abs(data[idxL] - data[idxR]) +
            Math.abs(data[idxL + 1] - data[idxR + 1]) +
            Math.abs(data[idxL + 2] - data[idxR + 2]);
          if (diff < 30) symScore++;
          symCount++;
        }
      }
      const symmetry = symCount > 0 ? symScore / symCount : 0;

      const features = {
        dominantColors: dominantColors.map(c => ({
          r: c.r,
          g: c.g,
          b: c.b,
          ratio: parseFloat(c.ratio.toFixed(3)),
        })),
        avgColor: { r: avgR, g: avgG, b: avgB },
        avgLuminance: parseFloat(avgLum.toFixed(3)),
        mood,
        aspectRatio: parseFloat(aspectRatio.toFixed(2)),
        edgeDensity: parseFloat(edgeRatio.toFixed(3)),
        symmetry: parseFloat(symmetry.toFixed(3)),
        brightRatio: parseFloat((brightPixels / pixelCount).toFixed(3)),
        darkRatio: parseFloat((darkPixels / pixelCount).toFixed(3)),
        width: imgElement.naturalWidth,
        height: imgElement.naturalHeight,
      };

      console.log("🎨 图片特征提取:", features);
      resolve(features);
    });
  }

  // 处理图片文件
  async function handleImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      showAIStatus("❌ 请上传图片文件", "error");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showAIStatus("❌ 图片不能超过 10MB", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = async e => {
      const dataUrl = e.target.result;
      previewImg.src = dataUrl;
      uploadedImageDataUrl = dataUrl;
      imagePreview.classList.remove("hidden");
      dropzoneText.textContent = `已上传: ${file.name}`;

      // 创建 Image 对象提取特征
      const img = new Image();
      img.onload = async() => {
        uploadedImageFeatures = await extractImageFeatures(img);
        if (uploadedImageFeatures) {
          const colorSwatches = uploadedImageFeatures.dominantColors
            .map(
              c =>
                `<span class="ai-paint-color-swatch" style="background:rgb(${c.r},${c.g},${c.b})" title="rgb(${c.r},${c.g},${c.b}) ${(c.ratio * 100).toFixed(0)}%"></span>`,
            )
            .join("");
          showAIStatus(
            `🖼️ 已提取图片特征: ${uploadedImageFeatures.mood}色调 · 对称度${(uploadedImageFeatures.symmetry * 100).toFixed(0)}% · 边缘密度${(uploadedImageFeatures.edgeDensity * 100).toFixed(0)}%<div class="ai-paint-color-swatches">${colorSwatches}</div>`,
            "info",
          );
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  // 清除已上传图片
  function clearUploadedImage() {
    uploadedImageFeatures = null;
    uploadedImageDataUrl = null;
    previewImg.removeAttribute("src");
    imagePreview.classList.add("hidden");
    dropzoneText.textContent = "上传参考图片（可选）— 提取颜色和形状特征";
    if (fileInput) fileInput.value = "";
  }

  // 绑定图片上传事件
  if (dropzone && fileInput) {
    // 点击上传
    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", e => {
      if (e.target.files && e.target.files[0]) {
        handleImageFile(e.target.files[0]);
      }
    });

    // 拖拽上传
    dropzone.addEventListener("dragover", e => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });
    dropzone.addEventListener("drop", e => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleImageFile(e.dataTransfer.files[0]);
      }
    });
  }

  // 清除图片按钮
  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", e => {
      e.stopPropagation();
      clearUploadedImage();
    });
  }

  // 图片转 3D 按钮
  if (imgTo3DBtn) {
    imgTo3DBtn.addEventListener("click", () => imageTo3D());
  }

  // 部署方式：本地显示本地模型下拉，云端显示云端模型下拉
  function refreshTo3DControls() {
    const deploy = imgTo3DDeploy ? imgTo3DDeploy.value : "local";
    const isLocal = deploy === "local";
    if (imgTo3DModelLocal) imgTo3DModelLocal.classList.toggle("hidden", !isLocal);
    if (imgTo3DModel) imgTo3DModel.classList.toggle("hidden", isLocal);
    if (imgTo3DModelCustom) imgTo3DModelCustom.classList.add("hidden");
  }
  if (imgTo3DDeploy) {
    imgTo3DDeploy.addEventListener("change", refreshTo3DControls);
  }
  if (imgTo3DModel) {
    imgTo3DModel.addEventListener("change", () => {
      const isCustom = imgTo3DModel.value === "__custom__";
      if (imgTo3DModelCustom) imgTo3DModelCustom.classList.toggle("hidden", !isCustom);
    });
  }
  refreshTo3DControls();

  // 默认使用本地重建（离线、无需 Token）；如需云端，可在下拉框手动选择「Replicate 云端」

  // 图片转 3D：上传图 → 服务端生成 GLB → 载入场景
  async function imageTo3D() {
    if (!uploadedImageDataUrl) {
      showAIStatus("❌ 请先上传一张参考图（拖入或点击上方区域）", "error");
      return;
    }

    const deploy = imgTo3DDeploy ? imgTo3DDeploy.value : "local";
    const isLocal = deploy === "local";

    if (imgTo3DBtn) {
      imgTo3DBtn.disabled = true;
      imgTo3DBtn.textContent = "⏳ 重建中...";
    }
    showAIStatus(
      `<span class="ai-paint-spinner"></span>` +
        (isLocal
          ? "正在用本地 TripoSR 真重建 3D（单图重建，首次需下载模型权重，约 1-3 分钟）..."
          : "正在用 Replicate 重建 3D 模型...（约 1-3 分钟，请耐心等待）"),
      "info",
    );

    try {
      const xhr = new XMLHttpRequest();
      xhr.responseType = "arraybuffer";
      xhr.timeout = 1200000; // 20 分钟（CPU 首跑含权重下载可能较慢）

      const result = await new Promise((resolve, reject) => {
        xhr.addEventListener("load", () => {
          try {
            if (xhr.status !== 200) {
              const errText = new TextDecoder().decode(xhr.response);
              let errMsg = `服务器错误 ${xhr.status}`;
              try {
                errMsg = JSON.parse(errText).error || errMsg;
              } catch {}
              reject(new Error(errMsg));
              return;
            }
            const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";
            let manifest = null;
            if (manifestBase64) manifest = JSON.parse(base64ToUtf8(manifestBase64));
            resolve({
              arrayBuffer: xhr.response,
              manifest,
              totalParts: parseInt(xhr.getResponseHeader("X-Total-Parts") || "0", 10),
            });
          } catch (err) {
            reject(err);
          }
        });
        xhr.addEventListener("error", () =>
          reject(new Error("网络错误：无法连接到服务器（请确认 server.js 已启动）")),
        );
        xhr.addEventListener("timeout", () => reject(new Error("请求超时（20分钟）")));

        xhr.open("POST", `${BLENDER_SERVER_AI}/api/image-to-3d`);
        xhr.setRequestHeader("Content-Type", "application/json");
        // 部署方式 + 模型：本地走 TripoSR 真重建，云端走 Replicate（owner/name）
        const payload = { image: uploadedImageDataUrl, deploy };
        if (deploy === "local") {
          const q = imgTo3DModelLocal ? imgTo3DModelLocal.value : "256";
          payload.mcResolution = parseInt(q, 10) || 256; // 真重建：重建质量（marching cubes 分辨率）
          payload.tiles = 1; // 真重建为单网格，不再切块
          payload.removeBg = imgTo3DRemoveBg ? imgTo3DRemoveBg.checked : true; // 去背景显著提升重建质量
          payload.bakeTexture = imgTo3DBake ? imgTo3DBake.checked : false; // 烘焙纹理图集（比顶点色清晰）
        } else {
          let m = imgTo3DModel ? imgTo3DModel.value : "";
          if (m === "__custom__" && imgTo3DModelCustom) m = imgTo3DModelCustom.value.trim();
          if (m) payload.model = m;
        }
        xhr.send(JSON.stringify(payload));
      });

      showAIStatus(`✅ 重建成功！正在加载到场景...`, "success");
      await loadCustomModel(result.arrayBuffer, "图片转3D", result.manifest);
      showAIStatus(
        `✅ 图片转3D 已加载\n可旋转/缩放，可切换乐高/原生风格`,
        "success",
      );
      showStatus(`✅ 图片转3D：模型已加载`, "success");
    } catch (err) {
      console.error("图片转3D 失败:", err);
      showAIStatus(`❌ 重建失败：${err.message}`, "error");
    } finally {
      if (imgTo3DBtn) {
        imgTo3DBtn.disabled = false;
        imgTo3DBtn.textContent = "🧊 图片转3D";
      }
    }
  }

  // 发送 AI 绘画请求
  async function generateModel(prompt) {
    if (!prompt || !prompt.trim()) {
      showAIStatus("❌ 请输入提示词", "error");
      return;
    }

    prompt = prompt.trim();
    console.log(`🎨 AI 绘画: "${prompt}"${uploadedImageFeatures ? " + 图片特征" : ""}`);

    // 禁用按钮，显示进度
    paintBtn.disabled = true;
    paintBtn.textContent = "⏳ 生成中...";
    const imgHint = uploadedImageFeatures ? "（含图片特征）" : "";
    showAIStatus(
      `<span class="ai-paint-spinner"></span>正在生成 "${prompt}" ${imgHint}...（Blender 处理中，约10-30秒）`,
      "info",
    );

    try {
      const xhr = new XMLHttpRequest();
      xhr.responseType = "arraybuffer";
      xhr.timeout = 120000; // 2 分钟

      const result = await new Promise((resolve, reject) => {
        xhr.addEventListener("load", () => {
          try {
            if (xhr.status !== 200) {
              const errText = new TextDecoder().decode(xhr.response);
              let errMsg = `服务器错误 ${xhr.status}`;
              try {
                errMsg = JSON.parse(errText).error || errMsg;
              } catch {}
              reject(new Error(errMsg));
              return;
            }

            const successHeader = xhr.getResponseHeader("X-Success");
            if (successHeader !== "true") {
              reject(new Error("服务器返回异常"));
              return;
            }

            const totalParts = parseInt(xhr.getResponseHeader("X-Total-Parts") || "0");
            const elapsedSeconds = parseFloat(xhr.getResponseHeader("X-Elapsed-Seconds") || "0");
            const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";

            let manifest = null;
            if (manifestBase64) {
              const manifestJson = base64ToUtf8(manifestBase64);
              manifest = JSON.parse(manifestJson);
            }

            resolve({
              arrayBuffer: xhr.response,
              manifest,
              totalParts,
              elapsedSeconds,
            });
          } catch (err) {
            reject(err);
          }
        });

        xhr.addEventListener("error", () =>
          reject(new Error("网络错误：无法连接到服务器（请确认 server.js 已启动）")),
        );
        xhr.addEventListener("timeout", () => reject(new Error("请求超时（2分钟）")));

        xhr.open("POST", `${BLENDER_SERVER_AI}/api/ai-paint`);
        xhr.setRequestHeader("Content-Type", "application/json");
        const payload = { prompt };
        if (uploadedImageFeatures) {
          payload.imageFeatures = uploadedImageFeatures;
        }
        xhr.send(JSON.stringify(payload));
      });

      // 成功！加载模型到场景
      showAIStatus(
        `✅ 生成成功！${result.totalParts} 个部件 (${result.elapsedSeconds}s)\n正在加载到场景...`,
        "success",
      );

      const fileName = `AI: ${prompt}`;
      await loadCustomModel(result.arrayBuffer, fileName, result.manifest);

      // 更新状态
      showAIStatus(
        `✅ "${prompt}" 已加载\n${result.totalParts} 个部件 · 点击"💥 爆炸"可拆解`,
        "success",
      );

      // 添加到画廊
      const galleryItem = {
        id: Date.now(),
        prompt,
        arrayBuffer: result.arrayBuffer,
        manifest: result.manifest,
        icon: getPromptIcon(prompt),
        parts: result.totalParts,
      };
      aiPaintGallery.push(galleryItem);
      renderGallery();

      // 同时更新上传区域的状态
      showStatus(
        `✅ AI 绘画：${prompt}\n${result.totalParts} 个部件 · 点击爆炸按钮拆解`,
        "success",
      );

      console.log(`✅ AI 绘画完成: ${result.totalParts} 个部件`);
    } catch (err) {
      console.error("AI 绘画失败:", err);
      showAIStatus(`❌ 生成失败：${err.message}`, "error");
    } finally {
      paintBtn.disabled = false;
      paintBtn.textContent = "✨ 生成";
    }
  }

  // 渲染画廊
  function renderGallery() {
    if (!galleryEl) return;
    galleryEl.innerHTML = "";

    // 只显示最近 8 个
    const recent = aiPaintGallery.slice(-8);
    recent.forEach((item, idx) => {
      const actualIdx = aiPaintGallery.length - recent.length + idx;
      const el = document.createElement("div");
      el.className = "ai-gallery-item";
      el.innerHTML = `
        <span class="gallery-icon">${item.icon}</span>
        <span class="gallery-name">${item.prompt}</span>
        <span class="gallery-parts">${item.parts}件</span>
      `;
      el.addEventListener("click", () => {
        // 重新加载这个模型
        loadCustomModel(item.arrayBuffer, `AI: ${item.prompt}`, item.manifest);
        showAIStatus(`✅ 已切换到 "${item.prompt}"`, "success");
        // 标记活跃
        galleryEl.querySelectorAll(".ai-gallery-item").forEach(e => e.classList.remove("active"));
        el.classList.add("active");
      });
      galleryEl.appendChild(el);
    });
  }

  // 生成按钮点击
  paintBtn.addEventListener("click", () => {
    generateModel(promptInput.value);
  });

  // 回车键提交
  promptInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      generateModel(promptInput.value);
    }
  });

  // 预设按钮
  presetBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.prompt;
      promptInput.value = preset;
      generateModel(preset);
    });
  });

  console.log("🎨 AI 绘画功能已启用");
}

// 等待 DOM 完全加载后初始化 AI 绘画
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupAIPaint);
} else {
  setupAIPaint();
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
    setTimeout(() => { styleToggle.style.transform = ""; }, 300);
  });
}

// ===== Blender 状态检测 + 一键启动 =====
const blenderStatusEl = document.getElementById("blender-status");
const blenderBanner = document.getElementById("blender-banner");
const blenderLaunchBtn = document.getElementById("blender-launch");
const blenderDismissBtn = document.getElementById("blender-dismiss");

// 依次尝试同源与独立后端端口，兼容两种部署方式
async function fetchBlenderHealth() {
  const candidates = [
    location.origin + "/api/health",
    `http://${location.hostname}:3001/api/health`,
  ];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { method: "GET" });
      if (r.ok) return await r.json();
    } catch (_) {
      /* 尝试下一个地址 */
    }
  }
  return null; // 后端不可达
}

function updateBlenderUI(health) {
  if (!blenderStatusEl) return;
  if (!health || health.status !== "ok") {
    blenderStatusEl.className = "blender-chip " + (health ? "error" : "unknown");
    blenderStatusEl.textContent = health ? "❌ Blender 不可用" : "⚠️ 后端离线";
    if (blenderBanner) {
      // 仅当后端可达但 Blender 不可用时提示
      blenderBanner.classList.toggle("hidden", !health);
    }
  } else {
    blenderStatusEl.className = "blender-chip ok";
    blenderStatusEl.textContent = `✅ Blender ${health.version || ""}`.trim();
    if (blenderBanner) blenderBanner.classList.add("hidden");
  }
}

async function launchBlender() {
  if (blenderLaunchBtn) blenderLaunchBtn.disabled = true;
  const candidates = [
    location.origin + "/api/blender/launch",
    `http://${location.hostname}:3001/api/blender/launch`,
  ];
  let ok = false;
  for (const u of candidates) {
    try {
      const r = await fetch(u, { method: "POST" });
      if (r.ok) { ok = true; break; }
    } catch (_) {
      /* 尝试下一个地址 */
    }
  }
  if (blenderLaunchBtn) blenderLaunchBtn.disabled = false;
  updateBlenderUI(await fetchBlenderHealth());
  if (!ok && blenderBanner) {
    const t = blenderBanner.querySelector(".bb-text");
    if (t) t.textContent = "未能启动 Blender，请确认本机已安装 Blender 应用。";
  }
}

if (blenderLaunchBtn) blenderLaunchBtn.addEventListener("click", launchBlender);
if (blenderDismissBtn && blenderBanner) {
  blenderDismissBtn.addEventListener("click", () => blenderBanner.classList.add("hidden"));
}

// 打开软件时检测 Blender 状态
fetchBlenderHealth().then(updateBlenderUI);

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

// 在 updateStepUI 的最后调用动画
const originalUpdateStepUI = updateStepUI;
updateStepUI = function() {
  originalUpdateStepUI();
  updateStepDescAnimation();
};

// ===== WebXR AR 预览 =====
let arSession = null;
let arButton = null;
let arSupported = false;
let arHitTestSource = null;
let arModelPlaced = false;
let arEnding = false; // 防止 onAREnd 重入

// 检测 WebXR AR 支持
async function checkARSupport() {
  if (!("xr" in navigator)) {
    console.log("WebXR not supported");
    return false;
  }

  try {
    const isSupported = await navigator.xr.isSessionSupported("immersive-ar");
    arSupported = isSupported;
    console.log("WebXR AR supported:", isSupported);
    return isSupported;
  } catch (err) {
    console.error("Error checking AR support:", err);
    return false;
  }
}

// 显示/隐藏 AR 按钮
function updateARButton() {
  if (arButton) {
    if (arSupported && !arSession) {
      arButton.style.display = "inline-block";
      arButton.disabled = false;
      arButton.title = "在 AR 中预览 Quest 3";
    } else {
      arButton.style.display = "none";
    }
  }
}

// 启动 AR 会话
async function startAR() {
  if (!arSupported) {
    alert(
      "您的设备不支持 AR 功能\n\n支持的设备：\n- Android Chrome\n- iOS Safari 15+\n\n请确保使用 HTTPS 访问。",
    );
    return;
  }

  try {
    // 请求 AR 会话
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "local-floor"],
      optionalFeatures: ["dom-overlay", "light-estimation"],
      domOverlay: { root: document.body },
    });

    arSession = session;

    // 更新按钮状态
    if (arButton) {
      arButton.textContent = "🚪 退出 AR";
      arButton.classList.add("active");
    }

    // 隐藏 UI 面板
    if (uiOverlay) {
      uiOverlay.style.display = "none";
    }

    // 设置 AR 渲染器
    const arRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
    });
    arRenderer.setPixelRatio(window.devicePixelRatio);
    arRenderer.setSize(window.innerWidth, window.innerHeight);
    arRenderer.xr.enabled = true;
    arRenderer.xr.setReferenceSpaceType("local-floor");

    // 替换画布：移除原有 canvas，添加 AR 渲染器的 canvas
    container.innerHTML = "";
    container.appendChild(arRenderer.domElement);

    // 创建 AR 场景
    const arScene = new THREE.Scene();

    // 添加灯光
    const arAmbientLight = new THREE.AmbientLight(0xffffff, 0.6);
    arScene.add(arAmbientLight);
    const arDirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    arDirLight.position.set(5, 10, 7);
    arScene.add(arDirLight);

    // 创建 Quest 3 模型的 AR 副本
    const arQuestGroup = questGroup.clone();
    arScene.add(arQuestGroup);

    // 调整 AR 中的模型大小
    arQuestGroup.scale.set(0.1, 0.1, 0.1);

    // 设置 AR 相机
    const arCamera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.01,
      20,
    );

    // 启用 hit-test：先设置 session，再初始化 hit-test source
    session.addEventListener("end", onAREnd);
    await arRenderer.xr.setSession(session);

    // 初始化 hit-test source（之前缺失，导致 getHitTestResults 始终失败）
    try {
      const viewerSpace = await session.requestReferenceSpace("viewer");
      arHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    } catch (err) {
      console.warn("Hit-test source 初始化失败，模型将放置在默认位置:", err);
    }

    // 从 AR 克隆中收集部件引用（避免修改原始场景的 mesh）
    const arParts = [];
    const cloneMeshMap = new Map();
    arQuestGroup.traverse(child => {
      if (child.isMesh && child.userData.name) {
        cloneMeshMap.set(child.userData.name, child);
      }
    });
    parts.forEach(part => {
      const clonedMesh = cloneMeshMap.get(part.name);
      if (clonedMesh) {
        arParts.push({
          mesh: clonedMesh,
          homePos: part.homePos,
          explodePos: part.explodePos,
          name: part.name,
        });
      }
    });

    // AR 渲染循环
    arRenderer.setAnimationLoop((timestamp, frame) => {
      if (frame) {
        // 获取参考空间
        const referenceSpace = arRenderer.xr.getReferenceSpace();

        // 获取 viewer 空间
        const viewerPose = frame.getViewerPose(referenceSpace);

        if (viewerPose) {
          // 更新相机
          const view = viewerPose.views[0];
          arCamera.projectionMatrix.fromArray(view.projectionMatrix);
          arCamera.matrix.fromArray(view.transform.matrix);
          arCamera.matrixWorldNeedsUpdate = true;

          // 如果模型未放置，执行 hit-test
          if (!arModelPlaced && arHitTestSource && frame.getHitTestResults) {
            const hitTestResults = frame.getHitTestResults(arHitTestSource);

            if (hitTestResults.length > 0) {
              const hit = hitTestResults[0];
              const hitPose = hit.getPose(referenceSpace);

              if (hitPose) {
                arModelPlaced = true;

                // 放置模型
                arQuestGroup.position.setFromMatrixPosition(hitPose.transform);
                arQuestGroup.quaternion.setFromRotationMatrix(hitPose.transform);
              }
            }
          }

          // 如果模型已放置，添加简单的爆炸效果（使用 AR 克隆的部件）
          if (arModelPlaced) {
            const time = timestamp * 0.001;
            const explodeFactor = (Math.sin(time * 0.5) + 1) * 0.3;

            // 应用爆炸变换到 AR 克隆的部件（而非原始场景的部件）
            arParts.forEach((part, index) => {
              const delay = index * 0.05;
              const factor = Math.max(0, Math.min(1, (explodeFactor - delay) * 2));

              part.mesh.position.lerpVectors(part.homePos, part.explodePos, factor * 0.5);
            });
          }

          // 自动旋转
          if (controls.autoRotate && arModelPlaced) {
            arQuestGroup.rotation.y += 0.005;
          }
        }

        arRenderer.render(arScene, arCamera);
      }
    });

    console.log("AR session started");
  } catch (err) {
    console.error("Failed to start AR:", err);
    alert(
      "启动 AR 失败：" +
        err.message +
        "\n\n请确保：\n1. 使用 HTTPS\n2. 设备支持 AR\n3. 授予相机权限",
    );
    onAREnd();
  }
}

// 结束 AR 会话
function onAREnd() {
  // 防止重入（'end' 事件可能在此函数执行过程中触发）
  if (arEnding) return;
  arEnding = true;

  try {
    if (arHitTestSource) {
      arHitTestSource.cancel();
      arHitTestSource = null;
    }
    if (arSession) {
      arSession.end();
      arSession = null;
    }
    arModelPlaced = false;
  } catch (err) {
    console.error("结束 AR 会话时出错:", err);
  }

  // 恢复普通渲染器
  location.reload();
}

// 初始化 AR
async function initAR() {
  const supported = await checkARSupport();

  if (supported) {
    arButton = document.getElementById("ar-btn");
    if (arButton) {
      // 绑定 AR 按钮事件（之前在模块顶层绑定，但此时 arButton 尚为 null，导致事件从未绑定）
      arButton.addEventListener("click", () => {
        if (arSession) {
          onAREnd();
        } else {
          startAR();
        }
      });
    }
    updateARButton();
  }
}

// 页面加载后检测 AR
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAR);
} else {
  initAR();
}
