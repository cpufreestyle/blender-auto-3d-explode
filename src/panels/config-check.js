// 「配置 AI」按钮是否需要打提醒的判断逻辑（从 src/panels/config-panel.js 的
// fetchConfigAndHighlight 提取）。纯函数、零依赖：config-panel.js 在模块顶层
// 就碰 window / document 并启动 Blender 健康检测，整包 import 不进来，而这条
// 判断规则（什么算「配置没写好」）值得被直接单测——它决定用户一进页面会不会
// 被催着去填 API Key，规则错了要么漏催（AI 调用静默失败）、要么误催（明明能用
// 却一直挂提醒）。

/**
 * 判断一份 AI 配置是否残缺到需要在首页按钮上打「待配置」提醒。
 *
 * 规则按 config-panel.js 里原有内联逻辑逐字搬来：
 *   - 配置读不到（null/undefined）→ 提醒；
 *   - provider 缺失、或为 "img3d"（纯图片转 3D，不需要任何 Key）→ 提醒；
 *   - 当前 provider 的 key 缺失、或为 "***"（配置弹窗里的打码占位符，不是真
 *     Key）→ 提醒。
 *
 * @param {Object|null} cfg 已解析的 ai-config.json 内容
 * @returns {boolean} true 表示应该提醒
 */
export function configNeedsHighlight(cfg) {
  if (!cfg) {
    return true;
  }

  const provider = cfg.provider;
  const hasProvider = !!provider && provider !== "img3d";
  const key = provider && cfg[provider] && cfg[provider].key;
  const hasKey = !!(key && key !== "***");
  return !hasProvider || !hasKey;
}
