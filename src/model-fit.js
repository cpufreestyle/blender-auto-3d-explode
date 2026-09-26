// 自定义模型加载后的尺寸归一化与爆炸距离智能调整（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的两个函数（仅服务于 finalizeCustomModelLoad 的收尾流程）：
//   - autoScaleModel：模型过小时自动放大到约 10 单位；
//   - adjustSmartExplodeDistances：在 rAF 里按相机位置与模型包围盒重算每个
//     部件的 explodePos，让拆解散开范围始终落在视野内。
//
// 依赖注入：customModelGroup 与 camera 是 main.js 的 const 稳定引用；
// customModelParts 是会被整体替换的共享状态，经 getCustomModelParts() 惰性
// 读取（与 upload-panel 的 getCustomModelParts 同一约定）。
//
// autoScaleModel 的算式部分抽成纯函数 computeAutoScale，便于边界值单测
// （0.001 的下限、5.0 的门槛、20 倍的上限都是容易回归的魔数）。

import { Box3, Vector3 } from "three";
import { calculateSmartExplodeDist } from "./explode-geometry.js";

/**
 * 自动缩放纯数学：最大维度 <5 且 >0.001 时，放大到约 10 单位（上限 20 倍）。
 * @param {number} maxDim 模型最大维度
 * @returns {number} 缩放系数；不需要放大时为 1
 */
export function computeAutoScale(maxDim) {
  let autoScale = 1.0;
  if (maxDim < 5.0 && maxDim > 0.001) {
    autoScale = 10.0 / maxDim;
    autoScale = Math.min(autoScale, 20);
  }
  return autoScale;
}

/**
 * 创建模型归一化器。
 *
 * @param {object} deps
 * @param {object} deps.customModelGroup - main.js 的 const 稳定引用（Group）
 * @param {object} deps.camera - main.js 的 const 稳定引用（PerspectiveCamera）
 * @param {() => Array<object>} deps.getCustomModelParts - 惰性读当前自定义部件
 * @returns {{ autoScaleModel: (modelType?: string) => number, adjustSmartExplodeDistances: () => void }}
 */
export function createModelFit({
  customModelGroup,
  camera,
  getCustomModelParts,
}) {
  /**
   * 自动放大微小模型：最大维度小于 5 时缩放到约 10 单位。
   * @param {string} modelType - 模型类型名称（用于日志）
   * @returns {number} 实际应用的缩放比例
   */
  function autoScaleModel(modelType = "模型") {
    const autoBox = new Box3().setFromObject(customModelGroup);
    const autoSize = new Vector3();
    autoBox.getSize(autoSize);
    const autoMaxDim = Math.max(autoSize.x, autoSize.y, autoSize.z);

    const autoScale = computeAutoScale(autoMaxDim);

    if (autoScale > 1.0) {
      customModelGroup.scale.set(autoScale, autoScale, autoScale);
      console.log(`🔍 ${modelType}自动放大 ${autoScale.toFixed(1)} 倍`);
    }

    return autoScale;
  }

  /**
   * 智能调整所有自定义部件的爆炸距离：根据相机位置和模型大小计算合适的爆炸距离。
   * 方向优先级：explodePos -> partCenter -> 围绕中心的环形 fallback。
   * 在 requestAnimationFrame 里执行，确保读到的是最新布局。
   */
  function adjustSmartExplodeDistances() {
    requestAnimationFrame(() => {
      const parts = getCustomModelParts();
      const groupScale = customModelGroup.scale.x || 1;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        let explodeDir = part.explodePos.clone();
        if (explodeDir.length() < 0.001) {
          explodeDir = part.partCenter.clone();
          if (explodeDir.length() < 0.001) {
            const angle = (i / parts.length) * Math.PI * 2;
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

  return { autoScaleModel, adjustSmartExplodeDistances };
}
