#!/usr/bin/env node
/**
 * 单元测试 — 提示词 → 画廊图标（src/panels/prompt-icon.js，
 * 从 src/panels/ai-paint-panel.js 抽取）
 *
 * 抽取的不变量：
 *   - 命中判断是「小写化后子串包含」，不是整词相等，也不是前缀匹配；
 *   - 顺序即优先级：按 PROMPT_ICON_RULES 自上而下首个命中的规则生效，
 *     因此 "球鞋" 拿的是排在其后的「球」🔴 而不是「汽车」🚗，
 *     "汽车人" 拿的是「汽车」🚗 而不是「人」🧑；
 *   - 英文关键词同样要过 toLowerCase，故 "Basketball" / "QUEST3" / "House" 能命中；
 *   - 全不命中回落 🎨；空串与纯空白也回落 🎨；
 *   - 首条规则是「篮球」，故同时含 "篮球" 与 "球" 时结果是 🏀 而非 🔴。
 *
 * 用法：node tests/prompt-icon-test.mjs
 */

import { getPromptIcon } from "../src/panels/prompt-icon.js";

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

// ===== 用例 =====
describe("getPromptIcon — 每个关键词各自命中", async() => {
  const cases = [
    ["篮球", "🏀"],
    ["basketball", "🏀"],
    ["quest", "🕶️"],
    ["vr", "🕶️"],
    ["头显", "🕶️"],
    ["机器人", "🤖"],
    ["robot", "🤖"],
    ["汽车", "🚗"],
    ["车", "🚗"],
    ["car", "🚗"],
    ["房子", "🏠"],
    ["house", "🏠"],
    ["人", "🧑"],
    ["角色", "🧑"],
    ["character", "🧑"],
    ["火箭", "🚀"],
    ["rocket", "🚀"],
    ["球", "🔴"],
    ["sphere", "🔴"],
    ["ball", "🔴"],
  ];
  for (const [word, icon] of cases) {
    it(`「${word}」→ ${icon}`, () => {
      assert(getPromptIcon(word) === icon, `「${word}」应得 ${icon}`);
    });
  }
});

describe("getPromptIcon — 大小写不敏感", async() => {
  await it("英文关键词大写也能命中", () => {
    assert(getPromptIcon("Basketball") === "🏀", "Basketball → 🏀");
    assert(getPromptIcon("QUEST3") === "🕶️", "QUEST3 → 🕶️");
    assert(getPromptIcon("House") === "🏠", "House → 🏠");
    assert(getPromptIcon("ROBOT") === "🤖", "ROBOT → 🤖");
    assert(getPromptIcon("Car") === "🚗", "Car → 🚗");
  });
});

describe("getPromptIcon — 顺序即优先级", async() => {
  await it("「篮球」压过「球」", () => {
    assert(getPromptIcon("篮球和球") === "🏀", "篮球和球 → 🏀");
  });
  await it("「球鞋」落在「球」而非「汽车」", () => {
    assert(getPromptIcon("球鞋") === "🔴", "球鞋 → 🔴");
  });
  await it("「汽车人」落在「汽车」而非「人」", () => {
    assert(getPromptIcon("汽车人") === "🚗", "汽车人 → 🚗");
  });
  await it("「quest 头显」取首条命中的 quest", () => {
    assert(getPromptIcon("quest 头显") === "🕶️", "quest 头显 → 🕶️");
  });
  await it("关键词夹在中间也能命中（子串匹配）", () => {
    assert(getPromptIcon("一个红色的房子") === "🏠", "一个红色的房子 → 🏠");
  });
});

describe("getPromptIcon — 相邻规则的先后（互斥关键词同时出现）", async() => {
  it("「机器人」排在「汽车」之前，同现时取机器人", () => {
    assert(getPromptIcon("机器人汽车") === "🤖", "机器人汽车 → 🤖");
    assert(getPromptIcon("汽车机器人") === "🤖", "汽车机器人 也取 🤖（按表序而非出现序）");
    assert(getPromptIcon("robot car") === "🤖", "robot car → 🤖");
    assert(getPromptIcon("car robot") === "🤖", "car robot → 🤖");
  });
  it("只含「汽车」时才落到汽车", () => {
    assert(getPromptIcon("汽车") === "🚗", "汽车 → 🚗");
    assert(getPromptIcon("robot") === "🤖", "robot → 🤖");
  });
  it("「人」与「角色」同属一条规则，彼此不冲突", () => {
    assert(getPromptIcon("角色") === "🧑", "角色 → 🧑");
    assert(getPromptIcon("机器人") === "🤖", "机器人 → 🤖");
  });
});

describe("getPromptIcon — 回落", async() => {
  await it("无关键词回落 🎨", () => {
    assert(getPromptIcon("未来感机械臂") === "🎨", "未来感机械臂 → 🎨");
  });
  await it("空串回落 🎨", () => {
    assert(getPromptIcon("") === "🎨", "空串 → 🎨");
  });
  await it("纯空白回落 🎨", () => {
    assert(getPromptIcon("   ") === "🎨", "纯空白 → 🎨");
  });
  await it("子串语义：单词中间夹着关键词也算命中", () => {
    assert(getPromptIcon("carving") === "🚗", "carving 含 car → 🚗（子串而非整词）");
  });
  await it("子串语义：scar 与 questing 同理", () => {
    assert(getPromptIcon("scar") === "🚗", "scar 含 car → 🚗");
    assert(getPromptIcon("questing") === "🕶️", "questing 含 quest → 🕶️");
  });
});

// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } catch (err) {
    console.error("运行异常:", err);
    process.exit(1);
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
