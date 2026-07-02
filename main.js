import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';

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

// 从物体的包围盒中心计算爆炸方向
function computeExplodeDirection(mesh, groupCenter) {
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  const dir = worldPos.clone().sub(groupCenter).normalize();
  const dist = worldPos.distanceTo(groupCenter) * 2.5;
  return dir.multiplyScalar(dist);
}

async function loadCustomModel(arrayBuffer, fileName) {
  try {
    const loader = await loadGLTFLoader();
    const blob = new Blob([arrayBuffer]);
    const url = URL.createObjectURL(blob);

    const gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, (err) => reject(new Error('解析失败：' + err.message)));
    });

    // 清除之前的自定义模型
    while (customModelGroup.children.length > 0) {
      customModelGroup.remove(customModelGroup.children[0]);
    }
    customModelParts = [];

    const model = gltf.scene;

    // 计算所有 mesh 的中心包围盒
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());

    // 遍历所有 Mesh
    let partIndex = 0;
    model.traverse((child) => {
      if (child.isMesh) {
        // 保存原始材质
        const origMat = child.material;

        // 计算爆炸方向
        const worldPos = new THREE.Vector3();
        child.getWorldPosition(worldPos);
        const homePos = worldPos.clone().sub(center); // 相对于中心
        const explodeDir = worldPos.clone().sub(center).normalize();
        const explodeDist = worldPos.distanceTo(center) * 3;
        const explodePos = explodeDir.multiplyScalar(explodeDist);

        // 保存引用
        child.userData = { name: `${fileName}_part${partIndex}` };
        child.castShadow = true;
        child.receiveShadow = true;

        customModelParts.push({
          mesh: child,
          homePos,
          explodePos,
          homeRot: child.rotation.clone(),
          explodeRot: child.rotation.clone(),
          name: child.userData.name,
        });

        partIndex++;
      }
    });

    // 隐藏原始模型，用 group 代替
    customModelGroup.position.copy(center);
    model.position.sub(center); // 将模型中心移回 (0,0,0)
    customModelGroup.add(model);

    hasCustomModel = true;
    URL.revokeObjectURL(url);

    // 更新 UI
    updateCustomModelUI(partIndex, fileName);
    showStatus(`✅ 成功加载：${fileName}\n检测到 ${partIndex} 个独立部件`, 'success');

    // 自动开启爆炸模式
    goToStep(totalSteps);
    isExploded = true;
    explodeBtn.classList.add('exploded');
    explodeBtn.textContent = '🔄 合体';

    console.log(`自定义模型加载完成：${partIndex} 个部件`);
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
}

function clearCustomModel() {
  while (customModelGroup.children.length > 0) {
    customModelGroup.remove(customModelGroup.children[0]);
  }
  customModelParts = [];
  hasCustomModel = false;

  const countEl = document.getElementById('part-count');
  if (countEl) countEl.textContent = '15';

  const clearBtn = document.getElementById('clear-model-btn');
  if (clearBtn) clearBtn.style.display = 'none';

  const status = document.getElementById('upload-status');
  if (status) {
    status.classList.add('hidden');
    status.textContent = '';
  }

  showStatus('已清除自定义模型', 'info');
}

// ===== 中心轴线（拆解时显示）=====
const axisGeo = new THREE.CylinderGeometry(0.01, 0.01, 4, 8);
axisGeo.rotateX(Math.PI / 2);
const axisMat = new THREE.MeshBasicMaterial({ color: 0x44464f, transparent: true, opacity: 0 });
const axisLine = new THREE.Mesh(axisGeo, axisMat);
questGroup.add(axisLine);

// ===== Quest 3 技术规格数据库（教学用）=====
const quest3Specs = {
  name: 'Meta Quest 3',
  releaseDate: '2023年10月',
  price: '$499.99 (128GB) / $599.99 (512GB)',
  weight: '515g',
  dimensions: '129 × 70 × 85 mm (深度 × 宽度 × 高度)',
  processor: '高通 Snapdragon XR2 Gen 2',
  gpu: 'Adreno 740 @ 750 MHz',
  memory: '8GB LPDDR5 RAM',
  storage: ['128GB', '512GB'],
  display: '2× 2064 × 2208 (LCD, RGB-stripe)',
  refreshRate: '90Hz / 120Hz (可切换)',
  fov: '约 110° (水平)',
  lenses: 'Pancake 透镜',
  ipdAdjustment: '支持电子调节',
  cameras: '2× 1000万像素 RGB + 2× 红外追踪 + 1× ToF 深度传感器',
  tracking: 'Inside-Out 6DoF追踪',
  connectivity: 'Wi-Fi 6E, Bluetooth 5.2',
  battery: '4879 mAh 锂离子电池 (约2-3小时使用)',
  os: 'Meta Horizon OS (基于Android)',
};

// ===== 分步骤拆解（教学导向，参考 iFixit 风格）=====
const stepGroups = [
  {
    name: '👋 欢迎认识 Quest 3',
    parts: [],
    tools: [],
    description: `Meta Quest 3（2023年10月发售）是 Meta 的第三代 VR 一体机。

📊 核心参数：
• 重量：${quest3Specs.weight}
• 芯片：${quest3Specs.processor}
• 屏幕：${quest3Specs.display} @ ${quest3Specs.refreshRate}
• 摄像头：${quest3Specs.cameras}

💡 点击"下一步"开始拆解之旅。用鼠标左键旋转，滚轮缩放。`
  },
  {
    name: '① 前面板 - 脸面',
    parts: ['前面板'],
    tools: ['👁️ 肉眼观察', '💡 良好的光线'],
    description: `前面板是 Quest 3 的"门面"：

🎨 设计
• 白色哑光磨砂塑料外壳
• 中央印有 Meta 标志（可反光）
• 四周有细密的散热通风口（共5条）

🔍 摄像头阵列
从左上到右下：
• 左上 + 右上：1000万像素 RGB 摄像头（彩色透视）
• 正中上方：ToF 深度传感器
• 底部：红外追踪摄像头

💡 试试在 3D 视图中找找这些摄像头！`
  },
  {
    name: '② 摄像头模组 - 眼睛',
    parts: ['左摄像头', '右摄像头', '中置摄像头', '下置追踪摄像头'],
    tools: ['🔍 放大镜（可选）', '💡 充足光线'],
    description: `Quest 3 有 **4 颗摄像头** 负责"看懂"世界：

📷 彩色透视（2颗）
• 左右各一颗 1000万像素 RGB 摄像头
• 提供高清彩色 Mixed Reality 体验
• 比 Quest 2 的黑白透视提升巨大

👁️ 追踪摄像头（2颗）
• 红外摄像头，不可见光
• 追踪头显在空间中的位置（6DoF）
• 追踪 Touch Plus 手柄

⚡ 这就是 Inside-Out 追踪的核心！`
  },
  {
    name: '③ 头带与头带臂 - 支撑',
    parts: ['左头带臂', '右头带臂', '头带'],
    tools: ['✋ 双手', '💪 轻微力气'],
    description: `佩戴舒适的关键组件：

🎯 正确佩戴方法
1. 头显放在眼睛前方
2. 头带拉到后脑勺**偏下**位置
3. 调整旋钮让重心平衡

🧩 组件说明
• 头带臂：塑料支架，连接主机身
• 柔性头带：可拉伸材质，分散重量
• 总重量 515g 均匀分布在额头和后脑勺

💡 Quest 3 的头带比 Quest 2 更短更紧凑。`
  },
  {
    name: '④ 面罩海绵 - 亲密接触',
    parts: ['面罩海绵'],
    tools: ['✋ 双手', '🔧 塑料撬棒（可选）'],
    description: `紧贴你脸部的记忆海绵：

☁️ 作用
• 阻挡外部光线，提升沉浸感
• 柔软缓冲，长时间佩戴舒适
• 防止"漏光"导致的眩晕

📦 官方配件
Meta 提供 4 种厚度可选：
• 2mm（薄）- 适合戴眼镜用户
• 4mm（标准）- 大多数人
• 6mm（厚）- 深眼窝用户
• 8mm（特厚）- 需要最大遮光

🔄 可轻松更换，撕下旧的，贴上新的。`
  },
  {
    name: '⑤ 透镜模组 - 通往虚拟世界',
    parts: ['左透镜模组', '右透镜模组'],
    tools: ['👁️ 仔细观察', '💡 旋转查看内部'],
    description: `这是 VR 头显**最重要的部件**！

🔬 Pancake 透镜技术
• 比 Quest 2 的菲涅尔透镜**更薄**
• 光路折叠设计，减少头显厚度
• 边缘画质大幅改善

📐 光学规格
• 单眼分辨率：${quest3Specs.display}
• 刷新率：${quest3Specs.refreshRate}
• 视场角（FOV）：${quest3Specs.fov}
• 屈光度调节：±50°（近视党福音！）

💡 你可以不用戴眼镜，直接调节旋钮就能看清！`
  },
  {
    name: '⑥ 主板与显示屏 - 大脑',
    parts: ['主板/显示屏'],
    tools: ['🔧 精密螺丝刀（虚拟）', '📋 耐心细致'],
    description: `Quest 3 的"大脑"和"眼睛"：

🧠 主板（绿色 PCB）
• 芯片：${quest3Specs.processor}
• 图形：${quest3Specs.gpu}
• 内存：${quest3Specs.memory}
• 存储：${quest3Specs.storage.join(' / ')}

👁️ 显示屏（主板后面）
• 2× LCD 面板（你看到的是透过透镜的像）
• ${quest3Specs.display}
• ${quest3Specs.refreshRate}
• RGB-stripe 排列（减少纱窗效应）

⚡ 散热
主板上有散热片覆盖 SoC 芯片，保持冷静运行。`
  },
  {
    name: '🎉 拆解完成！',
    parts: [],
    tools: [],
    description: `恭喜！你已经完成 Quest 3 的完整拆解之旅！

📦 总共发现了 15 个主要部件

💡 下一步你可以：
• 点击"爆炸视图"重新组合
• 点击"重置"回到初始状态
• 上传自己的 3D 模型来拆解
• 在 3D 视图中旋转观察细节

❓ 有疑问？可以问我任何关于 Quest 3 的问题！`
  },
];

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

const totalSteps = stepGroups.length;
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
    if (highlightedPart.mesh.material.emissive) {
      highlightedPart.mesh.material.emissive.setHex(0x000000);
    }
    highlightedPart.mesh.scale.setScalar(1);
  }

  // 设置新高亮
  if (partName) {
    const part = parts.find(p => p.name === partName);
    if (part) {
      highlightedPart = part;
      if (part.mesh.material.emissive) {
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

// 部件详细信息数据库
const partInfo = {
  '前面板': {
    name: '前面板 (Front Cover)',
    material: 'PC 塑料（聚碳酸酯）',
    weight: '约 45g',
    function: '保护内部组件，提供佩戴支撑',
    specs: '尺寸：129×70×12mm，白色哑光磨砂',
    funFact: 'Meta 标志在光线下会反光！'
  },
  '主机身': {
    name: '主机身 (Main Body)',
    material: 'ABS 塑料（哑光黑）',
    weight: '约 180g',
    function: '容纳所有电子组件的主框架',
    specs: '深空黑，散热通风口设计',
    funFact: '内部有精密散热系统，保持冷静运行'
  },
  '左透镜模组': {
    name: '透镜模组 (Lens Module)',
    material: 'Pancake 光学透镜 + 塑料外壳',
    weight: '约 30g/个',
    function: '将显示屏图像投射到用户眼中',
    specs: '屈光度调节范围 ±50°，FOV 110°',
    funFact: 'Pancake 技术让头显比 Quest 2 薄了 40%'
  },
  '右透镜模组': {
    name: '透镜模组 (Lens Module)',
    material: 'Pancake 光学透镜 + 塑料外壳',
    weight: '约 30g/个',
    function: '将显示屏图像投射到用户眼中',
    specs: '屈光度调节范围 ±50°，FOV 110°',
    funFact: '每个透镜模组是独立可调的！'
  },
  '左摄像头': {
    name: '彩色摄像头 (Color Camera)',
    material: '玻璃镜片 + 金属外壳',
    weight: '约 8g',
    function: '彩色透视 Mixed Reality',
    specs: '1000万像素，RGB 传感器',
    funFact: '比 Quest 2 的黑白摄像头体验提升巨大！'
  },
  '右摄像头': {
    name: '彩色摄像头 (Color Camera)',
    material: '玻璃镜片 + 金属外壳',
    weight: '约 8g',
    function: '彩色透视 Mixed Reality',
    specs: '1000万像素，RGB 传感器',
    funFact: '左右摄像头协同工作，创建立体深度'
  },
  '中置摄像头': {
    name: 'ToF 深度传感器',
    material: '红外传感器',
    weight: '约 3g',
    function: '深度感知，空间映射',
    specs: 'Time-of-Flight 传感器',
    funFact: '帮助 Quest 3 理解房间的 3D 结构'
  },
  '下置追踪摄像头': {
    name: '红外追踪摄像头',
    material: '红外镜头',
    weight: '约 3g',
    function: '6DoF 头部追踪',
    specs: '红外摄像头，追踪头显位置',
    funFact: '即使在完全黑暗中也能追踪！'
  },
  '左头带臂': {
    name: '头带臂 (Strap Arm)',
    material: '增强塑料',
    weight: '约 15g/个',
    function: '连接主机身和头带',
    specs: '可调节角度，适配不同头型',
    funFact: '支持快速拆装'
  },
  '右头带臂': {
    name: '头带臂 (Strap Arm)',
    material: '增强塑料',
    weight: '约 15g/个',
    function: '连接主机身和头带',
    specs: '可调节角度，适配不同头型',
    funFact: '与左头带臂对称设计'
  },
  '头带': {
    name: '柔性头带 (Flexible Strap)',
    material: '可拉伸硅胶/塑料混合',
    weight: '约 35g',
    function: '固定头显，分散重量',
    specs: '魔术贴可调节，适配不同头围',
    funFact: '绕到后脑勺偏下位置最舒适'
  },
  '面罩海绵': {
    name: '面罩海绵 (Face Interface)',
    material: '记忆海绵 + 磁性可更换',
    weight: '约 25g',
    function: '遮光、缓冲、舒适佩戴',
    specs: '4 种厚度可选（2/4/6/8mm）',
    funFact: '记忆海绵会根据你的脸型塑形'
  },
  '主板/显示屏': {
    name: '主板与显示屏 (Motherboard & Display)',
    material: '绿色 PCB + LCD 面板',
    weight: '约 120g',
    function: '运行系统，显示图像',
    specs: 'XR2 Gen 2 + Adreno 740 + 8GB RAM',
    funFact: '显示屏在主板后面，你看到的是透过透镜的像！'
  }
};

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
  const part = parts.find(p => p.name === partName);
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

  // 自定义模型部件（如果有）
  if (hasCustomModel && customModelParts.length > 0) {
    const customFactor = mouseControlEnabled ? mouseFactor : (currentStep / totalSteps);

    customModelParts.forEach((part) => {
      part.mesh.position.lerpVectors(part.homePos, part.explodePos, customFactor);
      part.mesh.rotation.x = THREE.MathUtils.lerp(part.homeRot.x, part.explodeRot.x, customFactor);
      part.mesh.rotation.y = THREE.MathUtils.lerp(part.homeRot.y, part.explodeRot.y, customFactor);
      part.mesh.rotation.z = THREE.MathUtils.lerp(part.homeRot.z, part.explodeRot.z, customFactor);
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

  function handleFile(file) {
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    if (!['glb', 'gltf'].includes(ext)) {
      showStatus('❌ 不支持的文件格式\n请上传 .glb 或 .gltf 文件', 'error');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      showStatus('❌ 文件太大\n请上传小于 50MB 的文件', 'error');
      return;
    }

    showStatus('⏳ 正在加载模型...', 'info');

    const reader = new FileReader();
    reader.onload = (e) => {
      loadCustomModel(e.target.result, file.name);
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
let arHitMatrix = new THREE.Matrix4();
let arModelPlaced = false;

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

    // 替换当前渲染器
    const canvas = renderer.domElement;
    renderer.domElement = arRenderer.domElement;
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

    // 启用 hit-test
    session.addEventListener('end', onAREnd);
    await arRenderer.xr.setSession(session);

    // AR 渲染循环
    arRenderer.setAnimationLoop((timestamp, frame) => {
      if (frame) {
        // 获取参考空间
        const referenceSpace = arRenderer.xr.getReferenceSpace();
        const sessionSpace = arRenderer.xr.getSession();

        // 获取 viewer 空间
        const viewerPose = frame.getViewerPose(referenceSpace);

        if (viewerPose) {
          // 更新相机
          const view = viewerPose.views[0];
          arCamera.projectionMatrix.fromArray(view.projectionMatrix);

          // 如果模型未放置，执行 hit-test
          if (!arModelPlaced && frame.getHitTestResults) {
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

          // 如果模型已放置，添加简单的爆炸效果
          if (arModelPlaced) {
            const time = timestamp * 0.001;
            const explodeFactor = (Math.sin(time * 0.5) + 1) * 0.3;

            // 应用爆炸变换
            parts.forEach((part, index) => {
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
  if (arSession) {
    arSession.end();
    arSession = null;
    arModelPlaced = false;
  }

  // 恢复普通渲染器
  location.reload();

  console.log('AR session ended');
}

// 初始化 AR
async function initAR() {
  const supported = await checkARSupport();

  if (supported) {
    arButton = document.getElementById('ar-btn');
    updateARButton();
  }
}

// 页面加载后检测 AR
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAR);
} else {
  initAR();
}

// 绑定 AR 按钮事件
if (arButton) {
  arButton.addEventListener('click', () => {
    if (arSession) {
      onAREnd();
    } else {
      startAR();
    }
  });
}
