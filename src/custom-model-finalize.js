// 自定义模型加载后的统一收尾流程（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的 finalizeCustomModelLoad：调用方在加载/拆分完成后传入差异化
// 参数（modelType / adjustExplode / applyStyle），本模块统一编排「模型可见性
// 切换 -> 样式 -> 动态步骤 -> UI 刷新 -> 自动缩放/相机适配 -> 智能爆炸距离 ->
// 装配分析 -> 回到合体状态 -> 少点击自动播放」收尾链路，消除三个 loader 中
// 的重复代码。
//
// 依赖注入（与 customModelPanel / assembly-analysis 同一约定）：
//   - hasCustomModel / stepGroups / totalSteps / currentStep / displayedStep /
//     animatingStep / isExploded / explodeLoop / autoExplodeTimer 九个共享状态经
//     getState/setState 桥接读写，与 main.js 的 let 是同一份；
//   - customModelParts 经 getCustomModelParts() 惰性读取（与 custom-model-panel
//     同一约定），currentModelStyle 经 getCurrentModelStyle() 惰性读取；
//   - assembly / customModelPanel / explodeCtl / modelFit 四个协作者为实例注入
//     （finalizer 实例在 main.js 中晚于它们的创建点统一创建，运行期才调用）；
//   - fitCameraToModel / applyModelStyle 为函数注入，explodeBtn 为 DOM 注入。

/**
 * 创建自定义模型加载统一收尾器。
 * @param {object} deps
 * @param {() => object} deps.getState 共享状态快照
 * @param {(patch: object) => void} deps.setState 共享状态写入（键在约定集内）
 * @param {() => Array<object>} deps.getCustomModelParts 部件列表惰性读取
 * @param {{visible: boolean}} deps.customModelGroup 自定义模型组
 * @param {{visible: boolean}} deps.questGroup 默认模型组
 * @param {{classList: {remove: (string) => void}, textContent: string}} deps.explodeBtn 爆炸按钮
 * @param {{generateCustomStepGroups: Function, maybeApplyAssemblySequence: Function}} deps.assembly 装配分析实例
 * @param {{updateCustomModelUI: Function}} deps.customModelPanel 自定义模型面板实例
 * @param {{updateStepUI: Function, goToStep: Function, toggleExplode: Function}} deps.explodeCtl 拆解控制实例
 * @param {{autoScaleModel: Function, adjustSmartExplodeDistances: Function}} deps.modelFit 模型归一化实例
 * @param {(group: object, smooth?: boolean) => void} deps.fitCameraToModel 相机适配
 * @param {(style: string) => void} deps.applyModelStyle 样式应用
 * @param {() => string} deps.getCurrentModelStyle 当前样式标签惰性读取
 * @returns {{finalizeCustomModelLoad: (fileName: string, opts?: object) => void}}
 */
export function createCustomModelFinalizer({
  getState,
  setState,
  getCustomModelParts,
  customModelGroup,
  questGroup,
  explodeBtn,
  assembly,
  customModelPanel,
  explodeCtl,
  modelFit,
  fitCameraToModel,
  applyModelStyle,
  getCurrentModelStyle,
}) {
  /**
   * 自定义模型加载后的统一收尾流程。
   * @param {string} fileName
   * @param {object} [opts]
   * @param {string} [opts.modelType]   autoScaleModel 的类型标签
   * @param {boolean} [opts.adjustExplode=true] 是否调用 adjustSmartExplodeDistances
   * @param {boolean} [opts.applyStyle=true]    是否调用 applyModelStyle
   */
  function finalizeCustomModelLoad(fileName, opts = {}) {
    const { modelType, adjustExplode = true, applyStyle = true } = opts;

    setState({ hasCustomModel: true });
    questGroup.visible = false;
    customModelGroup.visible = true;

    if (applyStyle) applyModelStyle(getCurrentModelStyle());

    // 生成动态步骤
    const groups = assembly.generateCustomStepGroups(getCustomModelParts(), fileName);
    setState({
      stepGroups: groups,
      totalSteps: groups.length,
      currentStep: 0,
      displayedStep: 0,
      animatingStep: 0,
    });

    // 更新 UI
    customModelPanel.updateCustomModelUI(getCustomModelParts().length, fileName);
    explodeCtl.updateStepUI();

    // 自动缩放
    modelFit.autoScaleModel(modelType);

    // 自动适配相机
    fitCameraToModel(customModelGroup, false);

    // 智能调整爆炸距离
    if (adjustExplode) modelFit.adjustSmartExplodeDistances();

    // 装配分析（非阻塞）
    assembly.maybeApplyAssemblySequence(fileName);

    // 回到合体状态
    explodeCtl.goToStep(0);
    setState({ isExploded: false });
    explodeBtn.classList.remove("exploded");
    explodeBtn.textContent = "💥 爆炸";

    // 「少点击」：上传/AI 生成完成后自动播一次爆炸，用户无需再点「💥爆炸视图」
    // 就能直接看到拆解结果（若用户已开启循环播放则不打扰）。
    if (!getState().explodeLoop) {
      clearTimeout(getState().autoExplodeTimer);
      setState({
        autoExplodeTimer: setTimeout(() => {
          setState({ autoExplodeTimer: null });
          const state = getState();
          if (!state.isExploded && !state.explodeLoop) explodeCtl.toggleExplode();
        }, 500),
      });
    }
  }

  return { finalizeCustomModelLoad };
}
