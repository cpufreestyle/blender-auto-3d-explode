// 场景初始化（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「场景初始化」块：container / scene（背景色 + 雾）/
// 装饰网格 / 环境粒子（低功耗 150、桌面 500）/ camera / renderer /
// OrbitControls，以及 WebGL 上下文丢失与恢复两条事件监听（回调引用
// 注入的 showStatus）。lowPowerMode（触屏或移动端判定）随工厂返回：
// 灯光系统、Quest 3 默认模型构建与自定义模型加载都要读它。
//
// DI 接缝：WebGLRenderer 需要浏览器 GL 上下文，Node 测试环境构造必失败，
// 故经 createRenderer 注入（默认即原 new WebGLRenderer 调用），其余
// three 构件在 Node 可直构。showStatus 来自 src/status-ui.js。
import {
  ACESFilmicToneMapping,
  BasicShadowMap,
  BufferAttribute,
  BufferGeometry,
  Color,
  Fog,
  GridHelper,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export function createSceneSetup({ showStatus, createRenderer }) {
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

  const renderer = createRenderer({
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

  return { container, scene, camera, renderer, controls, particlesMesh, lowPowerMode, isMobile };
}
