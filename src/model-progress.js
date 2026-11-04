// 模型加载统一进度（纯逻辑模块，无 DOM 依赖）。
//
// 机制来源：three.js GLTFLoader 的 onProgress 回调 + model-viewer 的
// loadWithLoader progress 事件（fraction = loaded/total，clamp 到 [0,1]）。
// 三条加载路径（上传 / AI 生成 / 生成库）共用同一套百分比计算与文案格式化，
// 渲染节流与相同值去重在 reporter 内完成，避免流式回调每帧打 DOM。

/**
 * 字节级进度百分比。loaded/total 任一非法、或 total <= 0（分块响应无
 * Content-Length）时返回 null —— 调用方应回退到「已接收 N MB」文案而非显示 0%。
 * @returns {number|null} 0-100 的整数百分比
 */
export function computePercent(loaded, total) {
  if (!Number.isFinite(loaded) || loaded < 0) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.round((loaded / total) * 100));
}

/**
 * 进度文案格式化。total 已知时显示百分比；未知时显示已接收 MB；均非法时
 * 返回 fallback（默认空串，调用方通常已有自己的阶段文案）。
 */
export function formatProgressText({ loaded, total, fallback = "" }) {
  const percent = computePercent(loaded, total);
  if (percent !== null) {
    return total >= 1024 * 1024
      ? `${percent}%（${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB）`
      : `${percent}%（${(loaded / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB）`;
  }
  if (Number.isFinite(loaded) && loaded > 0) {
    return `已接收 ${(loaded / 1024 / 1024).toFixed(1)} MB`;
  }
  return fallback;
}

/**
 * 进度回调节流 + 去重。
 *   - 节流：minIntervalMs 内的多次 report 只发第一次（下载流每个 chunk 一次
 *     回调，直连 DOM 会被打爆；首次永远立即发，让用户第一时间看到进度出现）；
 *   - 去重：百分比相同且字节相同（停滞的分块下载）不重复发；
 *   - complete 永远直通，保证结束态一定到达渲染层。
 * @param {(payload: {loaded: number, total: number|null}) => void} onProgress
 */
export function createProgressReporter(onProgress, { minIntervalMs = 120 } = {}) {
  let lastEmitTime = 0;
  let lastPayloadKey = "";
  let started = false;

  function report({ loaded, total }) {
    if (typeof onProgress !== "function") return;
    const key = `${loaded}:${total}`;
    if (key === lastPayloadKey) return; // 相同值去重
    const now = Date.now();
    if (started && now - lastEmitTime < minIntervalMs) return; // 节流
    started = true;
    lastEmitTime = now;
    lastPayloadKey = key;
    onProgress({ loaded, total: total ?? null });
  }

  function complete() {
    if (typeof onProgress !== "function") return;
    lastEmitTime = 0;
    started = false;
    lastPayloadKey = "";
    onProgress({ loaded: -1, total: null, done: true });
  }

  return { report, complete };
}

/**
 * 流式 fetch + 字节级进度（生成库 / 任意 GET 二进制下载共用）。
 * Content-Length 存在时 total 为字节数；缺失（chunked）时为 null，
 * onProgress 里用 formatProgressText 自动回退「已接收 N MB」。
 * 不支持流式 body 的环境（旧浏览器 / 测试替身无 body.getReader）直接
 * arrayBuffer()，跳过进度回调但功能不受影响。
 */
export async function fetchArrayBufferWithProgress(url, { onProgress } = {}) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("加载失败 " + resp.status);

  const totalHeader = Number(resp.headers?.get?.("Content-Length"));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;

  if (!resp.body || typeof resp.body.getReader !== "function") {
    const buf = await resp.arrayBuffer();
    if (onProgress) onProgress({ loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress({ loaded: received, total });
  }

  const buffer = new ArrayBuffer(received);
  const view = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

