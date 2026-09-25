// GLB 二进制请求公共层（从 src/panels/ai-paint-panel.js 抽取，行为不变）。
//
// imageTo3D 与 generateModel 原本各自手写同一套约 45 行样板：new
// XMLHttpRequest -> responseType=arraybuffer -> timeout -> load/error/timeout
// 三个监听 -> 状态码非 200 时从响应体取后端 error -> 解析 X-Manifest /
// X-Total-Parts / X-Elapsed-Seconds 响应头。两份语义逐条一致，只有三处差异：
// 超时时长与文案、是否校验 X-Success 头、请求体。本模块把公共部分收口，
// 差异点以参数暴露。
//
// 自包含：只用 XMLHttpRequest / TextDecoder 两个浏览器全局与 utils.js 的
// base64ToUtf8，不依赖 DOM，也不引用 setupAIPaint 的任何状态，因此无 DI 接缝。

import { base64ToUtf8 } from "../utils.js";

// 后端错误透传：优先取响应体 JSON 的 error 字段，取不到则退回「服务器错误 + 状态码」
export function parseXhrErrorMessage(xhr) {
  const errText = new TextDecoder().decode(xhr.response);
  let errMsg = `服务器错误 ${xhr.status}`;
  try {
    errMsg = JSON.parse(errText).error || errMsg;
  } catch {}
  return errMsg;
}

// 解析模型响应头：manifest 按 base64 -> UTF-8 -> JSON 解出，缺 X-Manifest 时为 null。
// totalParts 统一按十进制解析（服务端 response-utils.js 写入的就是 String(整数)）。
export function parseGlbResponseHeaders(xhr) {
  const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";
  let manifest = null;
  if (manifestBase64) {
    manifest = JSON.parse(base64ToUtf8(manifestBase64));
  }
  return {
    manifest,
    totalParts: parseInt(xhr.getResponseHeader("X-Total-Parts") || "0", 10),
    elapsedSeconds: parseFloat(xhr.getResponseHeader("X-Elapsed-Seconds") || "0"),
  };
}

// POST 一段 JSON 载荷，按二进制 GLB 取响应，resolve 出
// { arrayBuffer, manifest, totalParts, elapsedSeconds }。
// timeoutMs 与 timeoutLabel 描述同一件事，改超时时必须同时改（label 仅用于拼文案）；
// requireSuccess 为 true 时额外要求 X-Success: true（generateModel 的既有契约）。
export function postGlbRequest({
  url,
  payload,
  timeoutMs,
  timeoutLabel,
  requireSuccess = false,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.responseType = "arraybuffer";
    xhr.timeout = timeoutMs;

    xhr.addEventListener("load", () => {
      try {
        if (xhr.status !== 200) {
          reject(new Error(parseXhrErrorMessage(xhr)));
          return;
        }
        if (requireSuccess && xhr.getResponseHeader("X-Success") !== "true") {
          reject(new Error("服务器返回异常"));
          return;
        }
        resolve({ arrayBuffer: xhr.response, ...parseGlbResponseHeaders(xhr) });
      } catch (err) {
        reject(err);
      }
    });
    xhr.addEventListener("error", () =>
      reject(new Error("网络错误：无法连接到服务器（请确认 server.js 已启动）")),
    );
    xhr.addEventListener("timeout", () => reject(new Error(`请求超时（${timeoutLabel}）`)));

    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(payload));
  });
}
