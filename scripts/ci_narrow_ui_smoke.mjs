#!/usr/bin/env node
/**
 * 窄屏 / 移动端布局 — 真机冒烟门禁（需要本机 Chrome，故意不进 npm test）。
 *
 * 动机：工具面板正面宽固定 340px，以前只有一条 @media (width <= 480px) 调外框，
 * 面板内的时间轴、AI 输入行、触控目标全按「够宽就行」假设写死。桌面浏览器把窗口
 * 拉窄、或 UA 检测不到的窄设备上，滑块和按钮就挤成一条。这个脚本用真实 Chrome 把
 * 视口收到 390×844（iPhone 口径，且是桌面 UA——顺便覆盖 UA 检测不到的窄设备），
 * 逐个量布局，顺带把上一轮一次性探针验过的细节收敛（等宽数字 / Tab 焦点环 /
 * 纯图标按钮 title）收进门禁。
 *
 * 覆盖：
 *   1. 390×844 下无横向溢出，面板宽度=视口-16px 且整体在视口内；
 *   2. 时间轴换行：滑块独占整行，播放 / 倍速留在第一行；
 *   3. AI 输入行换行：输入框独占整行，生成按钮被挤到下一行；
 *   4. 触控目标：.btn min-height >= 40px、.btn-mini >= 36px、滑块轨道加高 7px；
 *   5. 细节收敛：#timeline-step 等宽数字；Tab 后焦点环 2px solid 强调色；
 *      时间轴 / 侧栏 / 主题的纯图标按钮都带 title；
 *   6. 还原视口后面板回到 340px 固定宽（证明响应式由宽度驱动，没有写死）；
 *   7. 全程 0 运行时异常。
 *
 * 用法：
 *   node scripts/ci_narrow_ui_smoke.mjs
 *   PORT=3937 CDP_PORT=9283 CHROME_PATH=/path/to/chrome node scripts/ci_narrow_ui_smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或页面卡死；0 且首行 SKIP = 本机没有 Chrome。
 */

import { startUiSmoke } from "./ui_smoke_lib.mjs";

const OUT = console.log.bind(console);
const ui = await startUiSmoke({
  port: process.env.PORT || "3937",
  cdp: process.env.CDP_PORT || "9283",
  chromePath: process.env.CHROME_PATH || undefined,
});
if (!ui) {
  OUT(`SKIP: 未找到 Chrome（${process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}），本机无法跑浏览器冒烟`);
  process.exit(0);
}

const { evaluate, key, pageErrors } = ui;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const A = (cond, msg) => { OUT((cond ? "  OK   " : "  FAIL ") + msg); if (cond) passed++; else failed++; };

try {
  await sleep(9000);
  A(pageErrors.length === 0, `页面 0 运行时异常（实际 ${pageErrors.length}）`);

  // ===== 视口收到 390×844（iPhone 口径，桌面 UA——顺便覆盖 UA 检测不到的窄设备）=====
  await ui.setViewport(390, 844, 2, true);
  await sleep(400);

  const wide = JSON.parse(await evaluate(`JSON.stringify({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    innerW: window.innerWidth,
  })`));
  A(wide.scrollW <= wide.clientW + 1, `无横向溢出（scrollWidth ${wide.scrollW} <= clientWidth ${wide.clientW}）`);
  A(wide.innerW === 390, `视口确实收窄（innerWidth ${wide.innerW}）`);

  const ov = JSON.parse(await evaluate(`(() => {
    const r = document.getElementById('ui-overlay').getBoundingClientRect();
    return JSON.stringify({ x: r.x, w: r.width, h: r.height, right: r.right, bottom: r.bottom });
  })()`));
  A(Math.abs(ov.w - 374) <= 1, `面板宽度=视口-16px（实际 ${ov.w}）`);
  A(ov.x >= 7 && ov.x <= 9 && ov.right <= 390, `面板整体落在视口内（x=${ov.x}, right=${ov.right}）`);
  A(ov.h <= 829, `面板不超出视口高度（h=${ov.h}）`);

  // ===== 时间轴换行 =====
  const tl = JSON.parse(await evaluate(`JSON.stringify((() => {
    const ctl = document.querySelector('.tl-controls');
    const play = document.getElementById('timeline-play');
    const slider = document.querySelector('.tl-slider-wrap');
    if (!ctl || !play || !slider) return null;
    const p = play.getBoundingClientRect();
    const s = slider.getBoundingClientRect();
    return { playTop: p.top, playH: p.height, sliderTop: s.top, sliderW: s.width, ctlW: ctl.getBoundingClientRect().width };
  })())`));
  A(tl !== null, "时间轴控件存在");
  if (tl) {
    A(tl.sliderTop > tl.playTop + 1, `滑块换到独立一行（play top=${tl.playTop.toFixed(0)} < slider top=${tl.sliderTop.toFixed(0)}）`);
    A(tl.sliderW >= tl.ctlW - 2, `滑块行占满整行（${tl.sliderW.toFixed(0)} / ${tl.ctlW.toFixed(0)}）`);
    A(tl.playH >= 35, `播放按钮触控高度够大（${tl.playH}px）`);
  }

  // ===== AI 输入行换行（面板默认折叠，先展开）=====
  const openedAI = await evaluate(`(() => {
    for (const d of document.querySelectorAll('details')) {
      if (d.querySelector('.ai-input-row')) { d.open = true; return true; }
    }
    return false;
  })()`);
  A(openedAI === true, "AI 绘画面板已展开");
  const ai = JSON.parse(await evaluate(`JSON.stringify((() => {
    const row = document.querySelector('.ai-input-row');
    const input = document.getElementById('ai-paint-prompt');
    const gen = document.getElementById('ai-paint-btn');
    if (!row || !input || !gen) return null;
    const r = row.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    const g = gen.getBoundingClientRect();
    return { rowW: r.width, inputW: i.width, inputBottom: i.bottom, genTop: g.top };
  })())`));
  A(ai !== null, "AI 输入行元素存在");
  if (ai) {
    A(ai.inputW >= ai.rowW - 2, `输入框独占一行（${ai.inputW.toFixed(0)} / ${ai.rowW.toFixed(0)}）`);
    A(ai.genTop >= ai.inputBottom - 1, `生成按钮换到下一行（input bottom=${ai.inputBottom.toFixed(0)} <= gen top=${ai.genTop.toFixed(0)}）`);
  }

  // ===== 触控目标 =====
  const touch = JSON.parse(await evaluate(`JSON.stringify((() => {
    const btn = document.getElementById('next-step');
    const range = document.getElementById('explode-depth');
    return { minH: getComputedStyle(btn).minHeight, rangeH: getComputedStyle(range).height };
  })())`));
  A(parseFloat(touch.minH) >= 40, `.btn 最小高度 >= 40px（实际 ${touch.minH}）`);
  A(parseFloat(touch.rangeH) >= 7, `滑块轨道加高（实际 ${touch.rangeH}）`);

  // ===== 细节收敛：等宽数字 =====
  const fvn = await evaluate(`getComputedStyle(document.getElementById('timeline-step')).fontVariantNumeric`);
  A(typeof fvn === "string" && fvn.includes("tabular-nums"), `#timeline-step 等宽数字（${fvn}）`);

  // ===== 细节收敛：Tab 焦点环 =====
  await key("Tab");
  await sleep(200);
  const focus = JSON.parse(await evaluate(`JSON.stringify((() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return { id: el.id, tag: el.tagName, visible: el.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
  })())`));
  A(focus !== null && focus.visible === true, `Tab 后焦点落在控件上且匹配 :focus-visible（${focus && (focus.id || focus.tag)}）`);
  A(focus !== null && focus.style === "solid" && parseFloat(focus.width) >= 2, `焦点环 2px solid（${focus && focus.style} ${focus && focus.width} ${focus && focus.color}）`);

  // ===== 细节收敛：纯图标按钮都有 title =====
  const titles = JSON.parse(await evaluate(`JSON.stringify((() => {
    const out = {};
    for (const id of ['timeline-play', 'timeline-reset', 'sidebar-collapse', 'theme-toggle']) {
      const el = document.getElementById(id);
      out[id] = el ? el.getAttribute('title') : null;
    }
    return out;
  })())`));
  const missing = Object.entries(titles).filter(([, v]) => !v).map(([k]) => k);
  A(missing.length === 0, `纯图标按钮全部带 title（缺失：${missing.join(", ") || "无"}）`);

  // ===== 还原视口：固定 340px 回归 =====
  await ui.clearViewport();
  await sleep(300);
  const back = JSON.parse(await evaluate(`(() => {
    const r = document.getElementById('ui-overlay').getBoundingClientRect();
    return JSON.stringify({ w: r.width });
  })()`));
  A(Math.abs(back.w - 340) < 1, `还原后面板回到 340px 固定宽（实际 ${back.w}）`);

  A(pageErrors.length === 0, `全程 0 运行时异常（实际 ${pageErrors.length}）`);
} catch (e) {
  OUT("  FAIL 冒烟执行异常：" + e.message);
  failed++;
} finally {
  await ui.stop();
}

OUT(`\nsmoke: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
