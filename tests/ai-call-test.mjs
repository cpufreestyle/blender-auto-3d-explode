#!/usr/bin/env node
/**
 * 单元测试 — AI 调用层（src/ai-call.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - callAI 按 AI_CONFIG.provider 分派：openai/lmstudio/stepfun/nvidia/kimi
 *     走 OpenAI 兼容接口，anthropic/ollama 各走原生接口，未知 provider 抛错；
 *   - 各家的 url 来源：openai/stepfun/kimi 写死，lmstudio 与 nvidia 取自配置
 *     （nvidia 的 base_url 缺省回 integrate.api.nvidia.com/v1）；
 *   - callOpenAICompatible：空 key 且 label 不是 LM Studio 时报「未配置」；
 *     LM Studio 允许空 key（本地不鉴权）且不带 Authorization 头；
 *     有 systemPrompt 时消息多一条 system；model 缺省时序列化为 undefined；
 *     temperature 0.7 / max_tokens 4096；非 2xx 取 data.error?.message，
 *     缺失时回落「{label} API 错误」；成功取 choices[0].message.content；
 *   - callAnthropic：空 key 报错；x-api-key + anthropic-version: 2023-06-01；
 *     max_tokens 1024；错误回落「Anthropic API 错误」；成功取 content[0].text；
 *   - callOllama：打 {url}/api/generate，stream:false；错误回落「Ollama 错误」；
 *     成功取 data.response。
 *
 * 说明：AI_CONFIG 是 src/ai-config.js 的 live binding，而 loadAIConfig 是
 * 「与当前值合并」而非重置，故每个用例先写一份干净基线（各 key 置空、各
 * provider 用默认 model）再叠加用例状态，否则上一个用例的 key 会残留。
 * providers 是浅合并（写 providers.x 会冲掉默认 model），这是既有行为。
 *
 * 用法：node tests/ai-call-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS } from "../src/provider-models.js";
import { callAI, callOpenAICompatible, callAnthropic, callOllama } from "../src/ai-call.js";
import { loadAIConfig, setConfigFilePath } from "../src/ai-config.js";

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
async function it(_name, fn) {
  await fn();
}

// ===== 夹具：临时配置文件 + fetch 打桩 =====
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_CONFIG = path.join(ROOT, "ai-config.json");

// 干净基线：所有 key 置空，各 provider 保留缺省 model（不清 model，
// 以便单独验证「model 缺省回落」的用例自行置空）
const CLEAN_STATE = {
  provider: "openai",
  openai: { key: "" },
  anthropic: { key: "" },
  ollama: { url: "http://localhost:11434" },
  lmstudio: { key: "" },
  stepfun: { key: "" },
  nvidia: { key: "" },
  kimi: { key: "" },
};

let tmpDir = "";
let cfgPath = "";
const fetchCalls = [];
let fetchHandler = async() => {
  throw new Error("fetch 未打桩");
};

function writeCfg(obj) {
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
}

function reset(state = {}) {
  fetchCalls.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-call-test-"));
  cfgPath = path.join(tmpDir, "ai-config.json");
  setConfigFilePath(cfgPath);
  writeCfg({ ...CLEAN_STATE, ...state });
  loadAIConfig();
}

function okJSON(data) {
  return async() => ({ ok: true, json: async() => data });
}

function errJSON(data, status = 400) {
  return async() => ({ ok: false, status, json: async() => data });
}

function stub(handler) {
  fetchHandler = handler;
}

function lastCall() {
  return fetchCalls[fetchCalls.length - 1];
}

function lastBody() {
  return JSON.parse(lastCall().opts.body);
}

Object.defineProperty(globalThis, "fetch", {
  get: () => (url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || {} });
    return fetchHandler(String(url), opts || {});
  },
  configurable: true,
});

describe("callAI 分派", async() => {
  await it("openai → OpenAI 兼容端点", async() => {
    reset({ provider: "openai", openai: { key: "sk-o", model: "gpt-x" } });
    stub(okJSON({ choices: [{ message: { content: "hi" } }] }));
    assert((await callAI("p")) === "hi", "返回值取 choices[0].message.content");
    assert(
      lastCall().url === "https://api.openai.com/v1/chat/completions",
      `url 正确（${lastCall().url}）`,
    );
    assert(lastCall().opts.headers.Authorization === "Bearer sk-o", "Authorization: Bearer <key>");
  });

  await it("stepfun / kimi 各自写死 url", async() => {
    reset({ provider: "stepfun", stepfun: { key: "sk-s" } });
    stub(okJSON({ choices: [{ message: { content: "s" } }] }));
    await callAI("p");
    assert(lastCall().url === "https://api.stepfun.com/v1/chat/completions", "stepfun url");

    reset({ provider: "kimi", kimi: { key: "sk-k" } });
    await callAI("p");
    assert(lastCall().url === "https://api.moonshot.cn/v1/chat/completions", "kimi url");
  });

  await it("lmstudio 用配置里的 url", async() => {
    reset({ provider: "lmstudio", lmstudio: { url: "http://192.168.1.9:1234/v1" } });
    stub(okJSON({ choices: [{ message: { content: "l" } }] }));
    await callAI("p");
    assert(
      lastCall().url === "http://192.168.1.9:1234/v1/chat/completions",
      `lmstudio url 取自配置（${lastCall().url}）`,
    );
  });

  await it("nvidia 用 base_url 且带 systemPrompt", async() => {
    reset({ provider: "nvidia", nvidia: { key: "sk-n", base_url: "https://nv.example/v1" } });
    stub(okJSON({ choices: [{ message: { content: "n" } }] }));
    await callAI("p");
    assert(lastCall().url === "https://nv.example/v1/chat/completions", "nvidia 用 base_url");
    const body = lastBody();
    assert(body.messages[0].role === "system", "systemPrompt 落在 messages[0]");
    assert(body.messages[1].role === "user", "user prompt 落在 messages[1]");
    assert(body.messages[1].content === "p", "user 内容是原样 prompt");
    assert(
      body.messages[0].content.includes("乐高积木模型专家"),
      "systemPrompt 文案未变",
    );
  });

  await it("nvidia base_url 缺省回官方地址", async() => {
    reset({ provider: "nvidia", nvidia: { key: "sk-n", base_url: "" } });
    stub(okJSON({ choices: [{ message: { content: "n" } }] }));
    await callAI("p");
    assert(
      lastCall().url === "https://integrate.api.nvidia.com/v1/chat/completions",
      "base_url 为空时回落官方地址",
    );
  });

  await it("anthropic → Messages 接口", async() => {
    reset({ provider: "anthropic", anthropic: { key: "sk-a" } });
    stub(okJSON({ content: [{ text: "a" }] }));
    assert((await callAI("p")) === "a", "返回值取 content[0].text");
    assert(lastCall().url === "https://api.anthropic.com/v1/messages", "anthropic url");
    assert(lastCall().opts.headers["x-api-key"] === "sk-a", "x-api-key");
    assert(lastCall().opts.headers["anthropic-version"] === "2023-06-01", "anthropic-version");
  });

  await it("ollama → /api/generate", async() => {
    reset({ provider: "ollama", ollama: { url: "http://localhost:11434" } });
    stub(okJSON({ response: "o" }));
    assert((await callAI("p")) === "o", "返回值取 data.response");
    assert(lastCall().url === "http://localhost:11434/api/generate", "ollama url");
  });

  await it("未知 provider 抛错", async() => {
    reset({ provider: "meshy" });
    stub(okJSON({}));
    let msg = "";
    try {
      await callAI("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "未知的 AI 提供商: meshy", `错误文案（${msg}）`);
    assert(fetchCalls.length === 0, "未发起任何请求就抛错");
  });
});

describe("callOpenAICompatible", async() => {
  await it("空 key 且非 LM Studio 时报未配置", async() => {
    reset({ provider: "openai", openai: { key: "" } });
    stub(okJSON({}));
    let msg = "";
    try {
      await callAI("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "OpenAI API Key 未配置", `错误文案（${msg}）`);
    assert(fetchCalls.length === 0, "未发请求");
  });

  await it("LM Studio 允许空 key 且不带 Authorization", async() => {
    reset({ provider: "lmstudio", lmstudio: { url: "http://127.0.0.1:1234/v1", key: "" } });
    stub(okJSON({ choices: [{ message: { content: "l" } }] }));
    await callAI("p");
    assert(
      lastCall().opts.headers.Authorization === undefined,
      "空 key 时不注入 Authorization 头",
    );
    assert(lastCall().opts.headers["Content-Type"] === "application/json", "Content-Type 仍在");
  });

  await it("无 systemPrompt 时消息只有 user", async() => {
    reset({ provider: "openai", openai: { key: "sk-o" } });
    stub(okJSON({ choices: [{ message: { content: "x" } }] }));
    await callAI("hello");
    const body = lastBody();
    assert(body.messages.length === 1, "只有一条消息");
    assert(body.messages[0].role === "user" && body.messages[0].content === "hello", "user 消息原样");
  });

  await it("请求体固定字段", async() => {
    reset({ provider: "openai", openai: { key: "sk-o", model: "gpt-x" } });
    stub(okJSON({ choices: [{ message: { content: "x" } }] }));
    await callAI("hello");
    const body = lastBody();
    assert(body.model === "gpt-x", "model 透传");
    assert(body.temperature === 0.7, "temperature 0.7");
    assert(body.max_tokens === 4096, "max_tokens 4096");
    assert(lastCall().opts.method === "POST", "POST 方法");
  });

  await it("model 缺省时序列化为 undefined（键消失）", async() => {
    reset({ provider: "openai", openai: { key: "sk-o", model: "" } });
    stub(okJSON({ choices: [{ message: { content: "x" } }] }));
    await callAI("hello");
    assert(!("model" in lastBody()), "model 键被省略");
  });

  await it("非 2xx：优先用 data.error.message", async() => {
    reset({ provider: "openai", openai: { key: "sk-o" } });
    stub(errJSON({ error: { message: "额度不足" } }));
    let msg = "";
    try {
      await callAI("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "额度不足", `错误文案（${msg}）`);
  });

  await it("非 2xx：缺失 error.message 时回落 label 文案", async() => {
    reset({ provider: "stepfun", stepfun: { key: "sk-s" } });
    stub(errJSON({ error: {} }));
    let msg = "";
    try {
      await callAI("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "StepFun API 错误", `错误文案（${msg}）`);
  });

  await it("非 2xx：连 error 字段都没有时同样回落", async() => {
    reset({ provider: "openai", openai: { key: "sk-o" } });
    stub(errJSON({}));
    let msg = "";
    try {
      await callAI("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "OpenAI API 错误", `错误文案（${msg}）`);
  });

  await it("可直接以参数调用（导出面）", async() => {
    reset({});
    stub(okJSON({ choices: [{ message: { content: "direct" } }] }));
    const r = await callOpenAICompatible("q", {
      cfg: { key: "k", model: "m" },
      url: "https://direct.example/v1",
      label: "Direct",
    });
    assert(r === "direct", "返回值正确");
    assert(lastCall().url === "https://direct.example/v1/chat/completions", "url 由参数拼出");
    const body = lastBody();
    assert(body.messages.length === 1, "无 systemPrompt 时只有 user 消息");
  });
});

describe("callAnthropic", async() => {
  await it("空 key 报错", async() => {
    reset({ provider: "anthropic", anthropic: { key: "" } });
    stub(okJSON({}));
    let msg = "";
    try {
      await callAnthropic("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "Anthropic API Key 未配置", `错误文案（${msg}）`);
    assert(fetchCalls.length === 0, "未发请求");
  });

  await it("请求体字段", async() => {
    reset({ provider: "anthropic", anthropic: { key: "sk-a", model: "claude-x" } });
    stub(okJSON({ content: [{ text: "a" }] }));
    await callAnthropic("hello");
    const body = lastBody();
    assert(body.model === "claude-x", "model 透传");
    assert(body.max_tokens === 1024, "max_tokens 1024");
    assert(body.messages.length === 1 && body.messages[0].content === "hello", "只有 user 消息");
    assert(lastCall().opts.method === "POST", "POST 方法");
  });

  await it("model 缺省回落 DEFAULT_MODELS.anthropic", async() => {
    reset({ provider: "anthropic", anthropic: { key: "sk-a", model: "" } });
    stub(okJSON({ content: [{ text: "a" }] }));
    await callAnthropic("hello");
    assert(lastBody().model === DEFAULT_MODELS.anthropic, `回落 ${DEFAULT_MODELS.anthropic}`);
  });

  await it("非 2xx 错误文案两分支", async() => {
    reset({ provider: "anthropic", anthropic: { key: "sk-a" } });
    stub(errJSON({ error: { message: "过载" } }));
    let msg = "";
    try {
      await callAnthropic("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "过载", `优先用 error.message（${msg}）`);

    reset({ provider: "anthropic", anthropic: { key: "sk-a" } });
    stub(errJSON({}));
    msg = "";
    try {
      await callAnthropic("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "Anthropic API 错误", `回落文案（${msg}）`);
  });
});

describe("callOllama", async() => {
  await it("请求体字段与 url 拼接", async() => {
    reset({ provider: "ollama", ollama: { url: "http://localhost:11434", model: "llama3" } });
    stub(okJSON({ response: "o" }));
    assert((await callOllama("hello")) === "o", "返回 data.response");
    assert(lastCall().url === "http://localhost:11434/api/generate", "url 拼接");
    const body = lastBody();
    assert(body.model === "llama3", "model 透传");
    assert(body.prompt === "hello", "prompt 原样");
    assert(body.stream === false, "stream:false");
    assert(
      lastCall().opts.headers["Content-Type"] === "application/json",
      "Content-Type",
    );
  });

  await it("model 缺省回落 DEFAULT_MODELS.ollama", async() => {
    reset({ provider: "ollama", ollama: { url: "http://localhost:11434", model: "" } });
    stub(okJSON({ response: "o" }));
    await callOllama("hello");
    assert(lastBody().model === DEFAULT_MODELS.ollama, `回落 ${DEFAULT_MODELS.ollama}`);
  });

  await it("非 2xx：data.error 优先，否则回落 Ollama 错误", async() => {
    reset({ provider: "ollama" });
    stub(errJSON({ error: "模型不存在" }));
    let msg = "";
    try {
      await callOllama("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "模型不存在", `优先用 data.error（${msg}）`);

    reset({ provider: "ollama" });
    stub(errJSON({}));
    msg = "";
    try {
      await callOllama("p");
    } catch (e) {
      msg = e.message;
    }
    assert(msg === "Ollama 错误", `回落文案（${msg}）`);
  });
});

// ===== 运行 =====
function restoreRealConfig() {
  // 用例期间把默认路径指向了临时文件，跑完还回去并重新加载仓库根配置
  setConfigFilePath(REAL_CONFIG);
  loadAIConfig();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async() => {
  try {
    for (const item of describeQueue) {
      console.log(`\n── ${item.name}`);
      await item.fn();
    }
  } finally {
    restoreRealConfig();
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
