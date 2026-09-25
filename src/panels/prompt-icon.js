// 提示词 → 画廊图标（从 src/panels/ai-paint-panel.js 抽取，行为不变）。
//
// getPromptIcon 是 setupAIPaint 里少数零依赖的纯函数：不碰 DOM、不读闭包状态，
// 只按关键词命中顺序返回一个 emoji。原先是一条 if 早退链，这里等价改写为
// 「关键词表 + 首个命中即返回」，语义不变：顺序即优先级，先命中先返回，
// 全不命中回落 🎨。因为「球」排在「汽车」之后，"球鞋" 会得到 🔴 而非 🚗，
// 这是既有行为，由测试钉住。
//
// 无 DOM / 无闭包依赖，因此整段搬迁不需要 DI 接缝。

const PROMPT_ICON_RULES = [
  { keys: ["篮球", "basketball"], icon: "🏀" },
  { keys: ["quest", "vr", "头显"], icon: "🕶️" },
  { keys: ["机器人", "robot"], icon: "🤖" },
  { keys: ["汽车", "车", "car"], icon: "🚗" },
  { keys: ["房子", "house"], icon: "🏠" },
  { keys: ["人", "角色", "character"], icon: "🧑" },
  { keys: ["火箭", "rocket"], icon: "🚀" },
  { keys: ["球", "sphere", "ball"], icon: "🔴" },
];

export function getPromptIcon(prompt) {
  const p = prompt.toLowerCase();
  for (const rule of PROMPT_ICON_RULES) {
    if (rule.keys.some(k => p.includes(k))) return rule.icon;
  }
  return "🎨";
}
