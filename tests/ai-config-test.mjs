#!/usr/bin/env node
/**
 * 单元测试 — AI 配置存储与配置路由（src/ai-config.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - loadAIConfig：与默认值深合并（缺字段不崩），provider 顶层可覆盖，
 *     文件缺失保持默认，坏 JSON 被 catch 不抛错；
 *   - autoDetectProvider：当前 provider 可用（ollama/lmstudio 或已配 Key）
 *     则不探测；否则依次探 ollama /api/tags 与 lmstudio /v1/models，
 *     命中即用，全失败保持原值；
 *   - handleAIConfigGet：API Key 一律脱敏 '***'（无 key 给 ''），
 *     saved/replicate 投影/providers 脱敏/vlm/openInBlender/semanticLabel；
 *   - handleAIConfigPost：'***' 或空 key 视为未修改、保留旧值；
 *     新值覆盖并写盘（2 空格 JSON）；readBody 失败回 400；
 *   - handleAITest：callAI 拿 prompt（缺省 'Hello'），200 透传结果，
 *     抛错回 500；
 *   - probeAuth：401/403 → invalid、2xx → valid、其它 → uncertain、
 *     网络错（AbortError 报「超时」）→ uncertain；
 *   - PROVIDER_PROBES：meshy/tripo GET + Bearer，hyper3d POST +
 *     subscription_key 占位 body；
 *   - handleProviderTest：未知 provider 400、空 key 400、结果透传 200、
 *     probe 抛错 500 uncertain。
 *
 * 用法：node tests/ai-config-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODELS } from "../src/provider-models.js";
import {
  AI_CONFIG,
  loadAIConfig,
  autoDetectProvider,
  createAIConfigHandlers,
  setConfigFilePath,
} from "../src/ai-config.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
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

// ===== 夹具：临时配置文件 + fetch 打桩 =====
let tmpDir = "";
let cfgPath = "";
const fetchCalls = [];
let fetchHandler = async() => {
  throw new Error("fetch 未打桩");
};

function writeCfg(obj) {
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
}

// loadAIConfig 是「与默认值深合并」而非重置：每个用例先写一份干净基线
// （空 key / 默认 provider）再叠加用例状态，避免上个用例的 key 残留
// 让 autoDetectProvider 误判「当前 provider 可用」而不探测。
const CLEAN_STATE = {
  provider: "openai",
  openai: { key: "" },
  anthropic: { key: "" },
  stepfun: { key: "" },
  nvidia: { key: "" },
  kimi: { key: "" },
  replicate: { token: "" },
};

function reset(state = {}) {
  fetchCalls.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-config-test-"));
  cfgPath = path.join(tmpDir, "ai-config.json");
  setConfigFilePath(cfgPath);
  writeCfg({ ...CLEAN_STATE, ...state });
  loadAIConfig();
}

function stubFetch(handler) {
  fetchHandler = handler;
}

// POST handler 的 readBody().then() 链在微任务里完成，断言前先冲刷
async function flush() {
  await new Promise(r => setTimeout(r, 0));
}
Object.defineProperty(globalThis, "fetch", {
  get: () => (url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || {} });
    return fetchHandler(String(url), opts || {});
  },
  configurable: true,
});

// sendJSON / readBody / callAI 捕获
function makeDeps(opts = {}) {
  const sent = [];
  const calls = [];
  return {
    sent,
    calls,
    deps: {
      readBody: async() => {
        if (opts.bodyError) throw new Error("body 坏了");
        return opts.body || {};
      },
      sendJSON: (res, status, data) => sent.push({ status, data }),
      callAI: async prompt => {
        calls.push({ name: "callAI", prompt });
        if (opts.callAIError) throw new Error("AI 炸了");
        return `echo:${prompt}`;
      },
    },
  };
}

describe("loadAIConfig 深合并", async() => {
  await it("部分配置合并：新值生效、其余字段留默认、顶层新键带入", async() => {
    reset({ openai: { key: "sk-x" }, extraTop: "keep" });
    assert(AI_CONFIG.openai.key === "sk-x", "openai.key 取文件值");
    assert(AI_CONFIG.openai.model === DEFAULT_MODELS.openai, "openai.model 留默认");
    assert(AI_CONFIG.anthropic.key === "", "未配置的 anthropic.key 留默认空串");
    assert(AI_CONFIG.providers.meshy.apiKey === "", "providers.meshy 默认未丢");
    assert(AI_CONFIG.extraTop === "keep", "顶层新键随 spread 带入");
    assert(AI_CONFIG.replicate.mcResolution === 256, "replicate 嵌套默认未丢");
  });

  await it("provider 顶层覆盖", async() => {
    reset({ provider: "ollama" });
    assert(AI_CONFIG.provider === "ollama", "provider 被覆盖");
  });

  await it("文件缺失：全默认", async() => {
    reset({});
    fs.rmSync(cfgPath);
    loadAIConfig();
    assert(AI_CONFIG.provider === "openai", "provider 回落默认 openai");
    assert(AI_CONFIG.openai.key === "", "key 为空");
  });

  await it("坏 JSON：catch 不抛错、保持默认", async() => {
    reset({});
    fs.writeFileSync(cfgPath, "{ 这不是 JSON");
    let threw = null;
    try {
      loadAIConfig();
    } catch (err) {
      threw = err;
    }
    assert(threw === null, "不向上抛");
    assert(AI_CONFIG.provider === "openai", "保持默认");
  });
});

describe("autoDetectProvider 首次探测", async() => {
  await it("当前已配 Key：不探测", async() => {
    reset({ provider: "openai", openai: { key: "sk-ok" } });
    await autoDetectProvider();
    assert(fetchCalls.length === 0, "未发起探测");
    assert(AI_CONFIG.provider === "openai", "provider 不变");
  });

  await it("无可用 key：命中 ollama", async() => {
    reset({ provider: "openai" });
    stubFetch(async() => ({ ok: true, status: 200 }));
    await autoDetectProvider();
    assert(fetchCalls[0].url === "http://localhost:11434/api/tags", "先探 ollama /api/tags");
    assert(AI_CONFIG.provider === "ollama", "自动选用 ollama");
  });

  await it("ollama 失败：回落 lmstudio", async() => {
    reset({ provider: "openai" });
    stubFetch(async url => (url.includes("11434") ? { ok: false, status: 500 } : { ok: true, status: 200 }));
    await autoDetectProvider();
    assert(fetchCalls.length === 2, "两次探测");
    assert(fetchCalls[1].url === "http://localhost:1234/v1", "再探 lmstudio（用配置 url 原样，不拼路径）");
    assert(AI_CONFIG.provider === "lmstudio", "自动选用 lmstudio");
  });

  await it("全失败：保持原 provider", async() => {
    reset({ provider: "openai" });
    stubFetch(async() => {
      throw new Error("ECONNREFUSED");
    });
    await autoDetectProvider();
    assert(AI_CONFIG.provider === "openai", "保持 openai");
  });
});

describe("handleAIConfigGet", async() => {
  await it("脱敏投影", async() => {
    reset({
      openai: { key: "sk-a" },
      stepfun: { key: "sk-s" },
      replicate: { token: "tk" },
      providers: { meshy: { apiKey: "mk" }, tripo: { apiKey: "tk2" }, hyper3d: { apiKey: "hk" } },
    });
    const { deps, sent } = makeDeps();
    const { handleAIConfigGet } = createAIConfigHandlers(deps);
    handleAIConfigGet({}, {});
    const c = sent[0].data;
    assert(sent[0].status === 200, "200");
    assert(c.openai.key === "***" && c.stepfun.key === "***", "key 脱敏 ***");
    assert(c.replicate.token === "***", "replicate token 脱敏");
    assert(c.replicate.mode === "local" && c.replicate.mcResolution === 256, "replicate 参数投影");
    assert(c.providers.meshy.apiKey === "***", "providers key 脱敏");
    assert(c.openInBlender === false && c.semanticLabel === false, "布尔开关投影");
    assert(c.saved === true, "saved 指向存在的配置文件");
    assert(c.vlm === undefined, "未配 vlm 时为 undefined");
  });

  await it("无 key 给空串、无 token 给空串", async() => {
    reset({});
    const { deps, sent } = makeDeps();
    createAIConfigHandlers(deps).handleAIConfigGet({}, {});
    assert(sent[0].data.openai.key === "", "无 key → ''");
    assert(sent[0].data.replicate.token === "", "无 token → ''");
    assert(sent[0].data.replicateConfigured === false, "无 token → replicateConfigured false");
  });

  await it("配置文件不存在：saved 为 false", async() => {
    reset({});
    fs.rmSync(cfgPath);
    const { deps, sent } = makeDeps();
    createAIConfigHandlers(deps).handleAIConfigGet({}, {});
    assert(sent[0].data.saved === false, "saved 随文件存在性");
  });
});

describe("handleAIConfigPost", async() => {
  await it("'***' 与空 key 保留旧值并写盘", async() => {
    reset({ openai: { key: "sk-old" }, providers: { meshy: { apiKey: "mk-old" } } });
    const { deps, sent } = makeDeps({
      body: { openai: { key: "***" }, stepfun: {}, providers: { meshy: {}, tripo: { apiKey: "tp-new" } } },
    });
    createAIConfigHandlers(deps).handleAIConfigPost({}, {});
    await flush();
    const written = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert(sent[0].status === 200 && sent[0].data.success === true, "200 success");
    assert(written.openai.key === "sk-old", "openai '***' 保留旧 key");
    assert(written.providers.meshy.apiKey === "mk-old", "providers '***' 保留旧 key");
    assert(written.providers.tripo.apiKey === "tp-new", "新 key 生效");
    const raw = fs.readFileSync(cfgPath, "utf-8");
    assert(raw.includes("\n  \"openai\""), "写盘为 2 空格缩进 JSON");
  });

  await it("readBody 失败回 400", async() => {
    reset({});
    const { deps, sent } = makeDeps({ bodyError: true });
    createAIConfigHandlers(deps).handleAIConfigPost({}, {});
    await flush();
    assert(sent[0].status === 400 && sent[0].data.success === false, "400 + success false");
    assert(sent[0].data.error === "body 坏了", "error 透传 message");
  });
});

describe("handleAITest", async() => {
  await it("callAI 透传结果", async() => {
    reset({});
    const { deps, sent } = makeDeps({ body: { prompt: "你好" } });
    await createAIConfigHandlers(deps).handleAITest({}, {});
    assert(sent[0].status === 200 && sent[0].data.result === "echo:你好", "200 + 结果透传");
  });

  await it("prompt 缺省 Hello", async() => {
    reset({});
    const { deps, calls } = makeDeps({ body: {} });
    await createAIConfigHandlers(deps).handleAITest({}, {});
    assert(calls[0].prompt === "Hello", "body 无 prompt 时传 Hello");
  });

  await it("callAI 抛错回 500", async() => {
    reset({});
    const { deps, sent } = makeDeps({ callAIError: true });
    await createAIConfigHandlers(deps).handleAITest({}, {});
    assert(sent[0].status === 500 && sent[0].data.error === "AI 炸了", "500 + error");
  });
});

describe("probeAuth / PROVIDER_PROBES / handleProviderTest", async() => {
  await it("401/403 → invalid（含 HTTP 码）", async() => {
    reset({});
    const { deps, sent } = makeDeps({ body: { provider: "tripo", apiKey: "k" } });
    const { handleProviderTest } = createAIConfigHandlers(deps);
    stubFetch(async() => ({ ok: false, status: 403 }));
    await handleProviderTest({}, {});
    assert(sent[0].status === 200, "handler 层 200");
    assert(sent[0].data.status === "invalid", "403 → invalid");
    assert(sent[0].data.httpStatus === 403, "httpStatus 透传 403");
    assert(sent[0].data.message === "API Key 无效（HTTP 403）", "文案含 HTTP 码");
  });

  await it("200 → valid、500 → uncertain、网络错 → uncertain 超时", async() => {
    reset({});
    const { deps, sent } = makeDeps({ body: { provider: "meshy", apiKey: "k" } });
    const { handleProviderTest } = createAIConfigHandlers(deps);
    stubFetch(async() => ({ ok: true, status: 200 }));
    await handleProviderTest({}, {});
    assert(sent[0].status === 200 && sent[0].data.status === "valid", "200 → valid");
    assert(fetchCalls[0].url === "https://api.meshy.ai/openapi/v1/image-to-3d", "meshy 探该 URL");
    assert(
      fetchCalls[0].opts.headers.Authorization === "Bearer k",
      "Authorization: Bearer <key>",
    );
    stubFetch(async() => ({ ok: false, status: 500 }));
    await handleProviderTest({}, {});
    assert(sent[1].data.status === "uncertain" && sent[1].data.httpStatus === 500, "500 → uncertain");
    const ab = new Error("aborted");
    ab.name = "AbortError";
    stubFetch(async() => {
      throw ab;
    });
    await handleProviderTest({}, {});
    assert(sent[2].data.status === "uncertain" && sent[2].data.message.includes("超时"), "AbortError → 超时");
  });

  await it("hyper3d POST + subscription_key 占位 body", async() => {
    reset({});
    const { deps, sent } = makeDeps({ body: { provider: "hyper3d", apiKey: "hk" } });
    const { handleProviderTest } = createAIConfigHandlers(deps);
    stubFetch(async() => ({ ok: true, status: 200 }));
    await handleProviderTest({}, {});
    assert(fetchCalls[0].opts.method === "POST", "POST");
    assert(fetchCalls[0].url === "https://hyperhuman.deemos.com/api/v2/status", "hyper3d URL");
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert(body.subscription_key === "00000000-0000-0000-0000-000000000000", "占位 subscription_key");
    assert(sent[0].data.status === "valid", "结果透传");
  });

  await it("未知 provider / 空 key 均 400 invalid", async() => {
    reset({});
    const { deps, sent } = makeDeps({ body: { provider: "nope", apiKey: "k" } });
    const { handleProviderTest } = createAIConfigHandlers(deps);
    await handleProviderTest({}, {});
    assert(sent[0].status === 400 && sent[0].data.message === "未知提供商: nope", "未知提供商 400");
    const w2 = makeDeps({ body: { provider: "meshy", apiKey: "  " } });
    await createAIConfigHandlers(w2.deps).handleProviderTest({}, {});
    assert(w2.sent[0].status === 400 && w2.sent[0].data.message === "API Key 为空", "空 key 400");
  });

  await it("probe 网络错 → uncertain 透传；readBody 炸 → 500", async() => {
    reset({});
    stubFetch(async() => {
      throw new Error("dns fail");
    });
    const { deps, sent } = makeDeps({ body: { provider: "tripo", apiKey: "k" } });
    await createAIConfigHandlers(deps).handleProviderTest({}, {});
    assert(sent[0].status === 200 && sent[0].data.status === "uncertain", "probeAuth 吞错 → uncertain 透传");
    assert(sent[0].data.message.includes("dns fail"), "文案含错误 message");
    assert(fetchCalls[0].url === "https://openapi.tripo3d.ai/v3/tasks", "tripo URL");
    const w2 = makeDeps({ bodyError: true });
    await createAIConfigHandlers(w2.deps).handleProviderTest({}, {});
    assert(w2.sent[0].status === 500 && w2.sent[0].data.message === "body 坏了", "readBody 炸 → 500 uncertain");
  });
});

// ===== 运行 =====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
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
