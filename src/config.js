// 全局配置常量 - 单一数据源
// 所有前端模块从此处读取服务器地址，避免硬编码散落

/**
 * Blender/AI 后端服务地址
 * 开发环境: http://localhost:3001
 * 生产环境: 可通过 window.APP_CONFIG.API_BASE 覆盖
 */
export const API_BASE =
  (typeof window !== "undefined" && window.APP_CONFIG?.API_BASE) ||
  "http://localhost:3001";

/**
 * 服务器端口号（用于静态资源服务器配置）
 */
export const SERVER_PORT = 3001;
