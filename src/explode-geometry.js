/**
 * 爆炸视图几何计算（纯函数模块）。
 *
 * 从 main.js 提取的无共享状态工具：仅依赖 three 与 src/utils.js，
 * 不引用 scene / camera / modelGroup 等模块级状态，便于独立测试与复用。
 */

import { Box3, BufferAttribute, BufferGeometry, Vector3 } from "three";

import { computeExplodeVector } from "./utils.js";

/**
 * 为自定义部件计算爆炸方向和位置
 * @param {Vector3} partCenter - 部件中心
 * @param {number} index - 部件索引
 * @param {number} totalParts - 总部件数
 * @returns {Vector3} 爆炸位置
 */
export function calculateExplodePos(partCenter, index, totalParts) {
  const vec = computeExplodeVector(partCenter, index, totalParts);
  return new Vector3(vec.x, vec.y, vec.z);
}

/**
 * 合并多个 BufferGeometry：统一转为非索引几何体后按属性拼接。
 * @param {BufferGeometry[]} geometries
 * @returns {BufferGeometry}
 */
export function mergeGeometries(geometries) {
  if (geometries.length === 0) return new BufferGeometry();
  if (geometries.length === 1) return geometries[0].clone();

  // 统一转为非索引几何体
  const nonIndexed = geometries.map(g => (g.index ? g.toNonIndexed() : g));

  // 确定要合并的属性
  const attrNames = ["position", "normal", "uv"];
  const activeAttrs = attrNames.filter(name => nonIndexed.every(g => g.attributes[name]));

  // 计算总顶点数
  let totalVerts = 0;
  for (const g of nonIndexed) totalVerts += g.attributes.position.count;

  const merged = new BufferGeometry();
  for (const attrName of activeAttrs) {
    const itemSize = nonIndexed[0].attributes[attrName].itemSize;
    const array = new Float32Array(totalVerts * itemSize);
    let offset = 0;
    for (const g of nonIndexed) {
      const data = g.attributes[attrName].array;
      array.set(data, offset);
      offset += data.length;
    }
    merged.setAttribute(attrName, new BufferAttribute(array, itemSize));
  }

  return merged;
}

/**
 * 依据模型尺寸与相机视野，计算「看得见又不飞出屏幕」的爆炸距离。
 * @param {Object3D} modelGroup 模型组
 * @param {Vector3} explodeDir 爆炸方向
 * @param {PerspectiveCamera} camera 当前相机（由调用方注入，避免依赖全局状态）
 * @returns {number} 建议的爆炸距离
 */
export function calculateSmartExplodeDist(modelGroup, explodeDir, camera) {
  // 1. 获取当前模型包围盒
  const box = new Box3().setFromObject(modelGroup);
  const center = box.getCenter(new Vector3());
  const size = new Vector3();
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
  const toCamera = new Vector3().subVectors(camera.position, center).normalize();

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
