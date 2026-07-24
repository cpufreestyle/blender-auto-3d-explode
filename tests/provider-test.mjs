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
} from "../src/providers/image-to-3d.js";

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
    text: async () => text,
    json: async () => obj,
    arrayBuffer: async () => new Uint8Array(Buffer.from(text)).buffer,
  };
}

function glbResponse(status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => "glb-bytes",
    json: async () => ({}),
    arrayBuffer: async () => new Uint8Array(GLB_BYTES).buffer,
  };
}

// 安装一个根据 URL 返回响应的 fetch 实现
function installFetch(responder) {
  globalThis.fetch = async (url, opts) => responder(url, opts || {});
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

describe("runMeshyImageTo3D 成功路径", async () => {
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

describe("runTripoImageTo3D 成功路径", async () => {
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

describe("runHyper3DImageTo3D 成功路径", async () => {
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

describe("缺失 API Key 抛出 status=400", async () => {
  clearProviderEnv();
  const cases = [
    ["runMeshyImageTo3D", "Meshy", "MESHY_API_KEY", runMeshyImageTo3D],
    ["runTripoImageTo3D", "Tripo", "TRIPO_API_KEY", runTripoImageTo3D],
    ["runHyper3DImageTo3D", "Hyper3D(Rodin)", "HYPER3D_API_KEY", runHyper3DImageTo3D],
  ];
  for (const [name, label, envVar, fn] of cases) {
    delete process.env[envVar];
    let threw = false;
    let err;
    try {
      await fn({}, SAMPLE_BODY, SAMPLE_B64);
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
});

describe("任务失败状态正确上抛（Meshy FAILED）", async () => {
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
