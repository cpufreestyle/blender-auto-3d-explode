#!/usr/bin/env node
/**
 * 侧栏折叠 — 真机冒烟门禁（需要本机 Chrome，故意不进 npm test）。
 *
 * 动机：340px 的工具面板在拆解视图里占掉小半屏，收起它是最常用的一个动作，而它跨了
 * 三样单测照不到的东西——CSS transform 真的把面板挪出了视口、localStorage 跨刷新仍然
 * 记得、inert 真的让键盘进不去那块看不见的面板。这个脚本用真实 Chrome 逐个点一遍。
 *
 * 覆盖：
 *   1. 收起按钮存在且带 title（含快捷键提示）；
 *   2. 点收起：.collapsed + 面板整体移出视口左侧 + 浮动展开钮显身 + aria-expanded=false
 *     + inert（键盘不该被困在看不见的面板里）+ 写回 localStorage；
 *   3. 刷新页面：仍然是收起状态（localStorage 记忆生效）；
 *   4. 点展开钮：面板回到视口内、展开钮隐藏、写回 open；
 *   5. H 快捷键同样能收起；
 *   6. 全程 0 运行时异常。
 *
 * 用法：
 *   node scripts/ci_sidebar_ui_smoke.mjs
 *   PORT=3934 CDP_PORT=9280 CHROME_PATH=/path/to/chrome node scripts/ci_sidebar_ui_smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或页面卡死；0 且首行 SKIP = 本机没有 Chrome。
 */

import { startUiSmoke } from "./ui_smoke_lib.mjs";

const OUT = console.log.bind(console);
const ui = await startUiSmoke({
  port: process.env.PORT || "3934",
  cdp: process.env.CDP_PORT || "9280",
  chromePath: process.env.CHROME_PATH || undefined,
});
if (!ui) {
  OUT(`SKIP: 未找到 Chrome（${process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}），本机无法跑浏览器冒烟`);
  process.exit(0);
}

const { evaluate, click, key, pageErrors } = ui;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const A = (cond, msg) => { OUT((cond ? "  OK   " : "  FAIL ") + msg); if (cond) passed++; else failed++; };

const readState = () => evaluate(`JSON.stringify((() => {
  const overlay = document.getElementById('ui-overlay');
  const collapse = document.getElementById('sidebar-collapse');
  const expand = document.getElementById('sidebar-expand');
  const r = overlay.getBoundingClientRect();
  const er = expand.getBoundingClientRect();
  return {
    collapsed: overlay.classList.contains('collapsed'),
    inert: overlay.inert === true,
    offscreen: r.x + r.width <= 0,
    transform: getComputedStyle(overlay).transform,
    expandHidden: expand.classList.contains('hidden'),
    expandOnScreen: er.width > 0 && er.x >= 0 && er.y >= 0,
    ariaCollapse: collapse.getAttribute('aria-expanded'),
    ariaExpand: expand.getAttribute('aria-expanded'),
    title: collapse.getAttribute('title'),
    saved: localStorage.getItem('quest3-sidebar'),
  };
})())`);

try {
  await sleep(9000);
  A(pageErrors.length === 0, `页面 0 运行时异常（实际 ${pageErrors.length}）`);

  const btn = JSON.parse(await evaluate(`JSON.stringify((() => {
    const b = document.getElementById('sidebar-collapse');
    return b ? { title: b.getAttribute('title'), rect: b.getBoundingClientRect().toJSON() } : null;
  })())`));
  A(btn !== null && !!btn.title && btn.title.includes("H"), `收起按钮带 title 且提示快捷键（实际：${btn && btn.title}）`);

  const before = JSON.parse(await readState());
  A(before.collapsed === false && before.expandHidden === true && before.ariaCollapse === "true", "初始展开：面板在位、展开钮隐藏、aria-expanded=true");

  // ===== 点收起 =====
  await click(btn.rect.x + btn.rect.width / 2, btn.rect.y + btn.rect.height / 2);
  await sleep(700);
  const after = JSON.parse(await readState());
  A(after.collapsed === true, "面板加上 .collapsed");
  A(after.offscreen === true, `面板整体移出视口左侧（${after.transform}，宽 340px → 左偏 364px）`);
  A(after.transform !== "none" && after.transform.includes("matrix"), "transform 真的生效（不是只加了类名）");
  await ui.shot(process.env.SHOT || "/tmp/sidebar-collapsed.png");
  A(after.expandHidden === false && after.expandOnScreen === true, "浮动展开钮显身且在视口内");
  A(after.ariaCollapse === "false" && after.ariaExpand === "false", "两个按钮 aria-expanded=false");
  A(after.inert === true, "收起的面板设了 inert（键盘进不去）");
  A(after.saved === "collapsed", `写回 localStorage（${after.saved}）`);

  // ===== 刷新后仍然收起（localStorage 记忆）=====
  await ui.send("Page.reload", { ignoreCache: false });
  await sleep(9000);
  const reloaded = JSON.parse(await readState());
  A(reloaded.collapsed === true && reloaded.inert === true && reloaded.expandHidden === false,
    `刷新后仍是收起状态（collapsed=${reloaded.collapsed}, inert=${reloaded.inert}）`);

  // ===== 点展开钮还原 =====
  const expRect = JSON.parse(await evaluate(`JSON.stringify(document.getElementById('sidebar-expand').getBoundingClientRect().toJSON())`));
  await click(expRect.x + expRect.width / 2, expRect.y + expRect.height / 2);
  await sleep(700);
  const back = JSON.parse(await readState());
  A(back.collapsed === false && back.inert === false && back.expandHidden === true, "展开后面板回到视口、inert 撤掉、展开钮隐藏");
  A(back.offscreen === false, "面板重新落在视口内");
  A(back.saved === "open", `写回 open（${back.saved}）`);

  // ===== H 快捷键同样能收起 =====
  await key("h");
  await sleep(700);
  const hotkey = JSON.parse(await readState());
  A(hotkey.collapsed === true, "按 H 收起");
  await key("h");
  await sleep(700);
  const hotkey2 = JSON.parse(await readState());
  A(hotkey2.collapsed === false, "再按 H 展开");

  A(pageErrors.length === 0, `全程 0 运行时异常（实际 ${pageErrors.length}）`);
} catch (e) {
  OUT("  FAIL 冒烟执行异常：" + e.message);
  failed++;
} finally {
  await ui.stop();
}

OUT(`\nsmoke: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
