// 各 AI 提供商的默认模型（单一来源）
// server 端 AI_CONFIG 默认值从此处取，避免与前端 ai-config.html 的模型清单各自维护、改一处漏一处。
export const DEFAULT_MODELS = {
  openai: "gpt-5.6-sol",
  anthropic: "claude-sonnet-5",
  ollama: "codellama",
  lmstudio: "",
  stepfun: "step-3.5-flash",
  nvidia: "z-ai/glm-5.2",
  kimi: "kimi-k3",
};
