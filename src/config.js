// 全局配置常量 - 单一数据源
// 所有前端模块（含 index.html / ai-config.html 两个静态页的内联 module
// 脚本）都从这里读服务器地址，避免硬编码散落。
//
// 解析顺序（靠前的优先）：
//   1. window.APP_CONFIG.API_BASE —— 生产部署注入点（保留原有约定）；
//   2. <meta name="api-base"> 标签 —— 两个页面里真实在用的旋钮。此前只有
//      页面内联脚本读它、模块侧读不到，改标签会让配置页与主应用指向不同
//      后端，现在由本文件收口，改一处即整体生效；
//   3. "http://localhost:3001" —— 默认值。
// Node 等无 document 的环境下第 2 步自动跳过（服务端 import 不会炸）。
function readMetaApiBase() {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") {
    return null;
  }
  const meta = document.querySelector("meta[name='api-base']");
  return (meta && meta.content) || null;
}

/**
 * Blender/AI 后端服务地址
 * 开发环境: http://localhost:3001
 * 生产环境: 可通过 window.APP_CONFIG.API_BASE 覆盖
 */
export const API_BASE =
  (typeof window !== "undefined" && window.APP_CONFIG?.API_BASE) ||
  readMetaApiBase() ||
  "http://localhost:3001";
