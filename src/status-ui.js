// 全局状态条与模型加载覆盖层（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的 showStatus / setModelLoading 与 MODEL_LOADING_BTN_IDS：
//   - showStatus：写 #upload-status 状态条（main.js 十余处复用它打进度），
//     元素缺失时静默返回；
//   - setModelLoading：切 #model-loading 覆盖层显隐与文案，并按 id 清单把
//     一组按钮统一切换 disabled（元素缺失逐个跳过）。
// DOM 引用在工厂创建时取得：main.js 以 module 形式置于 body 末尾，此时 DOM
// 已就绪，与原实现的取元素时机一致。
// 模型加载期间要统一禁用/恢复的按钮 id 清单。提到模块级并导出：这些 id 与
// index.html 里的按钮是一份跨文件契约，改名任何一边都会让某个按钮在加载中
// 漏掉禁用（getElementById 取不到就静默跳过），故由 dead-markup 守卫对着
// index.html 逐一核对在不在。
export const MODEL_LOADING_BTN_IDS = [
  "upload-btn",
  "clear-model-btn",
  "prev-step",
  "next-step",
  "reset-step",
  "style-toggle",
  "explode-btn",
  "explode-loop",
  "timeline-play",
  "timeline-reset",
  "generated-load",
  "img-to-3d-btn",
  "open-config-btn",
  "blender-launch",
];

export function createStatusUI() {
  const uploadStatusEl = document.getElementById("upload-status"); // 全局上传状态元素

  function showStatus(msg, type = "info") {
    if (!uploadStatusEl) return;
    uploadStatusEl.textContent = msg;
    uploadStatusEl.className = "status-box " + type;
    uploadStatusEl.classList.remove("hidden");
  }

  const modelLoadingEl = document.getElementById("model-loading");
  const modelLoadingTextEl = document.getElementById("model-loading-text");
  function setModelLoading(loading, text = "正在准备模型...") {
    if (modelLoadingEl) modelLoadingEl.classList.toggle("hidden", !loading);
    if (modelLoadingTextEl) modelLoadingTextEl.textContent = text;
    MODEL_LOADING_BTN_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = loading;
    });
  }
  return { showStatus, setModelLoading };
}
