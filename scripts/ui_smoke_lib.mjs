#!/usr/bin/env node
/**
 * 真机 UI 冒烟共用骨架（Chrome CDP + 纯 Node PNG 度量，无第三方依赖）。
 *
 * 为什么单独一个文件：仓库里的 .mjs 单测靠假 DOM，MutationObserver 这类「DOM 写
 * 回去喂给自己」的整页卡死它们照不出来（part-interactions 那一刀就踩过：单测全绿，
 * 真机点一下 isolate 渲染进程被拖死）。所有真机冒烟都需要同一套东西——起 dev server、
 * 起 headless Chrome、连 CDP、超时保护、页面异常收集、PNG 解码与画面度量——所以抽在
 * 这里，各场景脚本只写自己的断言。
 *
 *   const ui = await startUiSmoke({ port, cdp, url });
 *   if (!ui) { /* 本机没有 Chrome，调用方自行 SKIP *\/ }
 *   await ui.evaluate("...");
 *   await ui.click(x, y);
 *   const a = await ui.shotPixels();
 *
 * 用法：被 ci_*_ui_smoke.mjs 引用，不单独运行。
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 画面度量只统计右侧（x >= 430），把左侧工具面板排除在外
export const X0 = 430;
const CALL_TIMEOUT_MS = 25000;

/** 纯 Node PNG 解码（只处理 CDP 交回来的 8bit RGB/RGBA 非隔行图）。 */
export function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let ct = 6;
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
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}

/**
 * 起服务 + headless Chrome + CDP，返回操作句柄。
 * 找不到 Chrome 时返回 null（调用方自行 SKIP，不当作失败）。
 */
export async function startUiSmoke({
  port = "3933",
  cdp = "9279",
  url = "/",
  chromePath = DEFAULT_CHROME,
} = {}) {
  if (!fs.existsSync(chromePath)) return null;

  const srv = spawn("node", ["server.js"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PORT: port } });
  let up = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) { up = true; break; }
    } catch { /* 等它起来 */ }
  }
  if (!up) {
    srv.kill();
    throw new Error(`dev server 未就绪（port ${port}）`);
  }

  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--no-sandbox", `--user-data-dir=/tmp/cdp-ui-smoke-${Date.now()}`, "--window-size=1280,860",
    `--remote-debugging-port=${cdp}`, "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
      target = list.find(t => t.type === "page");
      if (target) break;
    } catch { /* 等它起来 */ }
  }
  if (!target) {
    chrome.kill();
    srv.kill();
    throw new Error("headless Chrome 没有交出可用的 page target");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });

  let id = 0;
  const rawSend = (method, params) => new Promise((res, rej) => {
    const myId = ++id;
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === myId) {
        ws.removeEventListener("message", onMsg);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  // 每个 CDP 调用都带超时：页面若被死循环占住，要能报出来而不是静静挂住
  const send = async (method, params) => {
    const timer = new Promise((_, rej) => setTimeout(
      () => rej(new Error(`TIMEOUT on ${method}（渲染进程疑似被死循环占住）`)),
      CALL_TIMEOUT_MS,
    ));
    return Promise.race([rawSend(method, params), timer]);
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

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  // 特殊键必须给对 VirtualKeyCode：Tab 按字母推导会算成 84（"TAB".charCodeAt(0)），
  // 浏览器不认，焦点就不动
  const KEY_VK = { Tab: 9, Enter: 13, Escape: 27, " ": 32, ArrowLeft: 37, ArrowRight: 39 };
  const key = async k => {
    const vk = KEY_VK[k] !== undefined ? KEY_VK[k] : k.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk });
  };
  const shotPixels = async () => decodePng(Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  // 亮像素占比：isolate 后其余部件不再反光
  const brightRatio = async () => {
    const { w, h, bpp, px } = await shotPixels();
    let n = 0;
    let tot = 0;
    for (let y = 0; y < h; y++) for (let x = X0; x < w; x++) {
      tot++;
      const i = (y * w + x) * bpp;
      if ((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 > 70) n++;
    }
    return n / tot;
  };
  // 两张截图的变化像素占比：证明「画面确实变了」，配等间隔静止截图可扣掉相机自转漂移
  const diffFraction = (a, b) => {
    if (a.w !== b.w || a.h !== b.h) return 1;
    let n = 0;
    let tot = 0;
    for (let y = 0; y < a.h; y++) for (let x = X0; x < a.w; x++) {
      const i = (y * a.w + x) * a.bpp;
      tot++;
      if (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]) > 30) n++;
    }
    return n / tot;
  };
  const shot = async file => {
    const png = Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
    if (file) fs.writeFileSync(file, png);
    return png;
  };

  // 视口模拟：窄屏冒烟在同一个 Chrome 实例里收窄视口再还原，
  // 比 --window-size 灵活（跑完记得 clearViewport）
  const setViewport = async (width, height, deviceScaleFactor = 2, mobile = false) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
  };
  const clearViewport = async () => { await send("Emulation.clearDeviceMetricsOverride", {}); };

  await send("Page.navigate", { url: `http://127.0.0.1:${port}${url}` });

  return {
    port,
    send,
    evaluate,
    click,
    key,
    setViewport,
    clearViewport,
    shotPixels,
    brightRatio,
    diffFraction,
    shot,
    pageErrors,
    async stop() {
      chrome.kill();
      srv.kill();
    },
  };
}
