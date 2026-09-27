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

// 「首次使用：模型配置」引导弹窗（index.html #first-config-modal）在全新 profile 下
// 必定弹出，且铺满视口、内含 iframe——CDP 派发的鼠标事件全被那层 iframe 吃掉。
// 于是「点部件行没反应」「点收起钮没反应」会伪装成产品缺陷：smoke:parts 与
// smoke:sidebar 长期红、失败项一字不差的真因就在这里（键盘路径不受影响，所以
// Escape/H 的断言一直绿，更显得像产品坏了）。
// 下面这句预置弹窗自己的那把钥匙（与 dismiss() 同写 sessionStorage），
// 写在页面脚本之前，于是冒烟跑在「已经忽略过引导」的正常页面状态上。
const FIRST_RUN_FLAG = "try{sessionStorage.setItem('configPromptDismissed','1');}catch(e){}";

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

  // profile 目录带 pid：三条门禁同时跑时，仅用 Date.now() 有机会撞上同一个目录，
  // 第二个 Chrome 会因单例锁直接退出、调试端口永不就绪，现象只有一句「没有 page target」。
  const profile = `/tmp/cdp-ui-smoke-${process.pid}-${Date.now().toString(36)}`;
  // Chrome 自己的输出留档：起不来时至少要能看到它说了什么
  const chromeLog = `/tmp/cdp-ui-smoke-chrome-${process.pid}.log`;
  const chromeFd = fs.openSync(chromeLog, "w");
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--no-sandbox", `--user-data-dir=${profile}`, "--window-size=1280,860",
    `--remote-debugging-port=${cdp}`, "about:blank",
  ], { stdio: ["ignore", chromeFd, chromeFd] });
  const chromeTail = () => {
    try {
      return fs.readFileSync(chromeLog, "utf8").split("\n").filter(l => l.trim()).slice(-4).join(" | ");
    } catch { return ""; }
  };

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
    throw new Error(`headless Chrome 没有交出可用的 page target（profile ${profile}，日志 ${chromeLog}：${chromeTail()}）`);
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

  // 就绪判定：加载遮罩收起 + 没有错误框 + 画布在 + 部件清单有行。
  // 替掉此前每步硬 sleep(9000)：既省时间，又把「页面根本没起来」变成一条明确断言，
  // 而不是后面一串莫名其妙的失败。
  const waitReady = async (timeoutMs = 20000) => {
    const started = Date.now();
    let state = { ok: false, loading: false, error: false, canvas: false, rows: 0, ms: 0 };
    while (Date.now() - started < timeoutMs) {
      const raw = await evaluate(`JSON.stringify({
        loading: (() => { const el = document.getElementById("loading"); return el ? el.classList.contains("hidden") : true; })(),
        error: (() => { const el = document.getElementById("error"); return el ? !el.classList.contains("hidden") : false; })(),
        canvas: !!document.querySelector("canvas"),
        rows: document.querySelectorAll(".parts-grid .part-item").length,
      })`).catch(() => null);
      if (raw) {
        const s = JSON.parse(raw);
        state = { ...s, ok: s.loading && !s.error && s.canvas && s.rows > 0, ms: Date.now() - started };
        if (state.ok) { await sleep(300); return state; }
      }
      await sleep(200);
    }
    state.ms = Date.now() - started;
    return state;
  };

  // 兜底：预置标志位之后弹窗本不该再出现；真出现了就明确报出来并收掉，
  // 别让后面十几条断言陪葬（返回 true = 确实收起了一层遮罩）。
  const hideFirstRunModal = async () => evaluate(`(() => {
    const ov = document.getElementById("first-config-modal");
    if (!ov || ov.classList.contains("hidden")) return false;
    ov.classList.add("hidden");
    return true;
  })()`);

  // 命中测试：该点最上层元素自身或任一层祖先匹配 selector（用 closest，别用
  // querySelector 取「第一个」，否则点到第二行会被误判成没点到）。点击没反应时先
  // 用它定位：被 iframe / 遮罩盖住会当场显形，而不是伪装成「点了没用」。
  const hitTest = async (x, y, selector) => JSON.parse(await evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    const cls = el ? String(el.className || "").trim().split(" ").filter(Boolean).join(".") : "";
    return JSON.stringify({
      inside: !!(el && el.closest && el.closest(${JSON.stringify(selector)})),
      hit: el ? el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "") : null,
    });
  })()`));

  const reload = async () => {
    await send("Page.reload", { ignoreCache: false });
    return waitReady();
  };

  await send("Page.addScriptToEvaluateOnNewDocument", { source: FIRST_RUN_FLAG });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}${url}` });

  // headless 在页面还没拿到输入焦点时，会自行把输入事件标记为「忽略」，
  // 之后 CDP 派发的 Input.dispatchMouseEvent 会被静默丢弃——事件连 DOM 都到不了。
  // 症状极具迷惑性：页面 0 运行时异常、按钮监听器确实绑着、元素命中也对，
  // 但 ui.click() 之后界面纹丝不动，而 JS 的 el.click() 完全正常，
  // 于是 parts / sidebar 两套冒烟整片飘红，看着像应用坏了，其实是浏览器把输入吞了。
  // 显式关掉。浏览器版本一变这里最值得先复查（探针法：直接 el.click() 对照）。
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
    waitReady,
    hideFirstRunModal,
    hitTest,
    reload,
    pageErrors,
    async stop() {
      chrome.kill();
      srv.kill();
    },
  };
}
