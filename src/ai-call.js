// AI 调用层（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的四层 AI 调度：callAI 按当前 provider 分派；
// callOpenAICompatible 覆盖共享 /chat/completions 接口的六家（openai /
// lmstudio / stepfun / nvidia / kimi / meshy 之外的 OpenAI 兼容端点）；
// callAnthropic 与 callOllama 各自走原生接口格式。
//
// 接缝：AI_CONFIG 从 ./ai-config.js 引入（ESM live binding），读到的一直是
// 最新值——/api/ai-config POST 保存后整体换新对象，下一次调用即生效，语义
// 与原先在 server.js 内闭包读取同一个 let 完全一致。DEFAULT_MODELS 同样沿用
// src/provider-models.js 单一来源。fetch 走全局，无需注入。
import { AI_CONFIG } from "./ai-config.js";
import { DEFAULT_MODELS } from "./provider-models.js";

/**
 * 调用 AI 模型 — 统一路由
 */
export async function callAI(prompt) {
  const { provider } = AI_CONFIG;

  // OpenAI 兼容的提供商（共享 /chat/completions 接口）
  const OPENAI_COMPATIBLE = {
    openai: { cfg: AI_CONFIG.openai, url: 'https://api.openai.com/v1', label: 'OpenAI' },
    lmstudio: { cfg: AI_CONFIG.lmstudio, url: AI_CONFIG.lmstudio.url, label: 'LM Studio' },
    stepfun: { cfg: AI_CONFIG.stepfun, url: 'https://api.stepfun.com/v1', label: 'StepFun' },
    nvidia: {
      cfg: AI_CONFIG.nvidia,
      url: AI_CONFIG.nvidia.base_url || 'https://integrate.api.nvidia.com/v1',
      label: 'NVIDIA',
      systemPrompt: '你是一个乐高积木模型专家。根据用户的描述，用标准的乐高砖块拼接出模型。返回 JSON 格式：{ "bricks": [{ "name": "名称", "type": "2x4|2x2|1x2", "position": [x,y,z], "rotation": 0|90|180|270, "color": "red|blue|green" }] }',
    },
    kimi: {
      cfg: AI_CONFIG.kimi,
      url: 'https://api.moonshot.cn/v1',
      label: 'Kimi',
    },
  };

  const compat = OPENAI_COMPATIBLE[provider];
  if (compat) return await callOpenAICompatible(prompt, compat);

  switch (provider) {
    case 'anthropic':
      return await callAnthropic(prompt);
    case 'ollama':
      return await callOllama(prompt);
    default:
      throw new Error('未知的 AI 提供商: ' + provider);
  }
}

/**
 * 调用 OpenAI 兼容接口（OpenAI / LM Studio / StepFun / NVIDIA 共用）
 */
export async function callOpenAICompatible(prompt, { cfg, url, label, systemPrompt }) {
  const { key, model } = cfg;
  if (key === '' && label !== 'LM Studio') throw new Error(`${label} API Key 未配置`);

  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  const response = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: model || undefined, messages, temperature: 0.7, max_tokens: 4096 }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `${label} API 错误`);
  return data.choices[0].message.content;
}

/**
 * 调用 Anthropic Claude（独立接口格式）
 */
export async function callAnthropic(prompt) {
  const { key, model } = AI_CONFIG.anthropic;
  if (!key) throw new Error('Anthropic API Key 未配置');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.anthropic,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Anthropic API 错误');
  return data.content[0].text;
}

/**
 * 调用 Ollama（本地推理，独立接口格式）
 */
export async function callOllama(prompt) {
  const { url, model } = AI_CONFIG.ollama;

  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || DEFAULT_MODELS.ollama, prompt, stream: false }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ollama 错误');
  return data.response;
}
