#!/usr/bin/env node
/**
 * 单元测试 — 部件步骤序号分配（src/quest3-steps.js 的 assignPartStepIndices，
 * 从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 命名补齐：mesh.userData.name 缺失时取 mesh.name、二者皆缺则回落
 *     part_<parts 位序>；mesh.name 缺失时取 mesh.userData.name；两者都有则
 *     一字不改（不覆盖既有命名）；
 *   - stepIndex 归属：命中 stepGroups 即取该组下标，未命中落 totalSteps
 *     （「默认最后一步」）；stepGroups.forEach 不 break，同名落在多个组时
 *     以最后一个命中的组为准；
 *   - group.parts 为空数组不误命中；stepGroups 为空则全部落 totalSteps；
 *   - parts 数组本身不被重建（同一引用、长度与顺序不变），只写
 *     part.mesh.* 与 part.stepIndex 两个字段；
 *   - stepGroups / totalSteps 都是实参快照，换个值再调一次，结果跟着变
 *     （钉住「模块不缓存任何步骤方案」）。
 *
 * 用法：node tests/quest3-steps-test.mjs
 */

import { assignPartStepIndices, defaultStepGroups } from "../src/quest3-steps.js";

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

// 造一个部件：meshName / userName 传 undefined 表示该字段缺失（three 的
// Mesh 总是带 userData，故 userData 恒存在，只是 name 可能为空）
function makePart(meshName, userName) {
  const mesh = {};
  if (meshName !== undefined) mesh.name = meshName;
  mesh.userData = {};
  if (userName !== undefined) mesh.userData.name = userName;
  return { mesh };
}

function run(parts, stepGroups, totalSteps) {
  assignPartStepIndices({ parts, stepGroups, totalSteps });
  return parts.map(p => ({
    meshName: p.mesh.name,
    userName: p.mesh.userData.name,
    stepIndex: p.stepIndex,
  }));
}

const GROUPS = [
  { name: "g0", parts: ["A", "B"] },
  { name: "g1", parts: ["C"] },
  { name: "g2", parts: [] },
];

describe("命名补齐", async() => {
  await it("userData.name 与 mesh.name 都有：一字不改", async() => {
    const [r] = run([makePart("M", "U")], GROUPS, 3);
    assert(r.userName === "U", "userData.name 保持 U");
    assert(r.meshName === "M", "mesh.name 保持 M（未被 userData 覆盖）");
  });

  await it("userData.name 缺、mesh.name 有：取 mesh.name", async() => {
    const [r] = run([makePart("只有Mesh名", undefined)], GROUPS, 3);
    assert(r.userName === "只有Mesh名", `userData.name 回落为 mesh.name（实际 ${r.userName}）`);
    assert(r.meshName === "只有Mesh名", "mesh.name 不变");
  });

  await it("两者皆缺：回落 part_<位序>", async() => {
    const rs = run([makePart(undefined, undefined), makePart(undefined, undefined)], GROUPS, 3);
    assert(rs[0].userName === "part_0", `第 0 个回落 part_0（实际 ${rs[0].userName}）`);
    assert(rs[1].userName === "part_1", `第 1 个回落 part_1（实际 ${rs[1].userName}）`);
    assert(rs[1].meshName === "part_1", "mesh.name 同步取回落的 userData.name");
  });

  await it("mesh.name 缺、userData.name 有：mesh.name 取 userData.name", async() => {
    const [r] = run([makePart(undefined, "已有UserData")], GROUPS, 3);
    assert(r.meshName === "已有UserData", `mesh.name 取 userData.name（实际 ${r.meshName}）`);
  });

  await it("空串 mesh.name 视为缺失（虚伪值判断）", async() => {
    const [r] = run([makePart("", undefined)], GROUPS, 3);
    assert(r.userName === "part_0", `空 mesh.name 不采用，落到 part_0（实际 ${r.userName}）`);
  });
});

describe("stepIndex 归属", async() => {
  await it("命中组：取该组下标", async() => {
    const rs = run(
      [makePart("A"), makePart("B"), makePart("C")],
      GROUPS,
      3,
    );
    assert(rs[0].stepIndex === 0, `A 属 g0（实际 ${rs[0].stepIndex}）`);
    assert(rs[1].stepIndex === 0, `B 属 g0（实际 ${rs[1].stepIndex}）`);
    assert(rs[2].stepIndex === 1, `C 属 g1（实际 ${rs[2].stepIndex}）`);
  });

  await it("未命中：落 totalSteps（默认最后一步）", async() => {
    const [r] = run([makePart("不在任何组里")], GROUPS, 3);
    assert(r.stepIndex === 3, `落 totalSteps=3（实际 ${r.stepIndex}）`);
  });

  await it("同名在多个组：以最后一个命中的组为准", async() => {
    const groups = [
      { name: "g0", parts: ["X"] },
      { name: "g1", parts: ["X"] },
    ];
    const [r] = run([makePart("X")], groups, 9);
    assert(r.stepIndex === 1, `forEach 不 break，取后命中的 g1=1（实际 ${r.stepIndex}）`);
  });

  await it("两者都有且不一致：组匹配认 userData.name 而非 mesh.name", async() => {
    // mesh.name="A"（在 g0 里）而 userData.name="Z"（不在任何组里）：
    // 原实现取 userData.name，故落 totalSteps；若误取 mesh.name 会落 0。
    // 这条专门钉住「取哪个字段做组匹配」。
    const [r] = run([makePart("A", "Z")], GROUPS, 3);
    assert(r.userName === "Z" && r.meshName === "A", "两个命名都保持原值（互不覆盖）");
    assert(r.stepIndex === 3, `组匹配用 userData.name=Z，落 totalSteps=3（实际 ${r.stepIndex}）`);
    const [q] = run([makePart("Z", "A")], GROUPS, 3);
    assert(q.stepIndex === 0, `反向同理：userData.name=A 命中 g0，落 0（实际 ${q.stepIndex}）`);
  });

  await it("group.parts 为空数组不误命中", async() => {
    const [r] = run([makePart("A")], GROUPS, 3);
    assert(r.stepIndex === 0, "A 仍归 g0，未被空的 g2 吸走");
    const [q] = run([makePart("空组里的名字")], GROUPS, 3);
    assert(q.stepIndex === 3, "名字不在任何非空组即落 totalSteps");
  });

  await it("stepGroups 为空：全部落 totalSteps", async() => {
    const rs = run([makePart("A"), makePart("B")], [], 2);
    assert(rs.every(r => r.stepIndex === 2), "两步方案下未命中者落 2");
  });

  await it("totalSteps = 0 时未命中落 0", async() => {
    const [r] = run([makePart("无归属")], GROUPS, 0);
    assert(r.stepIndex === 0, `落 totalSteps=0（实际 ${r.stepIndex}）`);
  });
});

describe("只写命名与 stepIndex，不动其它", async() => {
  await it("parts 数组同一引用、长度与顺序不变", async() => {
    // 每个部件预先带不同的 userData.name（mesh.name 缺），这样补齐后可以直接
    // 按命名比对槽位，验证 forEach 没有重排或重建 parts
    const parts = [makePart(undefined, "pA"), makePart(undefined, "pZ"), makePart(undefined, "pC")];
    const refs = parts.slice();
    const sameArray = parts;
    run(parts, GROUPS, 3);
    assert(sameArray === parts, "没有返回/替换新数组（引用同一）");
    assert(parts.length === 3, "长度不变");
    assert(
      parts.every((p, i) => p === refs[i]),
      "每个槽位还是原来那个 part 对象（未被重排或替换）",
    );
    assert(
      parts.map(p => p.mesh.userData.name).join(",") === "pA,pZ,pC",
      `各槽位命名保持原顺序（实际 ${parts.map(p => p.mesh.userData.name).join(",")}）`,
    );
    assert(
      parts.map(p => p.mesh.name).join(",") === "pA,pZ,pC",
      `mesh.name 按各自 userData.name 补齐（实际 ${parts.map(p => p.mesh.name).join(",")}）`,
    );
    assert(parts[1].stepIndex === 3, "Z 仍未命中（落 totalSteps=3）");
  });

  await it("不新增或删除 part 的其它字段", async() => {
    const p = makePart("A");
    p.extra = { keep: true };
    run([p], GROUPS, 3);
    assert(p.extra && p.extra.keep === true, "既有的 extra 字段原样保留");
    const keys = Object.keys(p).sort().join(",");
    assert(keys === "extra,mesh,stepIndex", `字段集为 mesh/stepIndex/extra（实际 ${keys}）`);
  });
});

describe("实参快照：不缓存步骤方案", async() => {
  await it("换 stepGroups 再调一次，结果跟着变", async() => {
    const parts = [makePart("A")];
    const first = run(parts, GROUPS, 3)[0].stepIndex;
    assert(first === 0, "第一套方案 A 落 0");
    const second = [{ name: "only", parts: ["A"] }];
    assignPartStepIndices({ parts, stepGroups: second, totalSteps: 3 });
    assert(parts[0].stepIndex === 0, "第二套方案 A 仍落 0（该组成了第 0 组）");
    const third = [
      { name: "empty", parts: [] },
      { name: "has", parts: ["A"] },
    ];
    assignPartStepIndices({ parts, stepGroups: third, totalSteps: 3 });
    assert(parts[0].stepIndex === 1, `第三套方案 A 落 1（实际 ${parts[0].stepIndex}）`);
  });

  await it("改实参对象后不影响已算出的结果", async() => {
    const parts = [makePart("A")];
    const groups = [{ name: "g0", parts: ["A"] }];
    run(parts, groups, 3);
    groups[0].parts = ["B"]; // 事后改快照内容
    assert(parts[0].stepIndex === 0, "已算出的 stepIndex 不被事后改动追溯");
  });
});

describe("与 defaultStepGroups 的真实数据", async() => {
  await it("defaultStepGroups 自身形状可被消费", async() => {
    assert(Array.isArray(defaultStepGroups) && defaultStepGroups.length > 0, "默认方案非空数组");
    assert(
      defaultStepGroups.every(g => Array.isArray(g.parts)),
      "每组的 parts 都是数组（本函数依赖这一点）",
    );
    assert(
      defaultStepGroups[0].parts.length === 0,
      "第 0 组「欢迎」不放任何部件，作为未命中者落点之前的占位",
    );
  });

  await it("用真实方案跑一遍不抛错，且步骤号都在合法区间", async() => {
    const parts = ["主机身", "左摄像头", "头带", "不存在的部件"].map(n => makePart(n));
    run(parts, defaultStepGroups, defaultStepGroups.length);
    assert(
      parts.every(p => p.stepIndex >= 0 && p.stepIndex <= defaultStepGroups.length),
      "stepIndex 均落在 [0, totalSteps]",
    );
    assert(parts[3].stepIndex === defaultStepGroups.length, "不存在的部件落 totalSteps");
  });
});

// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
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
