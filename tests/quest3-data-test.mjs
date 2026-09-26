#!/usr/bin/env node
/**
 * 单元测试 — Quest 3 技术规格数据（src/quest3-data.js 的 quest3Specs）
 *
 * 这个模块在删掉 partInfo 之前零测试覆盖：quest3Specs 唯一的消费者是
 * src/quest3-steps.js，靠模板字面量在 import 时把字段值拼进教学文案；字段一旦
 * 被改名或删掉，页面不会报错，只会安静地渲染出 "undefined"。本测试因此钉两类
 * 不变量：
 *   1. 数据自身：字段一个不少、非空、无首尾空白、没有占位残值；storage 是唯一
 *      的数组字段且每项都是非空串；
 *   2. 消费契约：quest3-steps.js 读的那 9 个字段，值必须原样出现在教学文案里，
 *      且任何一段文案都不许出现 "undefined"——这是字段改名唯一的 observable
 *      信号。
 *
 * 不在钉死之列：各字段的具体数值（重量改成 500g 之类）。数值就是数据本身，UI
 * 渲染什么完全由它决定，没有独立真值可对照；name / releaseDate / storage 除外，
 * 这三处页面标签直接依赖，做身份级钉住。
 *
 * 用法：node tests/quest3-data-test.mjs
 */

import { quest3Specs } from "../src/quest3-data.js";
import { defaultStepGroups } from "../src/quest3-steps.js";

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
// quest3Specs 的全部字段（quest3-steps.js 消费的那 9 个也在其中）
const SPEC_FIELDS = [
  "name", "releaseDate", "price", "weight", "dimensions", "processor", "gpu",
  "memory", "storage", "display", "refreshRate", "fov", "lenses",
  "ipdAdjustment", "cameras", "tracking", "connectivity", "battery", "os",
];
const STRING_FIELDS = SPEC_FIELDS.filter(f => f !== "storage");
// src/quest3-steps.js 实际读取的字段 → 出现在哪几步的文案里。按组而不是全文
// 检索，是因为 "515g" 这类值在别处也有静态文案（③ 头带步骤里就手写了一行
// 「总重量 515g」），全文包含会让「删掉欢迎步骤里的模板行」这种改动存活。
const GROUP_CONTRACTS = [
  {
    index: 0,
    fields: ["weight", "processor", "display", "refreshRate", "cameras"],
  },
  {
    index: 5,
    fields: ["display", "refreshRate", "fov"],
  },
  {
    index: 6,
    fields: ["processor", "gpu", "memory", "storage", "display", "refreshRate"],
  },
];
const PLACEHOLDERS = ["undefined", "null", "TODO", "N/A", "none"];

describe("quest3Specs — 字段齐全且都是非空串", async() => {
  for (const f of STRING_FIELDS) {
    await it(f, () => {
      const v = quest3Specs[f];
      const ok = f in quest3Specs &&
        typeof v === "string" &&
        v.trim() === v &&
        v.length > 0;
      assert(ok, `${f} 存在且是无首尾空白的非空串（实得 ${JSON.stringify(v)}）`);
    });
  }
});

describe("quest3Specs — storage 是唯一的数组字段", async() => {
  await it("storage", () => {
    assert(Array.isArray(quest3Specs.storage),
      `storage 是数组（实得 ${typeof quest3Specs.storage}）`);
    assert(quest3Specs.storage.length > 0, "storage 至少一项");
    assert(quest3Specs.storage.every(s => typeof s === "string" && s.trim() === s && s.length > 0),
      `storage 每项都是无首尾空白的非空串（实得 ${JSON.stringify(quest3Specs.storage)}）`);
  });
  await it("其余字段都不是数组/对象", () => {
    const nonString = STRING_FIELDS.filter(f => typeof quest3Specs[f] !== "string");
    assert(nonString.length === 0, `除 storage 外没有别的数组/对象字段（实得 ${nonString.join(", ")}）`);
  });
});

describe("quest3Specs — 无占位残值", async() => {
  for (const f of SPEC_FIELDS) {
    await it(f, () => {
      const v = quest3Specs[f];
      const items = Array.isArray(v) ? v : [v];
      const bad = items.filter(x => PLACEHOLDERS.includes(x));
      assert(bad.length === 0, `${f} 不含占位残值（实得 ${JSON.stringify(v)}）`);
    });
  }
});

describe("quest3Specs — 关键身份值（页面标签直接依赖）", async() => {
  await it("name", () => {
    assert(quest3Specs.name === "Meta Quest 3",
      `name 是 Meta Quest 3（实得 ${JSON.stringify(quest3Specs.name)}）`);
  });
  await it("releaseDate", () => {
    assert(quest3Specs.releaseDate === "2023年10月",
      `releaseDate 是 2023年10月（实得 ${JSON.stringify(quest3Specs.releaseDate)}）`);
  });
  await it("storage", () => {
    assert(JSON.stringify(quest3Specs.storage) === JSON.stringify(["128GB", "512GB"]),
      `storage 恰为 128GB/512GB 两档（实得 ${JSON.stringify(quest3Specs.storage)}）`);
  });
});

describe("与消费方 quest3-steps.js 的契约", async() => {
  for (const { index, fields } of GROUP_CONTRACTS) {
    const group = defaultStepGroups[index];
    await it(`第 ${index} 步`, () => {
      assert(!!group, `第 ${index} 步存在`);
    });
    for (const f of fields) {
      await it(`第 ${index} 步的 ${f}`, () => {
        const v = quest3Specs[f];
        const text = Array.isArray(v) ? v.join(" / ") : v;
        const ok = !!group && f in quest3Specs && group.description.includes(text);
        assert(ok,
          `第 ${index} 步文案含 ${f} 的值（${JSON.stringify(String(text)).slice(0, 40)}）`);
      });
    }
  }
  await it("没有 undefined", () => {
    const hits = defaultStepGroups
      .map((g, i) => [i, g.description.includes("undefined")])
      .filter(([, hit]) => hit)
      .map(([i]) => i);
    assert(hits.length === 0, `没有任何一段文案渲染出 undefined（实得下标 ${hits.join(", ")}）`);
  });
  await it("步骤组结构", () => {
    assert(defaultStepGroups.length === 8, `默认教学共 8 步（实得 ${defaultStepGroups.length}）`);
    for (let i = 0; i < defaultStepGroups.length; i++) {
      const g = defaultStepGroups[i];
      const ok = typeof g.name === "string" && g.name.length > 0 &&
        typeof g.description === "string" && g.description.length > 0 &&
        Array.isArray(g.parts) && Array.isArray(g.tools);
      assert(ok, `第 ${i} 步 name/description 非空且 parts/tools 是数组`);
    }
  });
});


// ===== 变异测试记录（/tmp/mutate_q3data.py，共 19 个变异：15 杀 4 存活）=====
// 15 杀：
//   删 weight 字段 / weight 改名 weightG / weight 清空 / weight 加首空格 /
//   weight 值改成 "undefined" 字符串 / storage 空数组 / storage 改字符串 /
//   storage 首项清空 / storage 首项加尾空格 / name 改值 / releaseDate 改值 /
//   os 值改 undefined / 整个 quest3Specs 不再导出 / 欢迎步骤删掉重量模板行 /
//   透镜步骤删掉 FOV 模板行。
// 4 存活，均为按设计存活（或行为等价）：
//   1. 插入未登记字段（extra: "x"）：全仓没有任何代码遍历 quest3Specs 的键
//      （唯一的消费者 quest3-steps.js 逐个具名读字段），多一个惰性字段不改变
//      任何渲染输出；字段拼写错误这类真正的事故已被「字段一个不少」那一组断言
//      覆盖（拼错的字段同时等于少了一个已登记字段）。
//   2. weight 改数值 "515g" -> "500g"：数值就是数据本身，欢迎步骤的模板行会
//      跟着渲染新值，契约断言与数据同步故不报警。注：③ 头带步骤里另有一行
//      静态文案「总重量 515g」，改数据后两处会不一致——那属于 quest3-steps
//      的内容一致性，由tests/quest3-steps-test.mjs的职责范围，本测试不越界。
//   3. price 改数值：同上，price 没有任何消费者，改它只改数据。
//   4. 存储模板行硬编码成 "128GB / 512GB"：与数据当前值逐字相同，渲染输出
//      完全一致，只有下次改 storage 数据时才会分叉——典型等价变异。

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
