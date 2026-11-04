// 步骤深链：把「学到第几步」写进地址栏，让一节课可以像文档一样被分发。
//
// 借鉴 47ng/nuqs（MIT，10.8k★）的核心主张——「URL 即状态」：进度只有一份，
// 落在地址栏里，复制链接等于复制当时的教学状态；学生点开链接落在同一步上。
// 与 nuqs 的两处刻意差异：
//   1) 用 hash 而不是 search：静态托管 / file:// 打开都不需要服务端配合，
//      也不会让 ?step= 参与缓存键（本仓库的静态缓存按 ?v= 给 immutable）。
//   2) 写回用 replaceState 而不是 pushState：逐步点下来不会把浏览器历史灌成
//      几十条，学生按「后退」离开的是上一页，而不是教案的上一步。
// 深链只是 currentStep / displayedStep 的镜像，永远不反向当真相：hashchange
// 只触发一次 goToStep，其余仍走控制器，避免两边互相覆盖。

export const STEP_HASH_KEY = "step";

/** 从 location.hash 读步骤号。#step=3 → 3；缺失 / 非整数 / 负值 / 越界 → null。 */
export function parseStepFromHash(hash, totalSteps) {
  const raw = typeof hash === "string" ? hash : "";
  const text = new URLSearchParams(raw.replace(/^#/, "")).get(STEP_HASH_KEY);
  if (text === null) return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null; // "abc" / "1.5" / "-1" / "" 一律不算
  const step = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(step) || step < 0) return null;
  if (Number.isInteger(totalSteps) && totalSteps > 0 && step > totalSteps) return null;
  return step;
}

/** 生成某一步的完整可分享地址。file:// 下 origin 是 "null"，退化为 pathname + search。 */
export function buildStepUrl(location, step) {
  if (!location || !Number.isInteger(step) || step < 0) return "";
  const origin = location.origin && location.origin !== "null" ? location.origin : "";
  const path = location.pathname || "";
  const search = location.search || "";
  return origin + path + search + "#" + STEP_HASH_KEY + "=" + step;
}

/**
 * 把当前步骤写回地址栏。值没变就不碰 history（动画中每帧都调，不能白写）。
 * @returns {{changed: boolean, url: string}} changed=false 表示地址栏已经是这一步
 */
export function syncStepToUrl({ location, history, step }) {
  const desired = "#" + STEP_HASH_KEY + "=" + step;
  const current = location && typeof location.hash === "string" ? location.hash : "";
  if (current === desired) return { changed: false, url: "" };
  if (history && typeof history.replaceState === "function") {
    history.replaceState(null, "", desired);
  }
  return { changed: true, url: desired };
}

/**
 * 首屏应用深链：hash 里有合法步骤且与当前步不同时，交给 goToStep 落位。
 * @returns {boolean} 是否真的应用了深链
 */
export function applyStepFromLocation({ location, goToStep, totalSteps, currentStep = 0 }) {
  const step = parseStepFromHash(location && location.hash, totalSteps);
  if (step === null) return false;
  if (step === currentStep) return false;
  goToStep(step);
  return true;
}
