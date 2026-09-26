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
 *   PORT=3933 CDP_PORT=9279 CHROME_PATH=/path/to/chrome node scripts/ci_parts_ui_smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或页面卡死；0 且首行 SKIP = 本机没有 Chrome。
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || "3933";
const CDP = process.env.CDP_PORT || "9279";
const SHOT = process.env.SHOT || "/tmp/parts-isolate.png";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = console.log.bind(console);

if (!fs.existsSync(CHROME)) {
  OUT(`SKIP: 未找到 Chrome（${CHROME}），本机无法跑浏览器冒烟`);
  process.exit(0);
}

const srv = spawn("node", ["server.js"], {
  cwd: ROOT,
  stdio: "ignore",
  env: { ...process.env, PORT },
});
let up = false;
for (let i = 0; i < 80; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (r.ok) { up = true; break; }
  } catch { /* 等它起来 */ }
}
OUT("server ready:", up);
if (!up) { srv.kill(); process.exit(1); }

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--no-sandbox", `--user-data-dir=/tmp/cdp-parts-smoke-${Date.now()}`, "--window-size=1280,860",
  `--remote-debugging-port=${CDP}`, "about:blank",
], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
    target = list.find(t => t.type === "page");
    if (target) break;
  } catch { /* 等它起来 */ }
}
if (!target) { OUT("NO TARGET"); chrome.kill(); srv.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
let id = 0;
const rawSend = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  const onMsg = ev => {
    const m = JSON.parse(ev.data);
    if (m.id === myId) { ws.removeEventListener("message", onMsg); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
// 每个 CDP 调用都带超时：页面若被死循环占住，这里要能报出来而不是静静挂住
const send = async (method, params) => {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT on ${method}（渲染进程疑似被死循环占住）`)), 25000));
  return Promise.race([rawSend(method, params), timeout]);
};
await send("Runtime.enable", {});
await send("Page.enable", {});

const pageErrors = [];
ws.addEventListener("message", ev => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails || {};
    pageErrors.push(((d.exception || {}).description || d.text || "").split("\n")[0]);
  }
});

let passed = 0;
let failed = 0;
const A = (cond, msg) => { OUT((cond ? "  OK   " : "  FAIL ") + msg); cond ? passed++ : failed++; };
async function evaluate(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
  return r.result.value;
}
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

// ===== 纯 Node 的 PNG 解码 + 画面度量（不引第三方依赖）=====
function decodePng(buf) {
  let off = 8; let w = 0; let h = 0; let ct = 6;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y === 0 ? null : px.subarray((y - 1) * stride, y * stride);
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
const shotPixels = async () => decodePng(Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
// 只统计右侧画面（x>=430），把左侧工具面板排除在外
const X0 = 430;
const brightRatio = async () => {
  const { w, h, bpp, px } = await shotPixels();
  let n = 0; let tot = 0;
  for (let y = 0; y < h; y++) for (let x = X0; x < w; x++) {
    tot++;
    const i = (y * w + x) * bpp;
    if ((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 > 70) n++;
  }
  return n / tot;
};
const diffFraction = (a, b) => {
  if (a.w !== b.w || a.h !== b.h) return 1;
  let n = 0; let tot = 0;
  for (let y = 0; y < a.h; y++) for (let x = X0; x < a.w; x++) {
    const i = (y * a.w + x) * a.bpp;
    tot++;
    if (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]) > 30) n++;
  }
  return n / tot;
};

try {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
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
  fs.writeFileSync(SHOT, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

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
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
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
  chrome.kill();
  srv.kill();
}

OUT(`\nsmoke: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
