import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { quest3Specs, partInfo } from './src/quest3-data.js';
import { defaultStepGroups } from './src/quest3-steps.js';

// 动态导入 GLTFLoader（本地化 + Import Map 支持）
let GLTFLoader = null;
async function loadGLTFLoader() {
  if (!GLTFLoader) {
    // 直接使用 import，依赖 import map 解析 'three'
    const module = await import('./vendor/GLTFLoader.js');
    GLTFLoader = module.GLTFLoader;
  }
  return GLTFLoader;
}

// 动态导入 STLLoader
let STLLoader = null;
async function loadSTLLoader() {
  if (!STLLoader) {
    const module = await import('./vendor/STLLoader.js');
    STLLoader = module.STLLoader;
  }
  return STLLoader;
}

// ===== WebGL 支持检测 =====
try {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('浏览器不支持 WebGL');
} catch (err) {
  const el = document.getElementById('error');
  if (el) { el.classList.remove('hidden'); el.textContent = err.message; }
  throw err;
}

// ===== 场景初始化 =====
const container = document.getElementById('canvas-container');
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

for(let i = 0; i < particlesCount * 3; i++) {
  posArray[i] = (Math.random() - 0.5) * 30;
}

particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
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

  console.log('📐 相机适配:', {
    center: `(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`,
    size: `(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)})`,
    maxDim: maxDim.toFixed(2),
    cameraDistance: cameraDistance.toFixed(2)
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

  console.log('🧮 智能爆炸距离计算:', {
    modelSize: maxDim.toFixed(2),
    distToCamera: distToCamera.toFixed(2),
    maxVisibleDist: maxVisibleDist.toFixed(2),
    angleWithCamera: (angleWithCamera * 180 / Math.PI).toFixed(1) + '°',
    angleFactor: angleFactor.toFixed(2),
    suggestedDist: suggestedDist.toFixed(2)
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

// ===== Quest 3 简化模型构建 =====
const questGroup = new THREE.Group();
scene.add(questGroup);

const parts = []; // 存储所有可拆解部件

function createPart({ mesh, homePos, explodePos, homeRot = [0, 0, 0], explodeRot = [0, 0, 0], name }) {
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
  name: '主机身',
});

// 2. 前面板（白色外壳）
const frontGeo = new RoundedBoxGeometry(2.3, 1.25, 0.25, 4, 0.1);
const frontMesh = new THREE.Mesh(frontGeo, materials.frontPlate);
createPart({
  mesh: frontMesh,
  homePos: [0, 0, 0.55],
  explodePos: [0, 0, 1.45],
  name: '前面板',
});

// 3. 后面罩/泡沫垫
const foamGeo = new RoundedBoxGeometry(2.0, 0.95, 0.18, 4, 0.08);
const foamMesh = new THREE.Mesh(foamGeo, materials.foam);
createPart({
  mesh: foamMesh,
  homePos: [0, 0, -0.55],
  explodePos: [0, 0, -1.35],
  name: '面罩海绵',
});

// 4. 左右透镜模组
const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.45, 32);
barrelGeo.rotateX(Math.PI / 2);
const leftBarrel = new THREE.Mesh(barrelGeo, materials.lensBarrel);
createPart({
  mesh: leftBarrel,
  homePos: [-0.52, 0.05, -0.12],
  explodePos: [-0.52, 0.05, -0.7],
  name: '左透镜模组',
});

const rightBarrel = new THREE.Mesh(barrelGeo.clone(), materials.lensBarrel);
createPart({
  mesh: rightBarrel,
  homePos: [0.52, 0.05, -0.12],
  explodePos: [0.52, 0.05, -0.7],
  name: '右透镜模组',
});

// 5. 透镜玻璃片
const glassGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.04, 32);
glassGeo.rotateX(Math.PI / 2);
const leftGlass = new THREE.Mesh(glassGeo, materials.lensGlass);
createPart({
  mesh: leftGlass,
  homePos: [-0.52, 0.05, -0.34],
  explodePos: [-0.52, 0.05, -1.1],
  name: '左透镜',
});

const rightGlass = new THREE.Mesh(glassGeo.clone(), materials.lensGlass);
createPart({
  mesh: rightGlass,
  homePos: [0.52, 0.05, -0.34],
  explodePos: [0.52, 0.05, -1.1],
  name: '右透镜',
});

// 6. 显示屏/主板
const pcbGeo = new THREE.BoxGeometry(1.6, 0.7, 0.06);
const pcbMesh = new THREE.Mesh(pcbGeo, materials.pcb);
createPart({
  mesh: pcbMesh,
  homePos: [0, 0.05, -0.05],
  explodePos: [0, 0.05, -0.95],
  name: '主板/显示屏',
});

// 7. 前置摄像头（左右两颗 + 中间一颗）
const camGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 24);
camGeo.rotateX(Math.PI / 2);

const leftCam = new THREE.Mesh(camGeo, materials.camera);
createPart({
  mesh: leftCam,
  homePos: [-0.75, 0.18, 0.68],
  explodePos: [-0.95, 0.35, 1.8],
  name: '左摄像头',
});

const rightCam = new THREE.Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: rightCam,
  homePos: [0.75, 0.18, 0.68],
  explodePos: [0.95, 0.35, 1.8],
  name: '右摄像头',
});

const centerCam = new THREE.Mesh(camGeo.clone(), materials.camera);
createPart({
  mesh: centerCam,
  homePos: [0, 0.28, 0.68],
  explodePos: [0, 0.55, 1.9],
  name: '中置摄像头',
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
  name: '下置追踪摄像头',
});
addCamLens(bottomCam, 0.045);

// 9. 头带臂（左右）
const armGeo = new RoundedBoxGeometry(0.25, 0.7, 0.18, 2, 0.04);
const leftArm = new THREE.Mesh(armGeo, materials.strapArm);
createPart({
  mesh: leftArm,
  homePos: [-1.25, 0, 0],
  explodePos: [-2.1, 0, 0],
  name: '左头带臂',
});

const rightArm = new THREE.Mesh(armGeo.clone(), materials.strapArm);
createPart({
  mesh: rightArm,
  homePos: [1.25, 0, 0],
  explodePos: [2.1, 0, 0],
  name: '右头带臂',
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
  name: '头带',
});

// ===== 自定义模型处理 =====
const customModelGroup = new THREE.Group();
scene.add(customModelGroup);
let customModelParts = []; // 存储自定义模型的部件
let hasCustomModel = false;

// ===== 模型自动拆分系统 =====

// Union-Find 数据结构（用于连通分量分析）
class UnionFind {
  constructor(size) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

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
  newGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  if (newNormals) newGeo.setAttribute('normal', new THREE.Float32BufferAttribute(newNormals, 3));
  if (newUVs) newGeo.setAttribute('uv', new THREE.Float32BufferAttribute(newUVs, 2));
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

  const maxAxis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');
  const axisSize = size[maxAxis];
  if (axisSize < 0.001) return [];

  const getter = maxAxis === 'x' ? 'getX' : (maxAxis === 'y' ? 'getY' : 'getZ');
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

// 根据位置生成部件名称
function generatePartName(index, position, bbox) {
  const center = bbox.getCenter(new THREE.Vector3());
  const dx = position.x - center.x;
  const dy = position.y - center.y;
  const dz = position.z - center.z;

  const absX = Math.abs(dx), absY = Math.abs(dy), absZ = Math.abs(dz);
  const maxAbs = Math.max(absX, absY, absZ);

  let direction;
  if (maxAbs < bbox.getSize(new THREE.Vector3()).length() * 0.05) {
    direction = '中心';
  } else if (absX === maxAbs) {
    direction = dx > 0 ? '右侧' : '左侧';
  } else if (absY === maxAbs) {
    direction = dy > 0 ? '顶部' : '底部';
  } else {
    direction = dz > 0 ? '前方' : '后方';
  }
  return `部件${index + 1}·${direction}`;
}

// 自动拆分编排器：收集 mesh，按材质和连通分量准确拆分
function autoSplitModel(model) {
  // 第一步：收集所有 mesh 及其世界变换
  const rawMeshes = [];
  model.traverse((child) => {
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
        const newMesh = new THREE.Mesh(gr.geometry, Array.isArray(material) ? (material[gr.materialIndex] || material[0]) : material);
        newMesh.matrix.copy(mesh.matrixWorld);
        newMesh.matrixAutoUpdate = false;
        splitParts.push({ mesh: newMesh, name: '', isOriginal: false });
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
        splitParts.push({ mesh: newMesh, name: '', isOriginal: false });
      }
      continue;
    }

    // 无法自然拆分，保留原始 mesh（不强制空间切分，保持准确）
    splitParts.push({ mesh, name: mesh.name || '', isOriginal: true });
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

// 为自定义模型生成动态步骤
function generateCustomStepGroups(customParts, fileName) {
  const partCount = customParts.length;
  // 步骤数：欢迎(1) + 部件分组 + 完成(1)，最多 8 步
  const groupCount = Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);

  const groups = [];

  // 步骤 0：欢迎
  groups.push({
    name: '👋 模型概览',
    parts: [],
    tools: [],
    description: `已加载模型：<strong>${fileName}</strong><br><br>
📦 检测到 <strong>${partCount}</strong> 个独立部件<br>
🤖 已自动完成拆分分析<br><br>
💡 点击"下一步"开始逐步拆解，或点击"爆炸视图"一键展开。`
  });

  // 按距离中心排序（外层先拆）
  const sortedParts = [...customParts].sort((a, b) => {
    const distA = (a.partCenter || a.homePos).length();
    const distB = (b.partCenter || b.homePos).length();
    return distB - distA; // 距离远的先拆
  });

  // 将部件分组到各步骤
  const partsPerGroup = Math.ceil(partCount / groupCount);
  for (let g = 0; g < groupCount; g++) {
    const groupParts = sortedParts.slice(g * partsPerGroup, (g + 1) * partsPerGroup);
    const partNames = groupParts.map(p => p.name);
    groups.push({
      name: `${g + 1}️⃣ 第 ${g + 1} 组部件`,
      parts: partNames,
      tools: ['🖱️ 鼠标拖拽旋转', '🔍 滚轮缩放观察'],
      description: `正在拆解第 ${g + 1} 组（共 ${groupCount} 组）<br><br>
📦 本组包含 ${groupParts.length} 个部件：<br>
${partNames.map(n => `• ${n}`).join('<br>')}<br><br>
💡 拖动旋转视角，仔细观察每个部件的细节。`
    });
  }

  // 最后一步：完成
  groups.push({
    name: '🎉 拆解完成',
    parts: [],
    tools: [],
    description: `拆解完成！共展示 ${partCount} 个部件。<br><br>
💡 你可以：<br>
• 点击"爆炸视图"重新展开<br>
• 点击"重置"回到初始状态<br>
• 拖动"爆炸深度"滑块控制展开程度<br>
• 上传新的模型继续探索`
  });

  return groups;
}

// ===== Quest 3 原始 15 部位名称及归一化位置模板 =====
// 从共享配置文件 quest3_config.json 加载，回退到内置默认值
// 坐标系: X=左右 Y=上下 Z=前后, 归一化到 [-1, 1]
// 模型包围盒: X[-1.25,1.25] Y[-0.575,1.6] Z[-0.64,0.72]
// 中心=(0, 0.5125, 0.04) 半幅=(1.25, 1.0875, 0.68)
let QUEST3_PART_TEMPLATES = [
  { name: '主机身',           pos: [ 0.00, -0.47, -0.06] },
  { name: '前面板',           pos: [ 0.00, -0.47,  0.75] },
  { name: '面罩海绵',         pos: [ 0.00, -0.47, -0.87] },
  { name: '左透镜模组',       pos: [-0.42, -0.43, -0.24] },
  { name: '右透镜模组',       pos: [ 0.42, -0.43, -0.24] },
  { name: '左透镜',           pos: [-0.42, -0.43, -0.56] },
  { name: '右透镜',           pos: [ 0.42, -0.43, -0.56] },
  { name: '主板',             pos: [ 0.00, -0.43, -0.13] },
  { name: '左摄像头',         pos: [-0.60, -0.31,  0.94] },
  { name: '右摄像头',         pos: [ 0.60, -0.31,  0.94] },
  { name: '中置摄像头',       pos: [ 0.00, -0.21,  0.94] },
  { name: '下置追踪摄像头',   pos: [ 0.00, -0.79,  0.82] },
  { name: '左头带臂',         pos: [-1.00, -0.47, -0.06] },
  { name: '右头带臂',         pos: [ 1.00, -0.47, -0.06] },
  { name: '头带',             pos: [ 0.00,  0.45, -0.59] },
];

// 异步加载共享配置文件，覆盖内置默认值
fetch('quest3_config.json')
  .then(r => r.json())
  .then(cfg => {
    if (cfg.parts && cfg.parts.length > 0) {
      QUEST3_PART_TEMPLATES = cfg.parts;
      console.log(`📋 已加载 quest3_config.json (${cfg.parts.length} 个部位)`);
    }
  })
  .catch(() => {
    console.log('📋 使用内置 Quest 3 配置（quest3_config.json 不可用）');
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
    Math.max(size.z / 2, 0.001)
  );

  // 将每个部件的中心位置归一化到 [-1, 1]
  const normalizedCenters = parts.map(part => {
    return new THREE.Vector3(
      part.partCenter.x / halfExtents.x,
      part.partCenter.y / halfExtents.y,
      part.partCenter.z / halfExtents.z
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

  console.log('🏷️ Quest 3 部件名称匹配结果:',
    parts.map((p, i) => ({ name: assignments[i], center: p.partCenter.toArray().map(v => v.toFixed(2)) }))
  );

  return assignments;
}

/** 检查文件名是否包含 Quest 3（不区分大小写） */
function isQuest3Model(fileName) {
  const lower = (fileName || '').toLowerCase();
  return lower.includes('quest 3') || lower.includes('quest3');
}

/**
 * 合并多个 BufferGeometry 为一个（手动拼接 position/normal/uv 属性）
 * @param {THREE.BufferGeometry[]} geometries
 * @returns {THREE.BufferGeometry}
 */
function mergeGeometries(geometries) {
  if (geometries.length === 0) return new THREE.BufferGeometry();
  if (geometries.length === 1) return geometries[0].clone();

  // 统一转为非索引几何体
  const nonIndexed = geometries.map(g => g.index ? g.toNonIndexed() : g);

  // 确定要合并的属性
  const attrNames = ['position', 'normal', 'uv'];
  const activeAttrs = attrNames.filter(name =>
    nonIndexed.every(g => g.attributes[name])
  );

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
    Math.max(size.z / 2, 0.001)
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

    let bestT = 0, bestDist = Infinity;
    for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
      const tpl = QUEST3_PART_TEMPLATES[t];
      const dx = nx - tpl.pos[0];
      const dy = ny - tpl.pos[1];
      const dz = nz - tpl.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      if (dist < bestDist) { bestDist = dist; bestT = t; }
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
      const material = Array.isArray(firstMesh.material) ? firstMesh.material[0] : firstMesh.material;
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
  model.traverse((child) => {
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
    Math.max(size.z / 2, 0.001)
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
      let bestT = 0, bestDist = Infinity;
      for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
        const tpl = QUEST3_PART_TEMPLATES[t];
        const dx = nx - tpl.pos[0];
        const dy = ny - tpl.pos[1];
        const dz = nz - tpl.pos[2];
        const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
        if (dist < bestDist) { bestDist = dist; bestT = t; }
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
    let bestSourceT = -1, bestSourceDist = Infinity;
    for (let s = 0; s < QUEST3_PART_TEMPLATES.length; s++) {
      if (s === t || templateFaces[s].faces.length === 0) continue;
      const sPos = QUEST3_PART_TEMPLATES[s].pos;
      const dx = emptyPos[0] - sPos[0];
      const dy = emptyPos[1] - sPos[1];
      const dz = emptyPos[2] - sPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      if (dist < bestSourceDist) { bestSourceDist = dist; bestSourceT = s; }
    }

    if (bestSourceT === -1) continue;

    // 按到空模板的距离升序排列源模板的所有面
    const sourceFaces = templateFaces[bestSourceT].faces;
    sourceFaces.sort((a, b) => {
      const da = Math.sqrt(
        (a.nx - emptyPos[0]) ** 2 +
        (a.ny - emptyPos[1]) ** 2 * 0.7 +
        (a.nz - emptyPos[2]) ** 2
      );
      const db = Math.sqrt(
        (b.nx - emptyPos[0]) ** 2 +
        (b.ny - emptyPos[1]) ** 2 * 0.7 +
        (b.nz - emptyPos[2]) ** 2
      );
      return da - db;
    });

    // 借取最近的 15% 面（至少 5 个，最多 50%）
    const stealCount = Math.max(
      5,
      Math.min(Math.floor(sourceFaces.length * 0.15), Math.floor(sourceFaces.length * 0.5))
    );
    const stolenFaces = sourceFaces.splice(0, stealCount);
    templateFaces[t].faces = stolenFaces;
    if (!templateFaces[t].material && templateFaces[bestSourceT].material) {
      templateFaces[t].material = templateFaces[bestSourceT].material;
    }

    console.log(`🔄 面重分配: "${QUEST3_PART_TEMPLATES[t].name}" 从 "${QUEST3_PART_TEMPLATES[bestSourceT].name}" 借取 ${stealCount} 个面`);
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
    showStatus('📦 正在解析 STL 模型...', 'info');

    const STLLoaderClass = await loadSTLLoader();
    const loader = new STLLoaderClass();
    const geometry = loader.parse(arrayBuffer);

    // 清除之前的自定义模型
    while (customModelGroup.children.length > 0) {
      customModelGroup.remove(customModelGroup.children[0]);
    }
    customModelParts = [];
    customModelGroup.scale.set(1, 1, 1);
    customModelGroup.position.set(0, 0, 0);

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
    if (typeof updateStepUI === 'function') updateStepUI();
    showStatus('✅ STL 模型加载完成（单部件）\n💡 提示: 启动 Blender 后端可获得自动拆解', 'success');

    // ========== 自动放大微小的模型 ==========
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
      console.log(`🔍 STL 模型自动放大 ${autoScale.toFixed(1)} 倍`);
    }

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // 自动开启爆炸模式
    goToStep(totalSteps);
    isExploded = true;
    if (typeof explodeBtn !== 'undefined') {
      explodeBtn.classList.add('exploded');
      explodeBtn.textContent = '🔄 合体';
    }

    console.log(`✅ STL 模型加载完成：${fileName}`);

  } catch (err) {
    console.error('STL 加载错误:', err);
    showStatus(`❌ STL 加载失败: ${err.message}`, 'error');
  }
}

// ===== URDF 模型加载 =====
async function loadURDFModel(urdfText, fileName) {
  try {
    showStatus('🔍 正在解析 URDF 结构...', 'info');

    // 解析 URDF XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(urdfText, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('URDF XML 解析错误');
    }

    // 提取所有 links
    const linkEls = doc.querySelectorAll('link');
    if (linkEls.length === 0) {
      throw new Error('URDF 中未找到任何 link');
    }

    // 提取所有 joints（建立父子关系）
    const jointEls = doc.querySelectorAll('joint');
    const jointMap = {}; // child_link_name -> joint info
    jointEls.forEach(joint => {
      const jointType = joint.getAttribute('type') || 'fixed';
      const parent = joint.querySelector('parent')?.getAttribute('link');
      const child = joint.querySelector('child')?.getAttribute('link');
      const origin = joint.querySelector('origin');
      const originXYZ = origin?.getAttribute('xyz')?.trim().split(/\s+/).map(parseFloat) || [0, 0, 0];
      const originRPY = origin?.getAttribute('rpy')?.trim().split(/\s+/).map(parseFloat) || [0, 0, 0];
      const jointName = joint.getAttribute('name') || 'joint';
      if (child) {
        jointMap[child] = { parent, child, type: jointType, xyz: originXYZ, rpy: originRPY, name: jointName };
      }
    });

    // ── 辅助函数：从 xyz + rpy 构建 4×4 变换矩阵 ──
    function makeTransform(xyz, rpy) {
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3(xyz[0], xyz[1], xyz[2]);
      const euler = new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX');
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
      const name = linkEl.getAttribute('name');
      if (name) computeLinkWorldMatrix(name);
    });

    // 清除之前的自定义模型
    while (customModelGroup.children.length > 0) {
      customModelGroup.remove(customModelGroup.children[0]);
    }
    customModelParts = [];
    customModelGroup.scale.set(1, 1, 1);
    customModelGroup.position.set(0, 0, 0);

    // ── 为每个 link 创建 mesh，变换烘焙到几何体 ──
    const splitParts = [];
    let partIndex = 0;

    linkEls.forEach(linkEl => {
      const linkName = linkEl.getAttribute('name') || `link_${partIndex}`;

      // 获取 visual geometry 信息
      const visual = linkEl.querySelector('visual');
      const geometryEl = visual?.querySelector('geometry');
      const meshEl = geometryEl?.querySelector('mesh');
      const meshFile = meshEl?.getAttribute('filename') || '';

      // 获取 visual origin
      const visOrigin = visual?.querySelector('origin');
      const visXYZ = visOrigin?.getAttribute('xyz')?.trim().split(/\s+/).map(parseFloat) || [0, 0, 0];
      const visRPY = visOrigin?.getAttribute('rpy')?.trim().split(/\s+/).map(parseFloat) || [0, 0, 0];

      // 获取 box/cylinder/sphere 尺寸
      const boxEl = geometryEl?.querySelector('box');
      const cylEl = geometryEl?.querySelector('cylinder');
      const sphereEl = geometryEl?.querySelector('sphere');

      // 创建几何体
      let geometry;
      if (boxEl) {
        const size = boxEl.getAttribute('size')?.trim().split(/\s+/).map(parseFloat) || [0.1, 0.1, 0.1];
        geometry = new THREE.BoxGeometry(size[0] || 0.1, size[1] || 0.1, size[2] || 0.1);
      } else if (cylEl) {
        const radius = parseFloat(cylEl.getAttribute('radius')) || 0.05;
        const length = parseFloat(cylEl.getAttribute('length')) || 0.1;
        geometry = new THREE.CylinderGeometry(radius, radius, length, 32);
        geometry.rotateX(Math.PI / 2); // URDF 圆柱沿 Z 轴
      } else if (sphereEl) {
        const radius = parseFloat(sphereEl.getAttribute('radius')) || 0.05;
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
      showStatus('🔧 Quest 3 模型：按 15 部位聚类合并...', 'info');
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
      let explodeDir;
      const distFromCenter = partCenter.length();
      if (distFromCenter < 0.001) {
        const angle = (i / splitParts.length) * Math.PI * 2;
        explodeDir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
      } else {
        explodeDir = partCenter.clone().normalize();
      }

      const initialDist = Math.max(distFromCenter * 3, 1.0);
      const explodePos = explodeDir.multiplyScalar(initialDist);

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

    // 生成动态步骤
    stepGroups = generateCustomStepGroups(customModelParts, fileName);
    totalSteps = stepGroups.length;
    currentStep = 0;
    displayedStep = 0;
    animatingStep = 0;

    // 更新 UI
    updateCustomModelUI(partCount, fileName);
    updateStepUI();

    const meshNote = partCount > 0 && splitParts[0]?.mesh?.userData?.meshFile
      ? `\n⚠️ 注意: URDF 引用的 mesh 文件 (${splitParts[0].mesh.userData.meshFile}) 需单独上传\n当前使用占位几何体`
      : '';
    showStatus(`✅ URDF 解析完成：${partCount} 个 link（部件）${meshNote}`, 'success');

    // ========== 自动放大微小的模型 ==========
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
      console.log(`🔍 URDF 模型自动放大 ${autoScale.toFixed(1)} 倍`);
    }

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // ========== 智能调整爆炸距离 ==========
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
      console.log('✅ URDF 爆炸距离已智能调整');
    });

    // 自动开启爆炸模式
    goToStep(totalSteps);
    isExploded = true;
    explodeBtn.classList.add('exploded');
    explodeBtn.textContent = '🔄 合体';

    console.log(`✅ URDF 模型加载完成：${partCount} 个部件`);

  } catch (err) {
    console.error('URDF 加载错误:', err);
    showStatus(`❌ URDF 解析失败: ${err.message}`, 'error');
  }
}

async function loadCustomModel(arrayBuffer, fileName, blenderManifest = null) {
  try {
    const splitMethod = blenderManifest ? 'Blender CLI' : '前端 JS';
    showStatus(`📦 正在解析模型（${splitMethod}）...`, 'info');

    const LoaderClass = await loadGLTFLoader();
    const loader = new LoaderClass();

    const gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, (err) => reject(new Error('解析失败：' + err.message)));
    });

    // 清除之前的自定义模型
    while (customModelGroup.children.length > 0) {
      customModelGroup.remove(customModelGroup.children[0]);
    }
    customModelParts = [];
    customModelGroup.scale.set(1, 1, 1);
    customModelGroup.position.set(0, 0, 0);

    const model = gltf.scene;
    model.updateMatrixWorld(true);

    const isQ3 = isQuest3Model(fileName);

    // ========== 自动拆分 ==========
    let splitParts;
    if (isQ3 && !blenderManifest) {
      // Quest 3 模型且无 Blender 清单（Blender 不可用时回退）：前端按 15 区域切割
      showStatus('🔍 Quest 3 模型：前端按 15 部位区域切割...', 'info');
      splitParts = splitModelToQuest3Regions(model);
    } else {
      showStatus('🔍 正在分析模型结构并自动拆分...', 'info');
      splitParts = autoSplitModel(model);
    }

    if (splitParts.length === 0) {
      throw new Error('模型中未找到可渲染的网格');
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
      let explodeDir;
      const distFromCenter = partCenter.length();
      if (distFromCenter < 0.001) {
        // 部件在中心，随机分配一个方向
        const angle = (i / splitParts.length) * Math.PI * 2;
        explodeDir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
      } else {
        explodeDir = partCenter.clone().normalize();
      }

      // 初始爆炸距离（后面会用智能计算调整）
      const initialDist = Math.max(distFromCenter * 3, 1.0);
      const explodePos = explodeDir.multiplyScalar(initialDist);

      customModelParts.push({
        mesh,
        homePos: new THREE.Vector3(0, 0, 0),
        explodePos,
        homeRot: new THREE.Euler(0, 0, 0),
        explodeRot: new THREE.Euler(0, 0, 0),
        name: '', // 稍后分配
        partCenter: partCenter.clone(),
        stepIndex: 1,
      });

      customModelGroup.add(mesh);
    }

    // ========== 按距离中心排序（外层先拆）==========
    // 如果有 Blender 清单，按清单顺序排列；否则按距离排序
    if (blenderManifest && blenderManifest.parts) {
      // 清单已按距离降序排列，直接使用清单顺序
      const manifestOrder = blenderManifest.parts.map((p, idx) => ({ name: p.display_name || p.name, idx }));
      // 按 manifest 顺序重排 customModelParts（根据 partCenter 匹配）
      const used = new Set();
      const reordered = [];
      for (const mp of manifestOrder) {
        // 用 center 匹配
        const targetCenter = blenderManifest.parts[mp.idx].center;
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < customModelParts.length; i++) {
          if (used.has(i)) continue;
          const d = customModelParts[i].partCenter.distanceTo(
            new THREE.Vector3(targetCenter[0], targetCenter[1], targetCenter[2])
          );
          if (d < bestDist) { bestDist = d; bestIdx = i; }
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
          part.name = blenderManifest.parts[i].display_name || blenderManifest.parts[i].name || `部件${i + 1}`;
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
          part.name = blenderManifest.parts[i].display_name || blenderManifest.parts[i].name || `部件${i + 1}`;
        } else {
          const origName = splitParts.find(sp => sp.mesh === part.mesh)?.name;
          if (origName && !origName.startsWith('部件')) {
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

    // 隐藏默认模型
    questGroup.visible = false;

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
    showStatus(`✅ 成功加载：${fileName}\n自动拆分为 ${partCount} 个部件`, 'success');

    // ========== 自动放大微小的模型 ==========
    const autoBox = new THREE.Box3().setFromObject(customModelGroup);
    const autoSize = new THREE.Vector3();
    autoBox.getSize(autoSize);
    const autoMaxDim = Math.max(autoSize.x, autoSize.y, autoSize.z);

    let autoScale = 1.0;
    if (autoMaxDim < 5.0) {
      autoScale = 10.0 / autoMaxDim;
      autoScale = Math.min(autoScale, 20);
    }

    if (autoScale > 1.0) {
      customModelGroup.scale.set(autoScale, autoScale, autoScale);
      console.log(`🔍 模型自动放大 ${autoScale.toFixed(1)} 倍`);
    }

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // ========== 智能调整爆炸距离 ==========
    requestAnimationFrame(() => {
      const groupScale = customModelGroup.scale.x || 1;
      for (let i = 0; i < customModelParts.length; i++) {
        const part = customModelParts[i];
        // 防止零向量 normalize 产生 NaN
        let explodeDir = part.explodePos.clone();
        if (explodeDir.length() < 0.001) {
          // 用 partCenter 方向替代
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
      console.log('✅ 爆炸距离已智能调整');
    });

    // 自动开启爆炸模式
    goToStep(totalSteps);
    isExploded = true;
    explodeBtn.classList.add('exploded');
    explodeBtn.textContent = '🔄 合体';

    console.log(`✅ 自定义模型加载完成：${partCount} 个部件（自动拆分，${groupCount} 个步骤组）`);
  } catch (err) {
    console.error('加载模型失败：', err);
    showStatus(`❌ 加载失败：${err.message}`, 'error');
  }
}

function updateCustomModelUI(partCount, fileName) {
  const countEl = document.getElementById('part-count');
  if (countEl) countEl.textContent = partCount;

  const uploadSection = document.querySelector('.upload-section');
  if (uploadSection) {
    const fileNameEl = document.getElementById('uploaded-file-name');
    if (fileNameEl) fileNameEl.textContent = `当前模型：${fileName}`;
  }

  const clearBtn = document.getElementById('clear-model-btn');
  if (clearBtn) clearBtn.style.display = 'inline-block';

  // 更新时间轴总数
  const timelineTotalEl = document.getElementById('timeline-total');
  if (timelineTotalEl) timelineTotalEl.textContent = totalSteps;

  // 更新时间轴滑块范围
  if (timelineSlider) {
    timelineSlider.max = totalSteps;
  }
}

function clearCustomModel() {
  while (customModelGroup.children.length > 0) {
    customModelGroup.remove(customModelGroup.children[0]);
  }
  customModelParts = [];
  hasCustomModel = false;
  customModelGroup.scale.set(1, 1, 1);
  customModelGroup.position.set(0, 0, 0);

  // 恢复默认模型可见性
  questGroup.visible = true;

  // 恢复默认步骤系统
  stepGroups = defaultStepGroups;
  totalSteps = stepGroups.length;
  currentStep = 0;
  displayedStep = 0;
  animatingStep = 0;

  // 恢复 UI
  const countEl = document.getElementById('part-count');
  if (countEl) countEl.textContent = '15';

  const timelineTotalEl = document.getElementById('timeline-total');
  if (timelineTotalEl) timelineTotalEl.textContent = totalSteps;

  if (timelineSlider) {
    timelineSlider.max = totalSteps;
    timelineSlider.value = 0;
  }

  const clearBtn = document.getElementById('clear-model-btn');
  if (clearBtn) clearBtn.style.display = 'none';

  const status = document.getElementById('upload-status');
  if (status) {
    status.classList.add('hidden');
    status.textContent = '';
  }

  const fileNameEl = document.getElementById('uploaded-file-name');
  if (fileNameEl) fileNameEl.textContent = '';

  // 重置爆炸状态
  isExploded = false;
  if (explodeBtn) {
    explodeBtn.classList.remove('exploded');
    explodeBtn.textContent = '💥 爆炸视图';
  }

  // 重新分配 Quest 3 部件的步骤索引
  parts.forEach((part) => {
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

  showStatus('已清除自定义模型，恢复默认', 'info');
  console.log('✅ 已恢复默认 Quest 3 模型和步骤系统');
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
    toolsListEl.innerHTML = '<div class="tools-none">✅ 本步骤无需工具</div>';
  } else {
    toolsListEl.innerHTML = tools.map(tool =>
      `<div class="tool-item">${tool}</div>`
    ).join('');
  }
}

// defaultStepGroups 已从 ./src/quest3-steps.js 导入
let totalSteps = stepGroups.length;
const partStepMap = new Map();

// 给每个部件分配步骤序号（默认最后一步）
parts.forEach((part) => {
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

console.log('部件步骤分配：', parts.map(p => `${p.mesh.userData.name}->步骤${p.stepIndex}`));

// ===== 步骤控制 UI =====
let currentStep = 0;      // 实际显示步骤（动画中）
let displayedStep = 0;    // 当前 UI 显示的步骤（已完成）
let animatingStep = 0;    // 动画目标步骤
let animationStart = 0;   // 动画开始时间
let animationFrom = 0;    // 动画起始步骤
let mouseFactor = 0;      // 鼠标控制炸开因子 (0-1)
let mouseControlEnabled = false; // 是否启用鼠标控制
const stepDuration = 600; // 每步动画时长（毫秒）
let isAnimating = false;

const prevBtn = document.getElementById('prev-step');
const nextBtn = document.getElementById('next-step');
const resetBtn = document.getElementById('reset-step');
const stepNumberEl = document.getElementById('step-number');
const stepNameEl = document.getElementById('step-name');
const stepDescEl = document.getElementById('step-desc');
const progressFillEl = document.getElementById('progress-fill');
const autoRotateCheck = document.getElementById('auto-rotate');

// 新增 UI 元素
const depthSlider = document.getElementById('explode-depth');
const depthValueEl = document.getElementById('depth-value');
const timelineSlider = document.getElementById('timeline-slider');
const timelineStepEl = document.getElementById('timeline-step');
const timelineTotalEl = document.getElementById('timeline-total');
const timelinePlayBtn = document.getElementById('timeline-play');
const timelineResetBtn = document.getElementById('timeline-reset');
const timelineSpeedSelect = document.getElementById('timeline-speed');
const toolsListEl = document.getElementById('tools-list');
const partTooltip = document.getElementById('part-tooltip');
const tooltipTitle = document.querySelector('.tooltip-title');
const tooltipContent = document.querySelector('.tooltip-content');

console.log('UI elements:', {
  prevBtn: !!prevBtn,
  nextBtn: !!nextBtn,
  resetBtn: !!resetBtn,
  stepNumberEl: !!stepNumberEl,
  stepNameEl: !!stepNameEl,
  stepDescEl: !!stepDescEl,
  progressFillEl: !!progressFillEl,
  autoRotateCheck: !!autoRotateCheck,
});

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// 部件高亮相关
const highlightEmissive = new THREE.Color(0x4a9eff);
const highlightScale = 1.08;
let highlightedPart = null;  // 当前高亮的部件

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
  partTooltip.classList.remove('hidden');
}

// 隐藏工具提示
function hideTooltip() {
  if (partTooltip) {
    partTooltip.classList.add('hidden');
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
    stepDescEl.innerHTML = step.description || '';
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

function goToStep(newStep) {
  newStep = THREE.MathUtils.clamp(newStep, 0, totalSteps);
  if (newStep === displayedStep || isAnimating) return;

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
  timelineSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    const step = Math.round((value / 100) * totalSteps);
    goToStep(step);
  });
}

if (timelinePlayBtn) {
  timelinePlayBtn.addEventListener('click', () => {
    if (isPlaying) {
      // 暂停
      clearInterval(playInterval);
      isPlaying = false;
      timelinePlayBtn.textContent = '▶️ 播放';
    } else {
      // 播放
      isPlaying = true;
      timelinePlayBtn.textContent = '⏸️ 暂停';

      const speed = parseFloat(timelineSpeedSelect?.value || 1);
      const interval = 700 / speed; // 每步时间

      playInterval = setInterval(() => {
        if (displayedStep >= totalSteps) {
          clearInterval(playInterval);
          isPlaying = false;
          timelinePlayBtn.textContent = '▶️ 播放';
          return;
        }
        goToStep(displayedStep + 1);
      }, interval);
    }
  });
}

if (timelineResetBtn) {
  timelineResetBtn.addEventListener('click', () => {
    if (isPlaying) {
      clearInterval(playInterval);
      isPlaying = false;
      timelinePlayBtn.textContent = '▶️ 播放';
    }
    goToStep(0);
  });
}

// 移动端检测
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

if (isMobile) {
  // 移动端优化
  document.body.classList.add('mobile-device');

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

prevBtn.addEventListener('click', () => goToStep(displayedStep - 1));
nextBtn.addEventListener('click', () => goToStep(displayedStep + 1));
resetBtn.addEventListener('click', () => goToStep(0));

// 爆炸按钮：在完全合体和完全爆炸之间切换
const explodeBtn = document.getElementById('explode-btn');
let isExploded = false;

function toggleExplode() {
  isExploded = !isExploded;
  mouseControlEnabled = isExploded;

  if (isExploded) {
    // 进入爆炸模式，启用鼠标控制
    explodeBtn.classList.add('exploded');
    explodeBtn.textContent = '🖱️ 移动鼠标控制范围';
    // 初始炸开因子为1（完全炸开）
    mouseFactor = 1;
    currentStep = totalSteps;
    displayedStep = totalSteps;
    updateStepUI();
  } else {
    // 退出爆炸模式，回到合体
    explodeBtn.classList.remove('exploded');
    explodeBtn.textContent = '💥 爆炸';
    goToStep(0);
  }
}

explodeBtn.addEventListener('click', toggleExplode);

// 爆炸深度滑块
if (depthSlider && depthValueEl) {
  depthSlider.addEventListener('input', (e) => {
    const depth = parseInt(e.target.value);
    depthValueEl.textContent = `${depth}%`;

    // 计算炸开因子 (0-1)
    const factor = depth / 100;

    // 如果不在动画中，直接应用
    if (!isAnimating) {
      currentStep = factor * totalSteps;
      displayedStep = Math.round(currentStep);
      updateStepUI();
    }

    // 更新爆炸状态
    if (depth > 0 && !isExploded) {
      isExploded = true;
      explodeBtn.classList.add('exploded');
      explodeBtn.textContent = '🔄 合体';
    } else if (depth === 0 && isExploded) {
      isExploded = false;
      explodeBtn.classList.remove('exploded');
      explodeBtn.textContent = '💥 爆炸';
    }
  });
}

// 键盘快捷键
document.addEventListener('keydown', (e) => {
  // 忽略在输入框中的按键
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case 'ArrowRight':
      e.preventDefault();
      goToStep(displayedStep + 1);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      goToStep(displayedStep - 1);
      break;
    case ' ':
      e.preventDefault();
      toggleExplode();
      break;
    case 'r':
    case 'R':
      e.preventDefault();
      goToStep(0);
      break;
    case 'a':
    case 'A':
      e.preventDefault();
      autoRotateCheck.checked = !autoRotateCheck.checked;
      controls.autoRotate = autoRotateCheck.checked;
      break;
    case 'f':
    case 'F':
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
renderer.domElement.addEventListener('mousemove', (e) => {
  if (!mouseControlEnabled) return;

  // 计算鼠标在屏幕上的相对位置（0-1）
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;

  // 使用鼠标Y轴位置控制炸开范围：鼠标越往下，炸开越大
  // 加上鼠标X轴影响，让控制更有趣
  mouseFactor = Math.max(0.1, y * 1.2); // 最小保持 0.1 的炸开

  // 更新当前步骤显示
  currentStep = mouseFactor * totalSteps;
  displayedStep = Math.round(currentStep);
  updateStepUI();
});

// 鼠标离开画布时，保持当前炸开程度
renderer.domElement.addEventListener('mouseleave', () => {
  if (mouseControlEnabled) {
    // 可选：鼠标离开时暂停控制
    // mouseControlEnabled = false;
  }
});

// 双击恢复按钮控制
explodeBtn.addEventListener('dblclick', () => {
  if (isExploded) {
    mouseControlEnabled = false;
    explodeBtn.textContent = '🔄 合体';
    console.log('已切换回按钮控制模式');
  }
});

autoRotateCheck.addEventListener('change', (e) => {
  controls.autoRotate = e.target.checked;
});

updateStepUI();

// ===== 部件动画插值 =====
function smoothStep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge0 ? 1 : 0;
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

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
  }

  // 如果启用了鼠标控制，使用鼠标因子
  const controlFactor = mouseControlEnabled ? mouseFactor : (currentStep / totalSteps);
  const globalFactor = mouseControlEnabled ? mouseFactor : (currentStep / totalSteps);
  axisMat.opacity = globalFactor * 0.5;

  // Quest 3 默认部件
  parts.forEach((part) => {
    // 计算该部件的炸开因子
    let partFactor;
    if (mouseControlEnabled) {
      // 鼠标控制模式：基于全局 mouseFactor 计算
      partFactor = smoothStep(part.stepIndex - 1, part.stepIndex, mouseFactor * totalSteps);
    } else {
      // 步骤控制模式：基于 currentStep
      partFactor = smoothStep(part.stepIndex - 1, part.stepIndex, currentStep);
    }

    part.mesh.position.lerpVectors(part.homePos, part.explodePos, partFactor);
    part.mesh.rotation.x = THREE.MathUtils.lerp(part.homeRot.x, part.explodeRot.x, partFactor);
    part.mesh.rotation.y = THREE.MathUtils.lerp(part.homeRot.y, part.explodeRot.y, partFactor);
    part.mesh.rotation.z = THREE.MathUtils.lerp(part.homeRot.z, part.explodeRot.z, partFactor);
  });

  // 自定义模型部件（渐进式拆解，每个部件有自己的 stepIndex）
  if (hasCustomModel && customModelParts.length > 0) {
    customModelParts.forEach((part) => {
      let partFactor;
      if (mouseControlEnabled) {
        partFactor = smoothStep(part.stepIndex - 1, part.stepIndex, mouseFactor * totalSteps);
      } else {
        partFactor = smoothStep(part.stepIndex - 1, part.stepIndex, currentStep);
      }

      part.mesh.position.lerpVectors(part.homePos, part.explodePos, partFactor);
      part.mesh.rotation.x = THREE.MathUtils.lerp(part.homeRot.x, part.explodeRot.x, partFactor);
      part.mesh.rotation.y = THREE.MathUtils.lerp(part.homeRot.y, part.explodeRot.y, partFactor);
      part.mesh.rotation.z = THREE.MathUtils.lerp(part.homeRot.z, part.explodeRot.z, partFactor);
    });
  }
}

// ===== 响应窗口大小 =====
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== 渲染循环 =====
function animate(now) {
  requestAnimationFrame(animate);
  updateExplodedView(now);

  // 粒子动画（缓慢旋转）
  if (particlesMesh) {
    particlesMesh.rotation.y = now * 0.00005;
    particlesMesh.rotation.x = now * 0.00003;
  }

  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// 隐藏加载提示
const loadingEl = document.getElementById('loading');
const uploadStatusEl = document.getElementById('upload-status');  // 全局上传状态元素
setTimeout(() => {
  if (loadingEl) loadingEl.classList.add('hidden');
}, 100);

// ===== 文件上传与自定义模型 =====
// 全局显示状态消息（可在 loadCustomModel 和 clearCustomModel 中调用）
function showStatus(msg, type = 'info') {
  if (!uploadStatusEl) return;
  uploadStatusEl.textContent = msg;
  uploadStatusEl.className = 'upload-status';
  uploadStatusEl.classList.remove('hidden');
  uploadStatusEl.style.background = type === 'success' ? 'rgba(76, 175, 80, 0.2)' :
                             type === 'error' ? 'rgba(244, 67, 54, 0.2)' :
                             'rgba(33, 150, 243, 0.2)';
  uploadStatusEl.style.border = `1px solid ${type === 'success' ? '#4CAF50' :
                                      type === 'error' ? '#f44336' :
                                      '#2196F3'}`;
  uploadStatusEl.style.padding = '10px 14px';
  uploadStatusEl.style.borderRadius = '8px';
  uploadStatusEl.style.marginTop = '10px';
  uploadStatusEl.style.fontSize = '13px';
  uploadStatusEl.style.lineHeight = '1.5';
}

// 等待 DOM 完全加载后再初始化上传功能
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupUpload);
} else {
  // DOM 已经加载完成
  setupUpload();
}

function setupUpload() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const clearBtn = document.getElementById('clear-model-btn');

  console.log('Upload elements:', { dropZone, fileInput, uploadBtn, clearBtn });

  // 如果找不到上传相关元素，跳过上传功能
  if (!uploadBtn || !fileInput || !dropZone) {
    console.warn('上传功能所需元素未找到，跳过上传功能初始化');
    return;
  }

  // ── Blender 后端配置 ──
  const BLENDER_SERVER = 'http://localhost:3001';

  /**
   * 尝试调用 Blender 后端拆解 GLB
   * 改进：使用 XMLHttpRequest 获取上传进度 + 二进制响应（不再 base64）
   * @param {File} file 上传的 GLB/GLTF 文件
   * @returns {Promise<{arrayBuffer: ArrayBuffer, manifest: object} | null>}
   */
  function tryBlenderSplit(file) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);

      showStatus('🔧 正在通过 Blender 拆解模型... (上传中)', 'info');

      // 上传进度
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          if (pct < 100) {
            showStatus(`📤 上传中... ${pct}% (${(e.loaded / 1024).toFixed(0)} / ${(e.total / 1024).toFixed(0)} KB)`, 'info');
          } else {
            showStatus('🔧 Blender 正在拆解模型... (已上传)', 'info');
          }
        }
      });

      xhr.addEventListener('load', () => {
        try {
          if (xhr.status !== 200) {
            // 错误响应是 JSON
            const errData = JSON.parse(xhr.responseText || '{}');
            throw new Error(errData.error || `服务器错误 ${xhr.status}`);
          }

          // 检查是否是二进制响应（成功）
          const successHeader = xhr.getResponseHeader('X-Success');
          if (successHeader !== 'true') {
            // 可能是旧的 JSON 格式，尝试解析
            const data = JSON.parse(xhr.responseText);
            if (!data.success) {
              throw new Error(data.error || '拆解失败');
            }
            // 兼容旧格式（base64）
            const binaryStr = atob(data.glb_base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            showStatus(`✅ Blender 拆解完成：${data.total_parts} 个部件 (${data.elapsed_seconds}s)`, 'success');
            resolve({ arrayBuffer: bytes.buffer, manifest: data });
            return;
          }

          // 新格式：二进制 GLB body + manifest 在 header
          const totalParts = parseInt(xhr.getResponseHeader('X-Total-Parts') || '0');
          const elapsedSeconds = parseFloat(xhr.getResponseHeader('X-Elapsed-Seconds') || '0');
          const manifestBase64 = xhr.getResponseHeader('X-Manifest') || '';

          // 解析 manifest（base64 → JSON）
          let manifest = null;
          if (manifestBase64) {
            const manifestJson = atob(manifestBase64);
            manifest = JSON.parse(manifestJson);
          } else {
            throw new Error('响应中缺少 manifest 头');
          }

          showStatus(`✅ Blender 拆解完成：${totalParts} 个部件 (${elapsedSeconds}s)`, 'success');

          resolve({
            arrayBuffer: xhr.response,
            manifest,
          });
        } catch (err) {
          console.warn('Blender 响应解析失败:', err.message);
          resolve(null);
        }
      });

      xhr.addEventListener('error', () => {
        console.warn('Blender 后端不可用，回退到 JS 拆解: 网络错误');
        resolve(null);
      });

      xhr.addEventListener('timeout', () => {
        console.warn('Blender 后端超时，回退到 JS 拆解');
        resolve(null);
      });

      xhr.responseType = 'arraybuffer';
      xhr.timeout = 600000; // 10 分钟
      xhr.open('POST', `${BLENDER_SERVER}/api/split`);
      xhr.send(formData);
    });
  }

  async function handleFile(file) {
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    if (!['glb', 'gltf', 'stl', 'urdf'].includes(ext)) {
      showStatus('❌ 不支持的文件格式\n请上传 .glb / .gltf / .stl / .urdf 文件', 'error');
      return;
    }

    if (file.size > 100 * 1024 * 1024) {
      showStatus('❌ 文件太大\n请上传小于 100MB 的文件', 'error');
      return;
    }

    // URDF 文件：前端解析 XML 结构
    if (ext === 'urdf') {
      showStatus('📦 正在解析 URDF 文件...', 'info');
      const reader = new FileReader();
      reader.onload = (e) => {
        loadURDFModel(e.target.result, file.name);
      };
      reader.onerror = () => showStatus('❌ 读取文件失败', 'error');
      reader.readAsText(file);
      return;
    }

    // STL 文件：前端 STLLoader 加载，或送 Blender 拆解
    if (ext === 'stl') {
      // 优先尝试 Blender 后端拆解
      const blenderResult = await tryBlenderSplit(file);
      if (blenderResult) {
        loadCustomModel(blenderResult.arrayBuffer, file.name, blenderResult.manifest);
        return;
      }
      // 回退：前端 STLLoader 直接加载（单部件）
      showStatus('⏳ 正在用前端加载 STL 模型...', 'info');
      const reader = new FileReader();
      reader.onload = (e) => {
        loadSTLModel(e.target.result, file.name);
      };
      reader.onerror = () => showStatus('❌ 读取文件失败', 'error');
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
    showStatus('⏳ 正在用前端 JS 拆解模型...', 'info');

    const reader = new FileReader();
    reader.onload = (e) => {
      loadCustomModel(e.target.result, file.name, null);
    };
    reader.onerror = () => showStatus('❌ 读取文件失败', 'error');
    reader.readAsArrayBuffer(file);
  }

  // 点击上传按钮
  uploadBtn.addEventListener('click', () => fileInput.click());

  // 文件选择
  fileInput.addEventListener('change', (e) => {
    handleFile(e.target.files[0]);
    e.target.value = ''; // 重置 input
  });

  // 拖拽上传
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#4a9eff';
    dropZone.style.background = 'rgba(74, 158, 255, 0.1)';
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '';
    dropZone.style.background = '';
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '';
    dropZone.style.background = '';
    const file = e.dataTransfer.files[0];
    handleFile(file);
  });

  // 清除自定义模型
  if (clearBtn) {
    clearBtn.addEventListener('click', clearCustomModel);
  }

  console.log('文件上传功能已启用');
}

// ===== 主题切换 =====
const themeToggle = document.getElementById('theme-toggle');
const uiOverlay = document.querySelector('.ui-overlay');

if (themeToggle && uiOverlay) {
  // 检查本地存储的主题设置
  const savedTheme = localStorage.getItem('quest3-theme');
  if (savedTheme === 'light') {
    uiOverlay.classList.add('light-theme');
    themeToggle.textContent = '☀️';
  }

  themeToggle.addEventListener('click', () => {
    uiOverlay.classList.toggle('light-theme');
    const isLight = uiOverlay.classList.contains('light-theme');

    // 保存主题设置
    localStorage.setItem('quest3-theme', isLight ? 'light' : 'dark');

    // 更新按钮图标
    themeToggle.textContent = isLight ? '☀️' : '🌙';

    // 添加切换动画
    themeToggle.style.transform = 'rotate(360deg) scale(1.2)';
    setTimeout(() => {
      themeToggle.style.transform = '';
    }, 300);
  });
}

// ===== 步骤描述淡入动画 =====
let lastStepDesc = '';
function updateStepDescAnimation() {
  if (!stepDescEl) return;

  const currentDesc = stepDescEl.textContent;
  if (currentDesc !== lastStepDesc) {
    stepDescEl.style.animation = 'none';
    // 触发重排
    void stepDescEl.offsetHeight;
    stepDescEl.style.animation = 'fadeInUp 0.5s ease-out';
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
  if (!('xr' in navigator)) {
    console.log('WebXR not supported');
    return false;
  }

  try {
    const isSupported = await navigator.xr.isSessionSupported('immersive-ar');
    arSupported = isSupported;
    console.log('WebXR AR supported:', isSupported);
    return isSupported;
  } catch (err) {
    console.error('Error checking AR support:', err);
    return false;
  }
}

// 显示/隐藏 AR 按钮
function updateARButton() {
  if (arButton) {
    if (arSupported && !arSession) {
      arButton.style.display = 'inline-block';
      arButton.disabled = false;
      arButton.title = '在 AR 中预览 Quest 3';
    } else {
      arButton.style.display = 'none';
    }
  }
}

// 启动 AR 会话
async function startAR() {
  if (!arSupported) {
    alert('您的设备不支持 AR 功能\n\n支持的设备：\n- Android Chrome\n- iOS Safari 15+\n\n请确保使用 HTTPS 访问。');
    return;
  }

  try {
    // 请求 AR 会话
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay', 'light-estimation'],
      domOverlay: { root: document.body }
    });

    arSession = session;

    // 更新按钮状态
    if (arButton) {
      arButton.textContent = '🚪 退出 AR';
      arButton.classList.add('active');
    }

    // 隐藏 UI 面板
    if (uiOverlay) {
      uiOverlay.style.display = 'none';
    }

    // 设置 AR 渲染器
    const arRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true
    });
    arRenderer.setPixelRatio(window.devicePixelRatio);
    arRenderer.setSize(window.innerWidth, window.innerHeight);
    arRenderer.xr.enabled = true;
    arRenderer.xr.setReferenceSpaceType('local-floor');

    // 替换画布：移除原有 canvas，添加 AR 渲染器的 canvas
    container.innerHTML = '';
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
    const arCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    // 启用 hit-test：先设置 session，再初始化 hit-test source
    session.addEventListener('end', onAREnd);
    await arRenderer.xr.setSession(session);

    // 初始化 hit-test source（之前缺失，导致 getHitTestResults 始终失败）
    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      arHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    } catch (err) {
      console.warn('Hit-test source 初始化失败，模型将放置在默认位置:', err);
    }

    // 从 AR 克隆中收集部件引用（避免修改原始场景的 mesh）
    const arParts = [];
    const cloneMeshMap = new Map();
    arQuestGroup.traverse((child) => {
      if (child.isMesh && child.userData.name) {
        cloneMeshMap.set(child.userData.name, child);
      }
    });
    parts.forEach((part) => {
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

              part.mesh.position.lerpVectors(
                part.homePos,
                part.explodePos,
                factor * 0.5
              );
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

    console.log('AR session started');

  } catch (err) {
    console.error('Failed to start AR:', err);
    alert('启动 AR 失败：' + err.message + '\n\n请确保：\n1. 使用 HTTPS\n2. 设备支持 AR\n3. 授予相机权限');
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
    console.error('结束 AR 会话时出错:', err);
  }

  // 恢复普通渲染器
  location.reload();
}

// 初始化 AR
async function initAR() {
  const supported = await checkARSupport();

  if (supported) {
    arButton = document.getElementById('ar-btn');
    if (arButton) {
      // 绑定 AR 按钮事件（之前在模块顶层绑定，但此时 arButton 尚为 null，导致事件从未绑定）
      arButton.addEventListener('click', () => {
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
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAR);
} else {
  initAR();
}
