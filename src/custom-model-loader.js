// 自定义模型加载主链路（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的两个函数：
//   - loadCustomModel：上传 / AI 生成模型的总入口（解析 GLB -> 拆分 -> 烘焙
//     居中 -> 建部件 -> 排序命名 -> finalizeCustomModelLoad 收尾），含加载
//     重入守卫与「失败回滚到上一个可用模型」的恢复逻辑；
//   - sortPartsByManifestAsync：按 Blender 清单 center 贪心就近重排部件顺序。
//
// 依赖注入（与 explodeCtl / modelDisposal 同一约定）：
//   - isLoadingCustomModel / hasCustomModel / customModelParts / stepGroups /
//     totalSteps / currentStep / displayedStep 七个共享状态经 getState/setState
//     桥接读写，回滚分支的「整体替换数组」同样经 setState 回落，与 main.js 的
//     let 是同一份；
//   - 拆分、几何、UI 收尾均为注入（loadGLTFLoader / autoSplitModel /
//     calculateExplodePos / finalizeCustomModelLoad / showStatus 等）。
//
// 顺带抽出的可单测件（原为 loadCustomModel 内联块）：
//   - computeGroupCount / computeStepIndex：步骤组分配的纯数学（2~6 段的夹取、
//     按索引算步骤号都是容易在回归中被改坏的魔数）；
//   - bakeAndCenterParts：把世界矩阵烘进几何体、再按整体包围盒居中的两轮遍历；
//   - reorderPartsByManifest：清单贪心匹配，含「未匹配部件按原序追加」兜底。

import { Box3, Euler, Vector3 } from "three";

/**
 * 步骤组数量：约每 3 个部件一组，夹在 2~6 之间。
 * @param {number} partCount 部件总数
 * @returns {number} 步骤组数量
 */
export function computeGroupCount(partCount) {
  return Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);
}

/**
 * 第 i 个部件落在第几步（1 起算，超出末组时夹到最后一组）。
 * @param {number} i 部件索引
 * @param {number} partsPerGroup 每组部件数
 * @param {number} groupCount 步骤组数量
 * @returns {number} 步骤索引
 */
export function computeStepIndex(i, partsPerGroup, groupCount) {
  return Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
}

/**
 * 把每个部件的世界矩阵烘进几何体，并按整体包围盒把几何体居中到原点。
 * 原 loadCustomModel 的「烘焙世界矩阵 + 计算模型中心」两轮遍历。
 * @param {Array<{mesh: object}>} splitParts 拆分结果（就地修改几何体）
 * @param {object} deps
 * @param {() => Promise<void>} deps.yieldToMain 每个部件后让出主线程
 * @param {boolean} deps.castShadow 是否投影
 * @param {boolean} deps.receiveShadow 是否受影
 */
export async function bakeAndCenterParts(splitParts, { yieldToMain, castShadow, receiveShadow }) {
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
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
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

/**
 * 按 Blender 清单的部件中心把部件贪心就近重排（原 sortPartsByManifestAsync）。
 * 清单里匹配不上的部件（或清单比部件少时剩下的部件）按原序追加到末尾。
 * 就地重排：清空 parts 后按新顺序 push 回去。
 * @param {Array<{partCenter: {distanceTo: Function}}>} parts 当前部件数组
 * @param {Array<{center: number[]}>} manifestParts Blender 清单部件
 * @param {object} [deps]
 * @param {() => Promise<void>} [deps.yieldToMain] 每个清单条目后让出主线程
 */
export async function reorderPartsByManifest(parts, manifestParts, { yieldToMain } = {}) {
  const yieldFn = yieldToMain || (() => Promise.resolve());
  const manifestOrder = manifestParts.map((p, idx) => ({
    name: p.display_name || p.name,
    idx,
  }));
  const used = new Set();
  const reordered = [];
  for (const mp of manifestOrder) {
    await yieldFn();
    const targetCenter = manifestParts[mp.idx].center;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < parts.length; i++) {
      if (used.has(i)) continue;
      const d = parts[i].partCenter.distanceTo(
        new Vector3(targetCenter[0], targetCenter[1], targetCenter[2]),
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      reordered.push(parts[bestIdx]);
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (!used.has(i)) reordered.push(parts[i]);
    if (i % 40 === 0) await yieldFn();
  }
  parts.length = 0;
  parts.push(...reordered);
}

/**
 * 创建自定义模型加载器。
 *
 * @param {object} deps
 * @param {() => object} deps.getState 读取共享状态
 * @param {(patch: object) => void} deps.setState 写回共享状态（只含变动键）
 * @param {object} deps.customModelGroup main.js 的 const 稳定引用（Group）
 * @param {object} deps.questGroup main.js 的 const 稳定引用（Group）
 * @param {() => Promise<Function>} deps.loadGLTFLoader 动态加载 GLTFLoader
 * @param {(fileName: string) => boolean} deps.isQuest3Model 是否 Quest 3 模型
 * @param {(model: object) => Array<object>} deps.splitModelToQuest3Regions 15 区域切割
 * @param {(model: object) => Array<object>} deps.autoSplitModel 前端自动拆分
 * @param {(node: object) => void} deps.disposeNodeTree 释放原始场景 GPU 资源
 * @param {() => Promise<void>} deps.yieldToMain 让出主线程
 * @param {(center: object, index: number, total: number) => object} deps.calculateExplodePos
 * @param {(index: number, center: object, box: object) => string} deps.generatePartName
 * @param {(fileName: string, opts?: object) => void} deps.finalizeCustomModelLoad 统一收尾
 * @param {(group: object, smooth?: boolean) => void} deps.fitCameraToModel 相机适配
 * @param {(msg: string, type?: string) => void} deps.showStatus 轻提示
 * @param {(loading: boolean, text?: string) => void} deps.setModelLoading 加载态
 * @param {() => void} deps.updateStepUI 步骤 UI 刷新（explodeCtl.updateStepUI）
 * @param {() => void} deps.clearCustomModelGroup 清理旧自定义模型
 * @param {Array<object>} deps.defaultStepGroups 默认（Quest 3）步骤方案
 * @param {() => boolean} deps.isLowPowerMode 低性能模式判定
 * @returns {{ loadCustomModel: (arrayBuffer: ArrayBuffer, fileName: string, blenderManifest?: object|null) => Promise<void> }}
 */
export function createCustomModelLoader({
  getState,
  setState,
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
  updateStepUI,
  clearCustomModelGroup,
  defaultStepGroups,
  isLowPowerMode,
}) {
  async function loadCustomModel(arrayBuffer, fileName, blenderManifest = null) {
    if (getState().isLoadingCustomModel) {
      showStatus("⏳ 正在加载模型，请稍候...", "info");
      return;
    }

    const loadStart = performance.now();
    const snapshotState = getState();
    let previousHasCustomModel = snapshotState.hasCustomModel;
    let previousCustomModelParts = snapshotState.customModelParts.map(part => ({
      mesh: part.mesh,
      homePos: part.homePos.clone(),
      explodePos: part.explodePos.clone(),
      homeRot: part.homeRot.clone(),
      explodeRot: part.explodeRot.clone(),
      name: part.name,
      partCenter: part.partCenter.clone(),
      stepIndex: part.stepIndex,
    }));
    let previousStepGroups = snapshotState.stepGroups;
    let previousTotalSteps = snapshotState.totalSteps;
    let previousCurrentStep = snapshotState.currentStep;
    let previousDisplayedStep = snapshotState.displayedStep;

    try {
      setState({ isLoadingCustomModel: true });
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
      disposeNodeTree(model);

      if (splitParts.length === 0) {
        throw new Error("模型中未找到可渲染的网格");
      }

      setModelLoading(true, "🔧 正在准备部件...");

      // ========== 烘焙世界矩阵到几何体（非前端 Quest 3 路径需要）==========
      if (!(isQ3 && !blenderManifest)) {
        await bakeAndCenterParts(splitParts, {
          yieldToMain,
          castShadow: !isLowPowerMode(),
          receiveShadow: !isLowPowerMode(),
        });
      }

      // ========== 创建部件数据 ==========
      const splitPartMap = new Map(splitParts.map(part => [part.mesh, part]));
      const customModelParts = getState().customModelParts;
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
        await reorderPartsByManifest(customModelParts, blenderManifest.parts, { yieldToMain });
      } else {
        customModelParts.sort((a, b) => b.partCenter.length() - a.partCenter.length());
      }

      // ========== 分配步骤索引和名称 ==========
      const partCount = customModelParts.length;
      const groupCount = computeGroupCount(partCount);
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
          part.stepIndex = computeStepIndex(i, partsPerGroup, groupCount);
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
          part.stepIndex = computeStepIndex(i, partsPerGroup, groupCount);
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
          part.stepIndex = computeStepIndex(i, partsPerGroup, groupCount);
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
        setState({
          customModelParts: previousCustomModelParts,
          hasCustomModel: true,
          stepGroups: previousStepGroups,
          totalSteps: previousTotalSteps,
          currentStep: previousCurrentStep,
          displayedStep: previousDisplayedStep,
        });
        customModelGroup.visible = true;
        questGroup.visible = false;
        updateStepUI();
        fitCameraToModel(customModelGroup, false);
      } else {
        questGroup.visible = true;
        setState({
          hasCustomModel: false,
          stepGroups: defaultStepGroups,
          totalSteps: defaultStepGroups.length,
          currentStep: 0,
          displayedStep: 0,
        });
        updateStepUI();
        fitCameraToModel(questGroup, false);
      }
    } finally {
      setState({ isLoadingCustomModel: false });
      setModelLoading(false);
    }
  }

  return { loadCustomModel };
}
