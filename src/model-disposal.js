// 自定义模型拆卸与 GPU 资源释放（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js「自定义模型公共工具函数」区的两块：
//   - disposeSceneRecursively -> 本文件的 disposeNodeTree（命名导出）；
//   - clearCustomModelGroup -> createModelDisposal({ ... }).clearCustomModelGroup。
//
// 顺带去掉一处真实重复：原文件里这两个函数各自内联了同一份「先 dispose 材质
// 贴图、再 dispose 材质与几何体」的遍历实现，现在统一走 disposeNodeTree ——
// material.dispose() 不会释放贴图占用的 GPU 资源，因此必须先遍历材质属性，
// 把 isTexture 的贴图单独 dispose 掉。
//
// 状态归属：clearCustomModelGroup 收尾时重置的 customModelParts 与
// assemblySequenceOrder 是 main.js 的共享状态，经 s.* 惰性读 getState()、
// 写立即回落 setState({ key })（与 explode-controller / assembly-analysis 同一约定）。

// 与 main.js 约定的共享状态键集合
const SHARED_STATE_KEYS = ["customModelParts", "assemblySequenceOrder"];

/** 释放单个材质：先 dispose 其自有属性里的贴图，再 dispose 材质本身 */
function disposeMaterial(m) {
  for (const value of Object.values(m)) {
    if (value && value.isTexture) value.dispose();
  }
  m.dispose();
}

/**
 * 递归释放整棵节点树：geometry.dispose + material（含贴图）dispose。
 * traverse 覆盖嵌套的 Group/Mesh（GLTF 场景可能是多层结构）。
 * @param {object} node three.js Object3D；falsy 时安全返回
 */
export function disposeNodeTree(node) {
  if (!node) return;
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

/**
 * 创建自定义模型拆卸器。
 *
 * @param {object} deps
 * @param {object} deps.customModelGroup - main.js 的 const 稳定引用（Group）
 * @param {() => object} deps.getState - 读共享状态，键见 SHARED_STATE_KEYS
 * @param {(patch: object) => void} deps.setState - 写共享状态，只接收含变动键的 patch
 * @returns {{ clearCustomModelGroup: () => void }}
 */
export function createModelDisposal({
  customModelGroup,
  getState,
  setState,
}) {
  // 共享状态响应式视图：读时现取、写时立即回写，等价于直接操作 main.js 的那些 let
  const s = {};
  for (const key of SHARED_STATE_KEYS) {
    Object.defineProperty(s, key, {
      get: () => getState()[key],
      set: value => setState({ [key]: value }),
      enumerable: true,
    });
  }

  /**
   * 清除自定义模型组中的所有子对象，同时 dispose 几何体和材质以释放 GPU 内存。
   * 收尾重置部件表、装配顺序与组的变换，避免上一个模型的状态误用到下一个。
   */
  function clearCustomModelGroup() {
    // material.dispose() 不会释放贴图的 GPU 资源，需先单独 dispose 所有纹理
    while (customModelGroup.children.length > 0) {
      const child = customModelGroup.children[0];
      // traverse 覆盖嵌套的 Group/Mesh（GLTF 场景可能是多层结构）
      disposeNodeTree(child);
      child.userData = {};
      customModelGroup.remove(child);
    }
    s.customModelParts = [];
    customModelGroup.scale.set(1, 1, 1);
    customModelGroup.position.set(0, 0, 0);
    // 清除上一个模型的装配顺序，避免误用
    s.assemblySequenceOrder = null;
  }

  return { clearCustomModelGroup };
}
