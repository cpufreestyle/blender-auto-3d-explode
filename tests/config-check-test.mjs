#!/usr/bin/env node
/**
 * 单元测试 — 「配置 AI」提醒判断（src/panels/config-check.js 的
 * configNeedsHighlight，从 config-panel.js 的 fetchConfigAndHighlight 提取）
 *
 * 提取前这条规则内联在 fetchConfigAndHighlight 的 promise 链里，而那整个模块
 * 在 import 时就读 document / window 并启动 Blender 健康检测，Node 里根本加载
 * 不进来——规则错了要么漏催（provider/key 没配好，用户点生成才静默失败）、要么
 * 误催（明明能用却一直挂黄点），两种都不报错。本测试把它钉住：
 *   - 读不到配置（null / undefined / false / 0 / 空串）一律提醒；
 *   - provider 缺失或为 "img3d" 一律提醒——img3d 表示「还没选真 provider」，
 *     就该催去配，而不是因为它不需要 Key 就放行；
 *   - 当前 provider 缺 key 块、块不是对象、key 为空 / 打码 "***" 一律提醒；
 *   - 有真 key 才放行，且返回值严格是布尔（调用方写的是 if (...)，但返回值
 *     类型属于契约）。
 *
 * 用法：node tests/config-check-test.mjs
 */

import { configNeedsHighlight } from "../src/panels/config-check.js";

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

// 受支持的 provider 名（与 ai-config.json 的几大块对齐；img3d 单列在别组）
const REAL_PROVIDERS = ["openai", "anthropic", "ollama", "lmstudio", "stepfun", "nvidia"];

// ===== 用例 =====
describe("configNeedsHighlight — 读不到配置一律提醒", async() => {
  for (const cfg of [null, undefined, false, 0, ""]) {
    await it(String(cfg), () => {
      assert(configNeedsHighlight(cfg) === true,
        `${JSON.stringify(cfg)} → 提醒（实得 ${configNeedsHighlight(cfg)}）`);
    });
  }
});

describe("configNeedsHighlight — provider 缺失或为 img3d 一律提醒", async() => {
  await it("空对象", () => {
    assert(configNeedsHighlight({}) === true, "{} → 提醒");
  });
  for (const p of ["", undefined, null, 0, false]) {
    await it(String(p), () => {
      assert(configNeedsHighlight({ provider: p }) === true,
        `provider=${JSON.stringify(p)} → 提醒`);
    });
  }
  await it("img3d：不需要 Key 也同样催", () => {
    assert(configNeedsHighlight({ provider: "img3d" }) === true, "只有 img3d → 提醒");
    assert(configNeedsHighlight({ provider: "img3d", img3d: { key: "whatever" } }) === true,
      "img3d 就算带了 key 也提醒（它表示还没选真 provider）");
  });
});

describe("configNeedsHighlight — key 缺失 / 空 / 打码一律提醒", async() => {
  const BAD_KEYS = [undefined, "", "***", null, 0, false];
  for (const k of BAD_KEYS) {
    await it(JSON.stringify(k), () => {
      const cfg = { provider: "openai", openai: { key: k } };
      assert(configNeedsHighlight(cfg) === true,
        `openai.key=${JSON.stringify(k)} → 提醒`);
    });
  }
  await it("provider 块整个缺失", () => {
    assert(configNeedsHighlight({ provider: "openai" }) === true, "openai 块不在 → 提醒");
  });
  await it("provider 块是空对象", () => {
    assert(configNeedsHighlight({ provider: "openai", openai: {} }) === true, "空块 → 提醒");
  });
  await it("provider 块不是对象", () => {
    assert(configNeedsHighlight({ provider: "openai", openai: 42 }) === true, "块是数字 → 提醒");
    assert(configNeedsHighlight({ provider: "openai", openai: "str" }) === true, "块是串 → 提醒");
  });
});

describe("configNeedsHighlight — 有真 key 才放行", async() => {
  for (const p of REAL_PROVIDERS) {
    await it(p, () => {
      const cfg = { provider: p, [p]: { key: "sk-real-123", model: "m" } };
      assert(configNeedsHighlight(cfg) === false,
        `${p} + 真 key → 不提醒（实得 ${configNeedsHighlight(cfg)}）`);
    });
  }
  await it("真实形状的配置", () => {
    const cfg = {
      provider: "nvidia",
      openai: { key: "", model: "gpt-5.6-sol" },
      nvidia: { key: "nvapi-real", model: "qwen3" },
      stepfun: { key: "sk-step", model: "step-3" },
    };
    assert(configNeedsHighlight(cfg) === false, "多 provider 配置只认当前那个");
  });
  await it("key 只比 ***：真 key 差一个字符都放行", () => {
    assert(configNeedsHighlight({ provider: "openai", openai: { key: "**" } }) === false,
      "** 不是打码占位符，算真 key");
    assert(configNeedsHighlight({ provider: "openai", openai: { key: "***" } }) === true,
      "*** 是打码占位符，仍提醒");
  });
});

describe("configNeedsHighlight — 返回值契约", async() => {
  await it("严格布尔", () => {
    const probes = [
      [null, true],
      [{}, true],
      [{ provider: "img3d" }, true],
      [{ provider: "openai", openai: { key: "***" } }, true],
      [{ provider: "openai", openai: { key: "sk" } }, false],
    ];
    for (const [cfg, expect] of probes) {
      const r = configNeedsHighlight(cfg);
      assert(r === expect && typeof r === "boolean",
        `${JSON.stringify(cfg)} → 严格等于 ${expect}（实得 ${JSON.stringify(r)}）`);
    }
  });
  await it("原型链上的怪 provider 不会炸", () => {
    assert(configNeedsHighlight({ provider: "constructor" }) === true,
      "provider=constructor → 走 .key 取到 undefined，提醒");
    assert(configNeedsHighlight({ provider: "__proto__" }) === true,
      "provider=__proto__ 同理，不抛异常");
    assert(configNeedsHighlight(Object.create(null)) === true, "无原型对象 → 提醒");
  });
});

// ===== 变异测试记录（/tmp/mutate_configcheck.py，共 8 个变异：6 杀 2 等价）=====
// 6 杀：读不到配置改成不提醒 / img3d 豁免词改成 img / 打码占位符从 *** 改成
//   ** / 打码占位符改成空串 / 或改与 / 取 key 改成取 model。
// 2 存活，均经 /tmp/diff_mutants.mjs 在 377 组输入（含 constructor / __proto__
//   / 数字 provider 等原型键边界）上逐组证明与原版零差异：
//   1. 去掉 hasProvider 的 !! 布尔化——返回值处的 ! 会对它再取一次反，最终
//      布尔值与带 !! 完全一致；
//   2. 去掉 key 查找前的 provider 守卫——provider 为假值时 cfg[provider] 本就
//      是 undefined，加不加守卫 key 都是 falsy。
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
