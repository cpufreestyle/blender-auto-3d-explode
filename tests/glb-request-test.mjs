#!/usr/bin/env node
/**
 * 单元测试 — GLB 二进制请求公共层（src/panels/glb-request.js，
 * 从 src/panels/ai-paint-panel.js 抽取）
 *
 * 抽取的不变量：
 *   - responseType 固定 "arraybuffer"，timeout 原样等于传入的 timeoutMs；
 *   - 方法固定 POST、Content-Type 固定 application/json、body 是 payload 的
 *     JSON 字符串（含中文时不解码、不转义）；
 *   - 200 时 resolve 出 { arrayBuffer, manifest, totalParts, elapsedSeconds }：
 *     arrayBuffer 原样透传 xhr.response，manifest 按 base64→UTF-8→JSON 解出，
 *     缺 X-Manifest 时为 null（不抛错，与 imageTo3D 一致）；
 *   - totalParts 十进制解析，缺头回落 0；elapsedSeconds parseFloat，缺头回落 0；
 *   - requireSuccess 默认 false：imageTo3D 本来就不看 X-Success；
 *     requireSuccess 为 true 时，X-Success 不是 "true" 一律 reject
 *     「服务器返回异常」，且该校验发生在响应头解析之前；
 *   - 状态码非 200 一律 reject：优先取响应体 JSON 的 error 字段，
 *     非 JSON 或 JSON 无 error 字段时退回「服务器错误 <状态码>」；
 *   - error 事件 reject 固定的网络错误文案；timeout 事件 reject
 *     「请求超时（<label>）」，label 由调用方给，与 timeoutMs 解耦；
 *   - load 回调里 manifest 解不出来（坏 base64 / 非法 JSON）时，
 *     异常由外层 try/catch 捕获后 reject，不会变成 resolve。
 *
 * 用法：node tests/glb-request-test.mjs
 */

import { postGlbRequest, parseGlbResponseHeaders, parseXhrErrorMessage } from "../src/panels/glb-request.js";
import { base64ToUtf8 } from "../src/utils.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}`);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
function it(_name, fn) {
  return fn();
}

async function settles(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: err.message };
  }
}

// ===== 假 XMLHttpRequest =====
// 记下 open/setRequestHeader/send 的入参，send 时按剧本置好响应态，
// 并在下一个宏任务触发指定事件，模拟真实 XHR 的异步性。
const MANIFEST_B64 = btoa(
  String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ engine: "triposr", parts: ["a", "b"] }))),
);

function installFakeXhr(script) {
  const sent = {};
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    configurable: true,
    value: class {
      constructor() {
        this.listeners = {};
        this.requestHeaders = {};
        this.status = 200;
        this.response = null;
        this.responseType = "";
        this.timeout = 0;
        sent.xhr = this;
      }
      addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
      }
      open(method, url) {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader(key, value) {
        this.requestHeaders[key] = value;
      }
      send(body) {
        sent.body = body;
        script.xhr = this;
        script.headers = script.headers || {};
        this.status = script.status === undefined ? 200 : script.status;
        this.response = script.response === undefined ? new ArrayBuffer(8) : script.response;
        script.responseHeaders.forEach(h => Object.assign(script.headers, h));
        process.nextTick(() => (this.listeners[script.event || "load"] || []).forEach(fn => fn()));
      }
      getResponseHeader(key) {
        return script.headers[key];
      }
    },
  });
  return sent;
}

const HAD_XHR = "XMLHttpRequest" in globalThis;
const SAVED_XHR = globalThis.XMLHttpRequest;
function restoreXhr() {
  if (HAD_XHR) Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: SAVED_XHR });
  else delete globalThis.XMLHttpRequest;
}

const scrub = r => { delete r.xhr; return r; };

// ===== 用例 =====
describe("postGlbRequest — 请求侧", async() => {
  await it("按 POST + JSON 头发 payload", async() => {
    const sent = installFakeXhr({ responseHeaders: [{ "X-Total-Parts": "1" }] });
    await postGlbRequest({ url: "http://x/api/y", payload: { a: 1 }, timeoutMs: 5, timeoutLabel: "1分钟" });
    assert(sent.method === "POST", "方法固定 POST");
    assert(sent.url === "http://x/api/y", "url 原样透传");
    assert(sent.xhr.requestHeaders["Content-Type"] === "application/json", "Content-Type 固定 application/json");
    assert(sent.xhr.responseType === "arraybuffer", "responseType 固定 arraybuffer");
    assert(sent.xhr.timeout === 5, "timeout 等于传入的 timeoutMs");
    assert(sent.body === JSON.stringify({ a: 1 }), "body 是 payload 的 JSON 字符串");
    scrub(sent);
  });

  await it("中文 payload 不被转义", async() => {
    const sent = installFakeXhr({ responseHeaders: [{}] });
    await postGlbRequest({ url: "u", payload: { prompt: "篮球 头显" }, timeoutMs: 5, timeoutLabel: "x" });
    assert(sent.body === "{\"prompt\":\"篮球 头显\"}", `中文原样序列化: ${sent.body}`);
    scrub(sent);
  });
});

describe("postGlbRequest — 成功路径", async() => {
  await it("全响应头齐备时解出四个字段", async() => {
    installFakeXhr({
      responseHeaders: [
        { "X-Success": "true", "X-Total-Parts": "9", "X-Elapsed-Seconds": "3.5", "X-Manifest": MANIFEST_B64 },
      ],
    });
    const r = await settles(() =>
      postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x", requireSuccess: true }),
    );
    assert(!r.error, `未 reject: ${r.error}`);
    assert(r.value && r.value.manifest.engine === "triposr", "manifest 解出 engine");
    assert(r.value.totalParts === 9, "totalParts = 9");
    assert(r.value.elapsedSeconds === 3.5, "elapsedSeconds = 3.5");
    assert(r.value.arrayBuffer instanceof ArrayBuffer, "arrayBuffer 透传");
  });

  await it("缺 X-Manifest 时 manifest 为 null 且不抛错", async() => {
    installFakeXhr({ responseHeaders: [{ "X-Total-Parts": "4" }] });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(!r.error, `未 reject: ${r.error}`);
    assert(r.value.manifest === null, "manifest 回落 null");
    assert(r.value.totalParts === 4, "totalParts 仍解出");
  });

  await it("缺 X-Total-Parts 与 X-Elapsed-Seconds 时回落 0", async() => {
    installFakeXhr({ responseHeaders: [{}] });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(r.value.totalParts === 0, "totalParts = 0");
    assert(r.value.elapsedSeconds === 0, "elapsedSeconds = 0");
  });

  await it("requireSuccess 缺省为 false：不看 X-Success 也能 resolve", async() => {
    installFakeXhr({ responseHeaders: [{ "X-Total-Parts": "1" }] });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(!r.error, "未传 requireSuccess 时不校验 X-Success");
    assert(r.value.totalParts === 1, "照常 resolve");
  });

  await it("requireSuccess 为 true 时 X-Success 缺失即 reject", async() => {
    installFakeXhr({ responseHeaders: [{ "X-Total-Parts": "1" }] });
    const r = await settles(() =>
      postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x", requireSuccess: true }),
    );
    assert(r.error === "服务器返回异常", `reject 文案: ${r.error}`);
  });

  await it("X-Success 为字符串 false 同样 reject", async() => {
    installFakeXhr({ responseHeaders: [{ "X-Success": "false" }] });
    const r = await settles(() =>
      postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x", requireSuccess: true }),
    );
    assert(r.error === "服务器返回异常", `reject 文案: ${r.error}`);
  });
});

describe("postGlbRequest — 失败路径", async() => {
  await it("非 200 且响应体是 JSON：取后端 error 字段", async() => {
    installFakeXhr({
      status: 500,
      response: new TextEncoder().encode(JSON.stringify({ error: "显存不足" })).buffer,
      responseHeaders: [{}],
    });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(r.error === "显存不足", `reject 文案: ${r.error}`);
  });

  await it("非 200 且响应体非 JSON：退回服务器错误 + 状态码", async() => {
    installFakeXhr({
      status: 502,
      response: new TextEncoder().encode("<html>bad gateway</html>").buffer,
      responseHeaders: [{}],
    });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(r.error === "服务器错误 502", `reject 文案: ${r.error}`);
  });

  await it("非 200 且 JSON 里没有 error 字段：同样退回状态码", async() => {
    installFakeXhr({
      status: 404,
      response: new TextEncoder().encode(JSON.stringify({ other: 1 })).buffer,
      responseHeaders: [{}],
    });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(r.error === "服务器错误 404", `reject 文案: ${r.error}`);
  });

  await it("error 事件：固定网络错误文案", async() => {
    installFakeXhr({ event: "error", status: 0, responseHeaders: [{}] });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(r.error === "网络错误：无法连接到服务器（请确认 server.js 已启动）", `reject 文案: ${r.error}`);
  });

  await it("timeout 事件：文案由调用方给的 label 拼出", async() => {
    installFakeXhr({ event: "timeout", status: 0, responseHeaders: [{}] });
    const long = await settles(() =>
      postGlbRequest({ url: "u", payload: {}, timeoutMs: 1200000, timeoutLabel: "20分钟" }),
    );
    installFakeXhr({ event: "timeout", status: 0, responseHeaders: [{}] });
    const short = await settles(() =>
      postGlbRequest({ url: "u", payload: {}, timeoutMs: 120000, timeoutLabel: "2分钟" }),
    );
    assert(long.error === "请求超时（20分钟）", `长超时文案: ${long.error}`);
    assert(short.error === "请求超时（2分钟）", `短超时文案: ${short.error}`);
  });

  await it("状态码边界：2xx / 3xx 里除 200 以外的一律拒", async() => {
    for (const status of [204, 304, 100]) {
      installFakeXhr({ status, responseHeaders: [{ "X-Success": "true", "X-Total-Parts": "3" }] });
      const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
      assert(r.error === `服务器错误 ${status}`, `状态码 ${status} 应被拒（实际: ${r.error}）`);
    }
  });

  await it("坏 manifest 在 load 内解析失败：转为 reject 而非 resolve", async() => {
    installFakeXhr({ responseHeaders: [{ "X-Manifest": "!!!not-json!!!" }] });
    const r = await settles(() => postGlbRequest({ url: "u", payload: {}, timeoutMs: 5, timeoutLabel: "x" }));
    assert(!!r.error, `reject 而非 resolve: ${r.error}`);
  });
});

describe("parseGlbResponseHeaders / parseXhrErrorMessage", async() => {
  await it("按十进制解析 totalParts", async() => {
    const xhr = { getResponseHeader: k => ({ "X-Total-Parts": "12", "X-Elapsed-Seconds": "1.25" })[k] };
    const h = parseGlbResponseHeaders(xhr);
    assert(h.totalParts === 12, `totalParts = ${h.totalParts}`);
    assert(h.elapsedSeconds === 1.25, `elapsedSeconds = ${h.elapsedSeconds}`);
    assert(h.manifest === null, "缺 X-Manifest 时为 null");
  });

  await it("manifest 含中文时按 UTF-8 解出", async() => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ name: "机壳" }))));
    const xhr = { getResponseHeader: k => ({ "X-Manifest": b64 })[k] };
    assert(parseGlbResponseHeaders(xhr).manifest.name === "机壳", "中文 manifest 正确解码");
  });

  await it("parseXhrErrorMessage 三级回落", async() => {
    const withError = { status: 500, response: new TextEncoder().encode(JSON.stringify({ error: "后端炸了" })).buffer };
    const plainText = { status: 503, response: new TextEncoder().encode("oops").buffer };
    const noField = { status: 500, response: new TextEncoder().encode(JSON.stringify({ a: 1 })).buffer };
    assert(parseXhrErrorMessage(withError) === "后端炸了", "取 JSON.error");
    assert(parseXhrErrorMessage(plainText) === "服务器错误 503", "非 JSON 退状态码");
    assert(parseXhrErrorMessage(noField) === "服务器错误 500", "无 error 字段退状态码");
  });

  await it("base64ToUtf8 仍是 parseGlbResponseHeaders 的解码路径", async() => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("{\"k\":\"值\"}")));
    assert(JSON.parse(base64ToUtf8(b64)).k === "值", "base64ToUtf8 与响应头解码同源");
  });
});

// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } finally {
    restoreXhr();
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
