#!/usr/bin/env node
/**
 * 部件清单交互 — 真机冒烟门禁（需要本机 Chrome，故意不进 npm test）。
 *
 * 动机：单测里的假 DOM 没有 MutationObserver，于是「DOM 写入反过来喂给自己挂的
 * observer」这类整页卡死在单测里完全隐形。本刀就踩过：refresh() 无条件重写眼睛按钮的
 * textContent，而 observer 听着 .parts-grid 的 subtree childList——Blink 里重写文本节点
 * 就是一次「移除+插入」，于是点一下「单独显示」渲染进程就被拖死，页面再无响应。
 * 这个脚本用真实 Chrome 点真实页面，把这类回归挡在提交前。
 *
 * 覆盖：
 *   1. 首屏部件清单每行都有眼睛按钮，行数与静态清单一致；
 *   2. 点行 → 该行激活 + 相机聚焦（画面亮像素大幅上升）；
 *   3. 再点同一行 → 取消选中；
 *   4. 点眼睛 → isolate：其余部件从画面里消失（用同一相机状态下的配对截图差分证明，
 *      并取一张等间隔的静止截图做漂移对照，把相机自转的抖动从结论里扣掉）；
 *   5. 「全部显示」按钮出现、点击后部件全部回来；
 *   6. Escape 同样能退 isolate；
 *   7. 全程 0 运行时异常。
 *
 * 用法：
 *   node scripts/ci_parts_ui_smoke.mjs
 *   PORT=3935 CDP_PORT=9281 CHROME_PATH=/path/to/chrome node scripts/ci_parts_ui_smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或页面卡死；0 且首行 SKIP = 本机没有 Chrome。
 */

import { startUiSmoke } from "./ui_smoke_lib.mjs";

const OUT = console.log.bind(console);
const CHROME = process.env.CHROME_PATH || undefined;
const ui = await startUiSmoke({
  port: process.env.PORT || "3933",
  cdp: process.env.CDP_PORT || "9279",
  chromePath: CHROME,
});
if (!ui) {
  OUT(`SKIP: 未找到 Chrome（${process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}），本机无法跑浏览器冒烟`);
  process.exit(0);
}

const { evaluate, click, key, shot, shotPixels, brightRatio, diffFraction, pageErrors } = ui;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const A = (cond, msg) => { OUT((cond ? "  OK   " : "  FAIL ") + msg); if (cond) passed++; else failed++; };

try {
  await sleep(9000);
  A(pageErrors.length === 0, `页面 0 运行时异常（实际 ${pageErrors.length}${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ") : ""}）`);

  // 展开「工具 & 部件清单」面板（默认折叠，不展开点不到行）
  const opened = await evaluate(`(() => {
    for (const d of document.querySelectorAll('details')) {
      if (d.querySelector('.parts-grid')) { d.open = true; return true; }
    }
    return false;
  })()`);
  A(opened === true, "部件清单面板已展开");

  const eyeCount = await evaluate(`document.querySelectorAll('.parts-grid .part-item .part-eye').length`);
  A(eyeCount >= 8, `首屏静态清单每行都有眼睛按钮（实际 ${eyeCount} 个）`);
  const rowCount = await evaluate(`document.querySelectorAll('.parts-grid .part-item').length`);
  A(rowCount >= 8, `清单行数 ${rowCount}`);

  // ===== 选中 + 相机聚焦 =====
  const rect = JSON.parse(await evaluate(`(() => {
    const row = document.querySelectorAll('.parts-grid .part-item')[1];
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width * 0.35, y: r.y + r.height / 2, name: row.dataset.part });
  })()`));
  OUT("目标行:", rect.name, "at", rect.x.toFixed(0), rect.y.toFixed(0));
  const beforeBright = await brightRatio();
  await click(rect.x, rect.y);
  await sleep(2600);
  const activeInfo = JSON.parse(await evaluate(`JSON.stringify({
    active: [...document.querySelectorAll('.parts-grid .part-item')].filter(r => r.classList.contains('active')).map(r => r.dataset.part),
  })`));
  A(activeInfo.active.length === 1, `点击后恰好一行激活：${JSON.stringify(activeInfo.active)}`);
  const afterBright = await brightRatio();
  A(afterBright > beforeBright * 2, `聚焦后画面被部件撑满：亮像素 ${beforeBright.toFixed(4)} → ${afterBright.toFixed(4)}`);

  // ===== 再点同一行取消选中 =====
  await click(rect.x, rect.y);
  await sleep(800);
  const activeAfter = await evaluate(`[...document.querySelectorAll('.parts-grid .part-item')].filter(r => r.classList.contains('active')).length`);
  A(activeAfter === 0, `再点同一行取消选中（实际仍激活 ${activeAfter} 行）`);

  // ===== isolate：配对差分 =====
  // 部件在默认相机下太小，亮度/连通域都没有区分度；聚焦后画面被撑满才有信号。
  // 但聚焦本身会让画面剧变，所以这里全部用「同一相机状态、只差可见性」的配对截图，
  // 再取一张等间隔的静止截图作漂移对照，把相机自转的抖动从结论里扣掉。
  const shotA = await shotPixels();
  await sleep(1200);
  const shotB = await shotPixels();
  const drift = diffFraction(shotA, shotB);
  OUT(`漂移对照（同状态等间隔）：${(drift * 100).toFixed(2)}%`);

  const eyeRect = JSON.parse(await evaluate(`(() => {
    const row = document.querySelectorAll('.parts-grid .part-item')[0];
    row.scrollIntoView({ block: 'nearest' });
    const e = row.querySelector('.part-eye').getBoundingClientRect();
    return JSON.stringify({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
  })()`));
  await sleep(300);
  await click(eyeRect.x, eyeRect.y);
  await sleep(1400);

  const isoInfo = JSON.parse(await evaluate(`JSON.stringify({
    isolated: document.querySelectorAll('.parts-grid .part-item.isolated').length,
    active: document.querySelectorAll('.parts-grid .part-item.active').length,
    showAll: (() => { const b = document.getElementById('parts-show-all'); return b ? !b.classList.contains('hidden') : null; })(),
  })`));
  A(isoInfo.isolated === 1 && isoInfo.active === 1, `单独显示生效：isolated 行 ${isoInfo.isolated}、active 行 ${isoInfo.active}`);
  A(isoInfo.showAll === true, "「全部显示」按钮已出现");

  const shotC = await shotPixels();
  const isoDiff = diffFraction(shotB, shotC);
  A(isoDiff > drift * 3 && isoDiff > 0.1, `其余部件真的消失了：变化像素 ${(isoDiff * 100).toFixed(1)}%（漂移对照 ${(drift * 100).toFixed(2)}%）`);
  await shot(process.env.SHOT || "/tmp/parts-isolate.png");

  // ===== 「全部显示」→ 恢复 =====
  const showAllRect = JSON.parse(await evaluate(`(() => {
    const b = document.getElementById('parts-show-all').getBoundingClientRect();
    return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  })()`));
  await click(showAllRect.x, showAllRect.y);
  await sleep(1400);
  const restored = JSON.parse(await evaluate(`JSON.stringify({
    isolated: document.querySelectorAll('.parts-grid .part-item.isolated').length,
    active: document.querySelectorAll('.parts-grid .part-item.active').length,
    showAll: document.getElementById('parts-show-all').classList.contains('hidden'),
  })`));
  A(restored.isolated === 0 && restored.active === 0 && restored.showAll === true,
    `「全部显示」恢复干净：isolated ${restored.isolated} / active ${restored.active} / 按钮隐藏 ${restored.showAll}`);
  const shotD = await shotPixels();
  const restoreDiff = diffFraction(shotC, shotD);
  A(restoreDiff > drift * 3 && restoreDiff > 0.1, `恢复显示后部件回来：变化像素 ${(restoreDiff * 100).toFixed(1)}%`);

  // ===== Escape 也能退（键盘路径）=====
  await click(eyeRect.x, eyeRect.y);
  await sleep(1400);
  const escPre = await shotPixels();
  await key("Escape");
  await sleep(1400);
  const escInfo = JSON.parse(await evaluate(`JSON.stringify({
    isolated: document.querySelectorAll('.parts-grid .part-item.isolated').length,
    active: document.querySelectorAll('.parts-grid .part-item.active').length,
  })`));
  A(escInfo.isolated === 0 && escInfo.active === 0, `Escape 同样能退（isolated ${escInfo.isolated} / active ${escInfo.active}）`);
  const escPost = await shotPixels();
  const escDiff = diffFraction(escPre, escPost);
  A(escDiff > drift * 3 && escDiff > 0.1, `Escape 后部件回来：变化像素 ${(escDiff * 100).toFixed(1)}%`);

  A(pageErrors.length === 0, `全程 0 运行时异常（实际 ${pageErrors.length}）`);
} catch (e) {
  OUT("  FAIL 冒烟执行异常：" + e.message);
  failed++;
} finally {
  await ui.stop();
}

OUT(`\nsmoke: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
