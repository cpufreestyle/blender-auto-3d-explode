// 材质与乐高外观系统 — 从 main.js 抽出（L2 模块化试点）。
//
// 纯展示层：定义「原生 / 乐高」两套 THREE 材质，以及原生→乐高映射与取色 helper。
// 仅依赖 THREE（与 main.js 共用同一 ../vendor/three.module.js 实例），不含场景/相机等共享状态。
// 注意：样式状态 currentModelStyle 与切换逻辑 applyModelStyle 保留在 main.js（需改写该状态），
//       本模块仅导出可变材质对象与取色函数，由 main.js 的 applyModelStyle 在切换时引用。

import * as THREE from "../vendor/three.module.js";

// ===== 材质（升级真实感）=====
export const materials = {
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
export function makeLegoMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.38,
    metalness: 0.0,
    emissive: new THREE.Color(color).multiplyScalar(0.05),
  });
}
export function makeLegoGlass() {
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
export const legoMaterials = {
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
export const nativeToLego = new Map();
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
export function brightenToLego(hex) {
  const tmp = new THREE.Color(hex);
  const hsl = {};
  tmp.getHSL(hsl);
  if (hsl.l < 0.08) return 0x2b2b2b; // 近黑 → 暗塑料
  return new THREE.Color().setHSL(hsl.h, Math.max(0.6, hsl.s), 0.5).getHex();
}
export function getLegoMaterialForMesh(child) {
  const nativeMat = child.userData._nativeMaterial;
  if (nativeToLego.has(nativeMat)) return nativeToLego.get(nativeMat);
  if (child.userData._legoMaterial) return child.userData._legoMaterial;
  let color = 0x3498db;
  if (nativeMat && nativeMat.color) color = brightenToLego(nativeMat.color.getHex());
  const lm = makeLegoMaterial(color);
  child.userData._legoMaterial = lm;
  return lm;
}
