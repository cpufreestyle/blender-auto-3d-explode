// 重放页地址的单一构造点（生成库条目 + 「存并重放」按钮共用）。
//
// 背景：/api/generated 与 /api/manifest 都返回形如 /models/generated/x.json 的
// 相对地址。重放页需要 ?manifest=<可寻址 URL>，此前 export-panel.js 自己手写
// 了 `replay.html?manifest=${encodeURIComponent(url)}`，生成库里却没有入口，
// 用户只能手动拼。把这条规则收进纯函数，两个入口就不会各自漂移。
//
// 为什么重放页本身用绝对地址：?api= 允许前端与后端分居两个来源（桌面快捷
// 方式、npx serve . 开发态）。把重放页落在 API_BASE 那个来源上，manifest 的
// 相对路径自然也在同一个来源里解析；静态服务再对清单补 CORS 头，兼容从别的
// 静态页手工打开 replay.html 的情况。
import { API_BASE } from "./config.js";

/** 是否是拆解清单（manifest）地址；只看 ?/# 之前的路径，大小写不敏感。 */
export function isManifestUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return /\.json$/i.test(url.split(/[?#]/, 1)[0]);
}

/**
 * 构造重放页地址。
 * @param {string} manifestUrl /api/generated 或 /api/manifest 返回的清单地址
 * @param {object} [options]
 * @param {string} [options.apiBase] 后端来源；缺省用 config.js 的 API_BASE
 * @returns {string} 指向 API_BASE 来源上 replay.html 的绝对地址
 */
export function buildReplayUrl(manifestUrl, { apiBase = API_BASE } = {}) {
  const replay = new URL("replay.html", apiBase);
  replay.searchParams.set("manifest", String(manifestUrl || ""));
  replay.searchParams.set("api", apiBase);
  return replay.toString();
}
