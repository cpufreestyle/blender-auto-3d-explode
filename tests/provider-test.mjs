#!/usr/bin/env node
/**
 * 单元测试 — 图片转3D 提供商（Meshy / Tripo / Hyper3D）
 *
 * 通过 mock 全局 fetch 测试 src/providers/image-to-3d.js 中的三个「纯函数」：
 *   - runMeshyImageTo3D / runTripoImageTo3D / runHyper3DImageTo3D
 * 验证：成功路径返回 { glbBuffer, manifest }；缺失 API Key 抛出 status=400 的错误；
 *       任务失败状态正确上抛。
 *
 * 不依赖真实 API Key，不发起真实网络请求。
 *
 * 用法：
 *   node tests/provider-test.mjs
 */

import {
  runMeshyImageTo3D,
  runTripoImageTo3D,
  runHyper3DImageTo3D,
  runHyper3DTextTo3D,
} from "../src/providers/image-to-3d.js";
import * as providerModule from "../src/providers/image-to-3d.js";

// ===== 测试框架（与 unit-test.mjs 一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
    failures.push(message);
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${message}: ${actual}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}

// ===== fetch mock 基础设施 =====
const originalFetch = globalThis.fetch;

// 一个可识别的 GLB 字节流（magic 'glTF' + 占位数据）
const GLB_BYTES = Buffer.from([
  0x67, 0x6c, 0x54, 0x46, // 'glTF'
  0x02, 0x00, 0x00, 0x00, // version 2
  0x14, 0x00, 0x00, 0x00, // total length (20)
  0x00, 0x00, 0x00, 0x00,
  0x4a, 0x53, 0x4f, 0x4e, // 'JSON'
]);

function jsonResponse(obj, status = 200) {
  const text = JSON.stringify(obj);
  return {
    ok: status < 400,
    status,
    text: async() => text,
    json: async() => obj,
    arrayBuffer: async() => new Uint8Array(Buffer.from(text)).buffer,
  };
}

function glbResponse(status = 200) {
  return {
    ok: status < 400,
    status,
    text: async() => "glb-bytes",
    json: async() => ({}),
    arrayBuffer: async() => new Uint8Array(GLB_BYTES).buffer,
  };
}

// 安装一个根据 URL 返回响应的 fetch 实现
function installFetch(responder) {
  globalThis.fetch = async(url, opts) => responder(url, opts || {});
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// 成功路径的标准响应映射（URL -> 响应）
function successResponder(url) {
  if (url === "https://api.meshy.ai/openapi/v1/image-to-3d")
    return jsonResponse({ result: "task-meshy-1" });
  if (url === "https://api.meshy.ai/openapi/v1/image-to-3d/task-meshy-1")
    return jsonResponse({ status: "SUCCEEDED", model_urls: { glb: "https://cdn/glb.mesh" } });
  if (url === "https://openapi.tripo3d.ai/v3/files")
    return jsonResponse({ data: { file_token: "ft-1" } });
  if (url === "https://openapi.tripo3d.ai/v3/generation/image-to-model")
    return jsonResponse({ data: { task_id: "tid-1" } });
  if (url === "https://openapi.tripo3d.ai/v3/tasks/tid-1")
    return jsonResponse({ data: { status: "success", output: { model_url: "https://cdn/glb.tripo" } } });
  if (url === "https://hyperhuman.deemos.com/api/v2/rodin")
    return jsonResponse({ uuid: "u-1", subscription_key: "sk-1" });
  if (url === "https://hyperhuman.deemos.com/api/v2/status")
    return jsonResponse({ jobs: [{ status: "Done" }] });
  if (url === "https://hyperhuman.deemos.com/api/v2/download")
    return jsonResponse({ list: [{ name: "model.glb", url: "https://cdn/glb.h3d" }] });
  // 任意 cdn 下载链接返回 GLB 字节
  if (url.startsWith("https://cdn/")) return glbResponse();
  return jsonResponse({ error: "unexpected url: " + url }, 500);
}

const SAMPLE_BODY = { image: "data:image/png;base64,iVBORw0KGgo=" };
const SAMPLE_B64 = Buffer.from("fake-image-bytes").toString("base64");

// 确保缺失 Key 测试环境干净
function clearProviderEnv() {
  delete process.env.MESHY_API_KEY;
  delete process.env.TRIPO_API_KEY;
  delete process.env.HYPER3D_API_KEY;
}

// 折叠定时器：模块内 pollTask 使用 setTimeout 做轮询间隔（5s），
// 测试中将其坍缩为即时触发，避免真实等待；仅作用于本测试进程。
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0);

// ===== 测试开始 =====
console.log("═".repeat(60));
console.log("  🧪 单元测试 — 图片转3D 提供商（mock fetch）");
console.log("═".repeat(60));

describe("runMeshyImageTo3D 成功路径", async() => {
  installFetch(successResponder);
  clearProviderEnv();
  try {
    const out = await runMeshyImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64);
    assert(out && typeof out === "object", "返回对象");
    assert(Buffer.isBuffer(out.glbBuffer) || out.glbBuffer instanceof Uint8Array, "glbBuffer 为二进制");
    assert(out.glbBuffer.length > 0, "glbBuffer 非空");
    assertEqual(out.manifest.engine, "meshy", "manifest.engine = meshy");
  } catch (e) {
    assert(false, "不应抛出异常: " + e.message);
  } finally {
    restoreFetch();
  }
});

describe("runTripoImageTo3D 成功路径", async() => {
  installFetch(successResponder);
  clearProviderEnv();
  try {
    const out = await runTripoImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64);
    assert(out && typeof out === "object", "返回对象");
    assert(Buffer.isBuffer(out.glbBuffer) || out.glbBuffer instanceof Uint8Array, "glbBuffer 为二进制");
    assert(out.glbBuffer.length > 0, "glbBuffer 非空");
    assertEqual(out.manifest.engine, "tripo", "manifest.engine = tripo");
  } catch (e) {
    assert(false, "不应抛出异常: " + e.message);
  } finally {
    restoreFetch();
  }
});

describe("runHyper3DImageTo3D 成功路径", async() => {
  installFetch(successResponder);
  clearProviderEnv();
  try {
    const out = await runHyper3DImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64);
    assert(out && typeof out === "object", "返回对象");
    assert(Buffer.isBuffer(out.glbBuffer) || out.glbBuffer instanceof Uint8Array, "glbBuffer 为二进制");
    assert(out.glbBuffer.length > 0, "glbBuffer 非空");
    assertEqual(out.manifest.engine, "hyper3d", "manifest.engine = hyper3d");
  } catch (e) {
    assert(false, "不应抛出异常: " + e.message);
  } finally {
    restoreFetch();
  }
});

describe("runHyper3DTextTo3D 成功路径（文生3D）", async() => {
  installFetch(successResponder);
  clearProviderEnv();
  try {
    const out = await runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机");
    assert(out && typeof out === "object", "返回对象");
    assert(Buffer.isBuffer(out.glbBuffer) || out.glbBuffer instanceof Uint8Array, "glbBuffer 为二进制");
    assert(out.glbBuffer.length > 0, "glbBuffer 非空");
    assertEqual(out.manifest.engine, "hyper3d-text", "manifest.engine = hyper3d-text");
    assertEqual(out.manifest.prompt, "一架红色客机", "manifest.prompt 回显");
  } catch (e) {
    assert(false, "不应抛出异常: " + e.message);
  } finally {
    restoreFetch();
  }
});

describe("runHyper3DTextTo3D 空提示词抛出 status=400", async() => {
  clearProviderEnv();
  let threw = false;
  let err;
  try {
    await runHyper3DTextTo3D({ apiKey: "test-key" }, "   ");
  } catch (e) {
    threw = true;
    err = e;
  }
  assert(threw, "空提示词应抛出异常");
  if (threw) {
    assertEqual(err.status, 400, "空提示词错误 status = 400");
  }
  restoreFetch();
});

describe("缺失 API Key 抛出 status=400", async() => {
  clearProviderEnv();
  const cases = [
    ["runMeshyImageTo3D", "Meshy", "MESHY_API_KEY", runMeshyImageTo3D, [SAMPLE_BODY, SAMPLE_B64]],
    ["runTripoImageTo3D", "Tripo", "TRIPO_API_KEY", runTripoImageTo3D, [SAMPLE_BODY, SAMPLE_B64]],
    ["runHyper3DImageTo3D", "Hyper3D(Rodin)", "HYPER3D_API_KEY", runHyper3DImageTo3D, [SAMPLE_BODY, SAMPLE_B64]],
  ];
  for (const [name, label, envVar, fn, args] of cases) {
    delete process.env[envVar];
    let threw = false;
    let err;
    try {
      await fn({}, ...args);
    } catch (e) {
      threw = true;
      err = e;
    }
    assert(threw, `${name}(无 Key) 应抛出异常`);
    if (threw) {
      assertEqual(err.status, 400, `${name} 错误 status = 400`);
      assert((err.message || "").includes(label), `${name} 错误信息包含标识 "${label}"`);
    }
  }
  // runHyper3DTextTo3D 接受 (cfg, prompt) 签名，单独测
  delete process.env.HYPER3D_API_KEY;
  let threwText = false;
  let errText;
  try {
    await runHyper3DTextTo3D({}, "一架飞机");
  } catch (e) {
    threwText = true;
    errText = e;
  }
  assert(threwText, "runHyper3DTextTo3D(无 Key) 应抛出异常");
  if (threwText) {
    assertEqual(errText.status, 400, "runHyper3DTextTo3D 错误 status = 400");
    assert((errText.message || "").includes("Hyper3D(Rodin)"), "runHyper3DTextTo3D 错误信息包含标识");
  }
});

describe("任务失败状态正确上抛（Meshy FAILED）", async() => {
  installFetch((url) => {
    if (url === "https://api.meshy.ai/openapi/v1/image-to-3d")
      return jsonResponse({ result: "task-fail-1" });
    if (url === "https://api.meshy.ai/openapi/v1/image-to-3d/task-fail-1")
      return jsonResponse({ status: "FAILED", message: "bad image" });
    return jsonResponse({ error: "unexpected" }, 500);
  });
  clearProviderEnv();
  let threw = false;
  try {
    await runMeshyImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64);
  } catch (e) {
    threw = true;
  }
  assert(threw, "Meshy 返回 FAILED 时应抛出异常");
  restoreFetch();
});

// Hyper3D 轮询遇到 Failed 作业必须上抛——图生/文生共用同一逻辑。
// 这是重构前的表征测试（锁定现状行为），用于保护「消除 33 行逐字复制」不改变语义。
describe("Hyper3D 作业 Failed 时上抛（图生/文生共用逻辑，重构安全网）", async() => {
  installFetch((url) => {
    if (url === "https://hyperhuman.deemos.com/api/v2/rodin")
      return jsonResponse({ uuid: "u-fail", subscription_key: "sk-fail" });
    if (url === "https://hyperhuman.deemos.com/api/v2/status")
      return jsonResponse({ jobs: [{ status: "Done" }, { status: "Failed" }] });
    if (url === "https://hyperhuman.deemos.com/api/v2/download")
      return jsonResponse({ list: [{ name: "model.glb", url: "https://cdn/glb.h3d" }] });
    return jsonResponse({ error: "unexpected url: " + url }, 500);
  });
  clearProviderEnv();

  let imgErr = null;
  try {
    await runHyper3DImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64);
  } catch (e) {
    imgErr = e;
  }
  assertEqual(imgErr && imgErr.message, "Hyper3D 生成失败", "图生3D：作业 Failed 抛出既定信息");

  let textErr = null;
  try {
    await runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机");
  } catch (e) {
    textErr = e;
  }
  assertEqual(textErr && textErr.message, "Hyper3D 生成失败", "文生3D：作业 Failed 抛出同一信息");
  restoreFetch();
});

// ===== Hyper3D 建任务收尾（createHyper3DTask）接缝锁定 =====
// 图片 / 文本两条路线共用这段：POST rodin → 错误文案截断 400 →
// 两级回退取任务标识。以前只有“顶层字段的成功路径”在看守，
// data 下嵌套、标识缺失、错误截断三者均无用例，故补齐。
const H3D_CREATE_URL = "https://hyperhuman.deemos.com/api/v2/rodin";

describe("Hyper3D 建任务：表单默认值与请求头（图生/文生一致）", async() => {
  clearProviderEnv();
  const routes = [
    ["图生", () => runHyper3DImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64)],
    ["文生", () => runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机")],
  ];
  for (const [label, run] of routes) {
    let seen = null;
    installFetch((url, opts) => {
      if (url === H3D_CREATE_URL) {
        seen = { method: opts.method, headers: opts.headers || {}, form: opts.body };
        return jsonResponse({ uuid: "u-1", subscription_key: "sk-1" });
      }
      return successResponder(url);
    });
    let err = null;
    try {
      await run();
    } catch (e) {
      err = e;
    } finally {
      restoreFetch();
    }
    assert(!err, `${label}路线建任务不应抛异常: ${err && err.message}`);
    assert(seen !== null, `${label}路线确实 POST 到 rodin 端点`);
    if (!seen) continue;
    assertEqual(seen.headers.Authorization, "Bearer test-key", `${label}路线 Authorization 为 Bearer <apiKey>`);
    assertEqual(seen.method, "POST", `${label}路线使用 POST 提交表单`);
    assertEqual(seen.form && seen.form.get("tier"), "Sketch", `${label}路线表单 tier=Sketch`);
    assertEqual(seen.form && seen.form.get("mesh_mode"), "Raw", `${label}路线表单 mesh_mode=Raw`);
    assertEqual(seen.form && seen.form.get("texture_mode"), "high", `${label}路线表单 texture_mode=high`);
    if (label === "图生") {
      const img = seen.form && seen.form.get("images");
      assert(img && typeof img === "object", "图生路线携带 images 文件字段");
      assertEqual(img && img.name, "0000.png", "图生路线 images 文件名为 0000.png");
      assertEqual(img && img.type, "image/png", "图生路线 images MIME 与 data URI 一致");
      assertEqual(seen.form && seen.form.get("prompt"), null, "图生路线不带 prompt 字段");
    } else {
      assertEqual(seen.form && seen.form.get("prompt"), "一架红色客机", "文生路线携带 prompt 字段");
      assertEqual(seen.form && seen.form.get("images"), null, "文生路线不带 images 字段");
    }
  }
});

describe("Hyper3D 图生路线：images 的 MIME 与文件后缀随 data URI 推导", async() => {
  clearProviderEnv();
  const variants = [
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/webp", ".webp"],
    // data URI 里没有 MIME 时回落 png
    ["", ".png"],
  ];
  for (const [mime, wantExt] of variants) {
    const image = mime ? `data:${mime};base64,iVBORw0KGgo=` : "data:;base64,iVBORw0KGgo=";
    let img = null;
    installFetch((url, opts) => {
      if (url === H3D_CREATE_URL) {
        img = opts.body && opts.body.get("images");
        return jsonResponse({ uuid: "u-1", subscription_key: "sk-1" });
      }
      if (url.startsWith("https://cdn/")) return glbResponse();
      return successResponder(url);
    });
    let err = null;
    try {
      await runHyper3DImageTo3D({ apiKey: "test-key" }, { image }, SAMPLE_B64);
    } catch (e) {
      err = e;
    } finally {
      restoreFetch();
    }
    assert(!err, `MIME=${mime || "(空)"} 时建任务不应抛异常: ${err && err.message}`);
    assert(!!img, `MIME=${mime || "(空)"} 时仍带 images 字段`);
    assertEqual(img && img.name, `0000${wantExt}`, `MIME=${mime || "(空)"} 推导文件名`);
    assertEqual(img && img.type, mime || "image/png", `MIME=${mime || "(空)"} 推导 Blob MIME`);
  }
});

describe("Hyper3D 建任务：任务标识两级回退后确实注入轮询与下载请求", async() => {
  clearProviderEnv();
  const cases = [
    ["顶层字段", { uuid: "u-top", subscription_key: "sk-top" }, "u-top", "sk-top"],
    ["data 下嵌套", { data: { uuid: "u-nested", subscription_key: "sk-nested" } }, "u-nested", "sk-nested"],
    ["混搭（uuid 顶层 / key 嵌套）", { uuid: "u-mix", data: { subscription_key: "sk-mix" } }, "u-mix", "sk-mix"],
  ];
  for (const [label, payload, wantUuid, wantSubKey] of cases) {
    const seen = { status: [], download: [] };
    installFetch((url, opts) => {
      if (url === H3D_CREATE_URL) return jsonResponse(payload);
      if (url === "https://hyperhuman.deemos.com/api/v2/status") {
        seen.status.push(JSON.parse(opts.body));
        return jsonResponse({ jobs: [{ status: "Done" }] });
      }
      if (url === "https://hyperhuman.deemos.com/api/v2/download") {
        seen.download.push(JSON.parse(opts.body));
        return jsonResponse({ list: [{ name: "model.glb", url: "https://cdn/glb.h3d" }] });
      }
      if (url.startsWith("https://cdn/")) return glbResponse();
      return jsonResponse({ error: "unexpected url: " + url }, 500);
    });
    const routes = [
      ["图生", () => runHyper3DImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64)],
      ["文生", () => runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机")],
    ];
    for (const [route, run] of routes) {
      // 每个路线独立重装 fetch（上一轮的 restoreFetch 已经拆掉 mock）
      installFetch((url, opts) => {
        if (url === H3D_CREATE_URL) return jsonResponse(payload);
        if (url === "https://hyperhuman.deemos.com/api/v2/status") {
          seen.status.push(JSON.parse(opts.body));
          return jsonResponse({ jobs: [{ status: "Done" }] });
        }
        if (url === "https://hyperhuman.deemos.com/api/v2/download") {
          seen.download.push(JSON.parse(opts.body));
          return jsonResponse({ list: [{ name: "model.glb", url: "https://cdn/glb.h3d" }] });
        }
        if (url.startsWith("https://cdn/")) return glbResponse();
        return jsonResponse({ error: "unexpected url: " + url }, 500);
      });
      let err = null;
      try {
        await run();
      } catch (e) {
        err = e;
      } finally {
        restoreFetch();
      }
      const lastStatus = seen.status[seen.status.length - 1];
      const lastDownload = seen.download[seen.download.length - 1];
      assert(!err, `${label}/${route}：取到标识后应顺利走完轮询与下载: ${err && err.message}`);
      assertEqual(lastStatus && lastStatus.subscription_key, wantSubKey, `${label}/${route}：轮询请求携带 subscription_key`);
      assertEqual(lastDownload && lastDownload.task_uuid, wantUuid, `${label}/${route}：下载请求携带 task_uuid`);
    }
  }
});

describe("Hyper3D 建任务：缺任务标识时抛错并止步于建任务", async() => {
  clearProviderEnv();
  const badPayloads = [
    ["空对象", {}],
    ["只有 uuid", { uuid: "u-only" }],
    ["只有 subscription_key", { subscription_key: "sk-only" }],
    ["data 为空对象", { data: {} }],
  ];
  for (const [label, payload] of badPayloads) {
    let statusCalls = 0;
    installFetch((url) => {
      if (url === H3D_CREATE_URL) return jsonResponse(payload);
      statusCalls++;
      return successResponder(url);
    });
    let imgErr = null;
    let textErr = null;
    try {
      await runHyper3DImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64);
    } catch (e) {
      imgErr = e;
    }
    try {
      await runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机");
    } catch (e) {
      textErr = e;
    } finally {
      restoreFetch();
    }
    assertEqual(imgErr && imgErr.message, "Hyper3D 未返回任务标识 (uuid/subscription_key)", `${label}：图生路线抛出标识缺失错误`);
    assertEqual(textErr && textErr.message, "Hyper3D 未返回任务标识 (uuid/subscription_key)", `${label}：文生路线抛出同一错误`);
    assertEqual(statusCalls, 0, `${label}：两次调用均未进入轮询`);
  }
});

describe("Hyper3D 建任务失败：透传状态码与响应体（截断 400 字符）", async() => {
  clearProviderEnv();
  const longText = "E".repeat(900);
  const failRes = (status, text) => ({ ok: false, status, text: async() => text, json: async() => ({}) });
  const prefix = "Hyper3D 创建任务失败 503: ";
  const routes = [
    ["图生", () => runHyper3DImageTo3D({ apiKey: "test-key" }, SAMPLE_BODY, SAMPLE_B64)],
    ["文生", () => runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机")],
  ];
  for (const [label, run] of routes) {
    installFetch((url) => (url === H3D_CREATE_URL ? failRes(503, longText) : successResponder(url)));
    let err = null;
    try {
      await run();
    } catch (e) {
      err = e;
    } finally {
      restoreFetch();
    }
    assert(!!err && err.message.startsWith(prefix), `${label}：错误文案带状态码 503 与既定前缀`);
    assertEqual(err && err.message.length, prefix.length + 400, `${label}：响应体被截断到 400 字符`);
    assertEqual(err && err.message.slice(prefix.length), "E".repeat(400), `${label}：保留响应体前 400 字符`);
  }
  // 短响应体不应被截断（slice 上限只限长文件）
  installFetch((url) => (url === H3D_CREATE_URL ? failRes(429, "quota exceeded") : successResponder(url)));
  let shortErr = null;
  try {
    await runHyper3DTextTo3D({ apiKey: "test-key" }, "一架红色客机");
  } catch (e) {
    shortErr = e;
  } finally {
    restoreFetch();
  }
  assertEqual(shortErr && shortErr.message, "Hyper3D 创建任务失败 429: quota exceeded", "短响应体完整透传不被截断");
});

// ===== pollTask：供 server.js 内联 Replicate 轮询复用的共享轮询器 =====

describe("pollTask 导出与轮询契约（回归锁，保护 Replicate 轮询去重）", async() => {
  assert(
    typeof providerModule.pollTask === "function",
    "pollTask 已作为具名导出供 server.js 复用",
  );

  // 超时：deadline 已过 → 用 timeoutMsg 拒绝，且不得调用 checkStatus
  let statusCalled = 0;
  let timeoutErr = null;
  try {
    await providerModule.pollTask({
      deadline: Date.now() - 1,
      timeoutMsg: "任务超时（测试用）",
      intervalMs: 1,
      checkStatus: () => {
        statusCalled++;
        return { done: false };
      },
    });
  } catch (e) {
    timeoutErr = e;
  }
  assertEqual(timeoutErr && timeoutErr.message, "任务超时（测试用）", "超时抛出的错误信息为 timeoutMsg");
  assertEqual(statusCalled, 0, "超时先于 checkStatus 判定，未多余调用");

  // 完成：返回 modelUrl，供调用方直接下载
  let resolvedUrl = null;
  try {
    resolvedUrl = await providerModule.pollTask({
      deadline: Date.now() + 60_000,
      timeoutMsg: "不应超时",
      intervalMs: 1,
      checkStatus: () => ({ done: true, modelUrl: "https://cdn/glb.done" }),
    });
  } catch (e) {
    resolvedUrl = `threw: ${e.message}`;
  }
  assertEqual(resolvedUrl, "https://cdn/glb.done", "轮询完成时返回 modelUrl");
});

// ===== 顺序执行所有 describe（避免并发共享 fetch mock 竞态）=====
for (const { name, fn } of describeQueue) {
  console.log(`\n📋 ${name}`);
  await fn();
}

// ===== 结果汇总 =====
console.log("\n" + "═".repeat(60));
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed === 0) {
  console.log("  ✅ 全部测试通过！");
} else {
  console.log("  ❌ 有测试失败！");
  console.log("\n  失败项:");
  failures.forEach((f) => console.log(`    • ${f}`));
}
console.log("═".repeat(60));

process.exit(failed > 0 ? 1 : 0);
