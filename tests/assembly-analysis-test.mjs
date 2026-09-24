#!/usr/bin/env node
/**
 * 单元测试 — 装配顺序对接与自定义步骤生成（src/assembly-analysis.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - generateCustomStepGroups：步组结构（欢迎 + 分组 + 完成）、computeStepGroupCount
 *     分组数学、ceil 切片不重不漏、assemblySequenceOrder 对部件排序的影响、
 *     文案模板含文件名与部件数；
 *   - maybeApplyAssemblySequence：四道守卫（hasCustomModel / customModelParts 非空 /
 *     order 非空 / 重叠 >= 2）全部短路且零写入；成功路径写六个共享状态、clamp
 *     currentStep、调 updateStepUI 与 showStatus、展开面板并触发分析；
 *   - runAssemblyAnalysis：resultEl 缺失短路、初始 loading 态、btn disabled
 *     生命周期、评分三档配色与 null 兜底、扣分表与建议的两种渲染分支、
 *     resp 不 ok 与 fetch 抛错两条失败路径；
 *   - 共享状态桥接：s.* 写立刻回落 store patch，读惰性取最新。
 *
 * 用法：node tests/assembly-analysis-test.mjs
 */

import { createAssemblyAnalysis } from "../src/assembly-analysis.js";
import { computeStepGroupCount } from "../src/utils.js";

// ===== 测试框架（与 unit-test.mjs / ar-preview-test.mjs 一致）=====
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

// ===== 假浏览器世界 =====
const REAL_DOC = globalThis.document;
const REAL_FETCH = globalThis.fetch;

function makeEl() {
  return {
    innerHTML: "",
    textContent: "",
    disabled: false,
    open: false,
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
  };
}

function makePart(name, dist) {
  return { name, homePos: { length: () => dist } };
}

function makeStore(overrides) {
  const state = {
    hasCustomModel: false,
    customModelParts: [],
    assemblySequenceOrder: null,
    stepGroups: [],
    totalSteps: 0,
    currentStep: 0,
    ...(overrides || {}),
  };
  const patches = [];
  return {
    state,
    patches,
    getState: () => state,
    setState(patch) {
      patches.push({ ...patch });
      Object.assign(state, patch);
    },
  };
}

function setup(overrides) {
  const els = {
    "assembly-analyze-btn": makeEl(),
    "assembly-result": makeEl(),
    "assembly-panel": makeEl(),
  };
  globalThis.document = { getElementById: id => els[id] || null };
  const fetchCalls = [];
  let responder = () => {
    throw new Error("responder 未设置");
  };
  globalThis.fetch = async url => {
    fetchCalls.push(url);
    return responder(url);
  };
  const store = makeStore(overrides && overrides.state);
  let stepUIHits = 0;
  const statuses = [];
  const a = createAssemblyAnalysis({
    getState: store.getState,
    setState: store.setState,
    updateStepUI: () => { stepUIHits += 1; },
    showStatus: (msg, type) => statuses.push({ msg, type }),
  });
  return {
    a, els, store, fetchCalls, statuses,
    stepUIHits: () => stepUIHits,
    setResponder: fn => { responder = fn; },
  };
}

function restoreGlobals() {
  if (REAL_DOC === undefined) delete globalThis.document;
  else globalThis.document = REAL_DOC;
  if (REAL_FETCH === undefined) delete globalThis.fetch;
  else globalThis.fetch = REAL_FETCH;
}

const okResp = body => ({ ok: true, status: 200, json: async() => body });
const badResp = (status, body) => ({ ok: false, status, json: async() => body });

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ===== 用例 =====
describe("generateCustomStepGroups 纯函数", async() => {
  await it("结构：欢迎 + 分组 + 完成，分组数按 computeStepGroupCount", () => {
    const { a } = setup();
    const parts = [makePart("part-a", 3), makePart("part-b", 2), makePart("part-c", 1)];
    const groups = a.generateCustomStepGroups(parts, "robot.glb");
    const expectGroups = computeStepGroupCount(3);
    assert(groups.length === expectGroups + 2, `总步数 = 分组数 ${expectGroups} + 欢迎/完成`);
    assert(groups[0].name === "👋 模型概览", "首步是模型概览");
    assert(groups[0].parts.length === 0 && groups[0].tools.length === 0, "概览无部件无工具");
    assert(groups[0].description.includes("robot.glb"), "概览文案含文件名");
    assert(groups[0].description.includes("<strong>3</strong> 个独立部件"), "概览文案含部件数");
    assert(groups[groups.length - 1].name === "🎉 拆解完成", "末步是拆解完成");
    assert(groups[groups.length - 1].parts.length === 0, "完成步无部件");
    for (let g = 1; g < groups.length - 1; g++) {
      assert(groups[g].parts.length > 0, `第 ${g} 组非空`);
      assert(groups[g].name === `${g}️⃣ 第 ${g} 组部件`, `第 ${g} 组名称`);
      assert(groups[g].description.includes(`正在拆解第 ${g} 组（共 ${expectGroups} 组）`), `第 ${g} 组描述`);
      assert(groups[g].description.includes(`本组包含 ${groups[g].parts.length} 个部件`), `第 ${g} 组计数文案`);
      assert(JSON.stringify(groups[g].tools) === JSON.stringify(["🖱️ 鼠标拖拽旋转", "🔍 滚轮缩放观察"]), `第 ${g} 组工具清单`);
    }
  });

  await it("ceil 切片：部件不重不漏分入各组", () => {
    const { a } = setup();
    const parts = [];
    for (let i = 0; i < 7; i++) parts.push(makePart(`p${i}`, 7 - i));
    const groups = a.generateCustomStepGroups(parts, "m.glb");
    const flat = groups.slice(1, -1).flatMap(g => g.parts);
    assert(flat.length === 7, "部件全部入组");
    assert(new Set(flat).size === 7, "无重复入组");
    assert(groups[groups.length - 2].parts.length > 0, "最后一组非空");
  });

  await it("assemblySequenceOrder 决定组内顺序", () => {
    const { a, store } = setup({ state: { assemblySequenceOrder: ["c", "a", "b"] } });
    const parts = [makePart("a", 3), makePart("b", 2), makePart("c", 1)];
    const groups = a.generateCustomStepGroups(parts, "m.glb");
    assert(groups[1].parts[0] === "c", "组内首部件按装配顺序取 c");
    // 桥接惰性读：外部改 store，下一次生成立刻用新顺序
    store.state.assemblySequenceOrder = ["b", "c", "a"];
    const groups2 = a.generateCustomStepGroups(parts, "m.glb");
    assert(groups2[1].parts[0] === "b", "惰性读到新顺序的首部件为 b");
  });

  await it("零部件：不崩，仍产生欢迎与完成步", () => {
    const { a } = setup();
    const groups = a.generateCustomStepGroups([], "empty.glb");
    assert(groups.length >= 2, "至少有欢迎与完成步");
    assert(groups[0].description.includes("<strong>0</strong> 个独立部件"), "概览显示 0 部件");
  });
});

describe("maybeApplyAssemblySequence 守卫与成功路径", async() => {
  await it("非自定义模型：直接返回，不发请求不写状态", async() => {
    const w = setup({ state: { hasCustomModel: false } });
    await w.a.maybeApplyAssemblySequence("m.glb");
    await flush();
    assert(w.fetchCalls.length === 0, "不发 fetch");
    assert(w.store.patches.length === 0, "零 patch");
  });

  await it("customModelParts 为空：直接返回", async() => {
    const w = setup({ state: { hasCustomModel: true, customModelParts: [] } });
    await w.a.maybeApplyAssemblySequence("m.glb");
    await flush();
    assert(w.fetchCalls.length === 0, "不发 fetch");
    assert(w.store.patches.length === 0, "零 patch");
  });

  await it("后端不可用 / order 为空 / success=false：均静默返回", async() => {
    const parts = [makePart("a", 1), makePart("b", 2)];
    for (const [label, resp] of [
      ["resp.ok=false", badResp(503, {})],
      ["order 空数组", okResp({ success: true, order: [] })],
      ["success=false", okResp({ success: false })],
      ["order 非数组", okResp({ success: true, order: "nope" })],
    ]) {
      const w = setup({ state: { hasCustomModel: true, customModelParts: parts } });
      w.setResponder(() => resp);
      await w.a.maybeApplyAssemblySequence("m.glb");
      await flush();
      assert(w.store.patches.length === 0, `${label}：零 patch`);
    }
  });

  await it("fetch 抛错：静默回退不抛出", async() => {
    const parts = [makePart("a", 1), makePart("b", 2)];
    const w = setup({ state: { hasCustomModel: true, customModelParts: parts } });
    w.setResponder(() => { throw new Error("network down"); });
    let threw = false;
    try { await w.a.maybeApplyAssemblySequence("m.glb"); await flush(); } catch { threw = true; }
    assert(threw === false, "不向外抛错");
    assert(w.store.patches.length === 0, "零 patch");
  });

  await it("重叠不足 2：判定不同模型，保持原排序", async() => {
    const parts = [makePart("a", 1), makePart("b", 2)];
    const w = setup({ state: { hasCustomModel: true, customModelParts: parts } });
    w.setResponder(() => okResp({ success: true, order: ["a", "x1", "x2"] }));
    await w.a.maybeApplyAssemblySequence("m.glb");
    await flush();
    assert(w.store.patches.length === 0, "零 patch（判定不同模型）");
  });

  await it("成功路径：六项共享状态落定、clamp、UI 刷新、提示、展开面板", async() => {
    const parts = [makePart("a", 1), makePart("b", 2), makePart("c", 3), makePart("d", 4)];
    const w = setup({ state: { hasCustomModel: true, customModelParts: parts, currentStep: 9 } });
    w.setResponder(url => {
      if (url.includes("/api/assembly/sequence")) return okResp({ success: true, order: ["d", "c", "b", "a"] });
      return okResp({ success: true, production_readiness: { score: 90 } });
    });
    await w.a.maybeApplyAssemblySequence("robot.glb");
    await flush();
    assert(w.store.state.assemblySequenceOrder.join(",") === "d,c,b,a", "assemblySequenceOrder 回落");
    assert(w.store.state.stepGroups.length === computeStepGroupCount(4) + 2, "stepGroups 按新顺序重建");
    assert(w.store.state.totalSteps === w.store.state.stepGroups.length, "totalSteps 同步");
    assert(w.store.state.currentStep === w.store.state.totalSteps - 1, "currentStep 越界被 clamp 到末步");
    assert(w.stepUIHits() === 1, "updateStepUI 刷新一次");
    const ok = w.statuses.find(s => s.msg.includes("已根据 Blender 装配分析优化拆解顺序"));
    assert(Boolean(ok), "showStatus 成功提示");
    assert(ok && ok.msg.includes("匹配 4 个部件") && ok.type === "success", "提示含重叠数与类型");
    assert(w.els["assembly-panel"].open === true, "装配面板展开");
    assert(w.fetchCalls.some(u => u === "/api/assembly/analysis"), "自动触发装配分析");
  });

  await it("currentStep 未越界时不被 clamp 改写", async() => {
    const parts = [makePart("a", 1), makePart("b", 2)];
    const w = setup({ state: { hasCustomModel: true, customModelParts: parts, currentStep: 1 } });
    w.setResponder(url => (url.includes("/api/assembly/sequence") ?
      okResp({ success: true, order: ["a", "b"] }) :
      okResp({ success: true })));
    await w.a.maybeApplyAssemblySequence("m.glb");
    await flush();
    const total = w.store.state.stepGroups.length;
    assert(w.store.state.currentStep === 1, `currentStep=1 < totalSteps=${total} 时保持`);
  });
});

describe("runAssemblyAnalysis 面板渲染", async() => {
  await it("resultEl 缺失：直接返回", async() => {
    const w = setup();
    globalThis.document = { getElementById: () => null };
    await w.a.runAssemblyAnalysis();
    await flush();
    assert(w.fetchCalls.length === 0, "不发请求");
  });

  await it("成功：评分 90 绿色档 + 计数行 + 扣分表 + 建议", async() => {
    const w = setup();
    w.setResponder(() => okResp({
      success: true,
      part_count: 12,
      interference_count: 2,
      interface_count: 5,
      production_readiness: {
        score: 90,
        level: "A",
        recommendations: ["倒角", "去毛刺"],
        breakdown: { "壁厚": -5, "间隙": -3 },
      },
    }));
    await w.a.runAssemblyAnalysis();
    await flush();
    const html = w.els["assembly-result"].innerHTML;
    assert(html.includes("asm-score-badge") && html.includes("border-color:#2e7d32;color:#2e7d32"), "90 分绿色档");
    assert(html.includes("<div>可制造性评分 <strong style=\"color:#2e7d32\">A</strong></div>"), "等级 A");
    assert(html.includes("部件数：12 ｜ 干涉：2 ｜ 配合面：5"), "计数行三项");
    assert(html.includes("<td>壁厚</td><td>-5</td>") && html.includes("<td>间隙</td><td>-3</td>"), "扣分表两行");
    assert(html.includes("<li>倒角</li>") && html.includes("<li>去毛刺</li>"), "建议列表");
    assert(w.els["assembly-analyze-btn"].disabled === false, "结束后按钮恢复可用");
  });

  await it("评分分档：60 琥珀 / 30 红 / null 兜底", async() => {
    for (const [score, color, badge] of [[60, "#f9a825", "60"], [30, "#c62828", "30"], [null, "#888", "—"]]) {
      const w = setup();
      w.setResponder(() => okResp({ success: true, production_readiness: { score, level: "B" } }));
      await w.a.runAssemblyAnalysis();
      await flush();
      const html = w.els["assembly-result"].innerHTML;
      assert(html.includes(`border-color:${color};color:${color}`), `score=${score} 配色 ${color}`);
      assert(html.includes(`>${badge}</div>`), `score=${score} 角标显示 ${badge}`);
    }
  });

  await it("空建议与空扣分：兜底文案、无表格", async() => {
    const w = setup();
    w.setResponder(() => okResp({ success: true, production_readiness: { score: 88, recommendations: [] } }));
    await w.a.runAssemblyAnalysis();
    await flush();
    const html = w.els["assembly-result"].innerHTML;
    assert(html.includes("<li>无明显制造风险</li>"), "空建议兜底文案");
    assert(!html.includes("asm-table"), "空扣分不渲染表格");
  });

  await it("运行中：按钮禁用 + loading 文案，完成后恢复", async() => {
    const w = setup();
    let release;
    w.setResponder(() => new Promise(res => { release = res; }));
    const p = w.a.runAssemblyAnalysis();
    await Promise.resolve();
    assert(w.els["assembly-analyze-btn"].disabled === true, "请求期间按钮禁用");
    assert(w.els["assembly-result"].innerHTML.includes("⏳ 正在分析…"), "loading 文案");
    assert(w.els["assembly-result"].classList.contains("hidden") === false, "hidden 被移除");
    release(okResp({ success: true, production_readiness: { score: 70 } }));
    await p;
    await flush();
    assert(w.els["assembly-analyze-btn"].disabled === false, "完成后恢复");
    assert(w.els["assembly-result"].innerHTML.includes("asm-score-badge"), "结果已渲染");
  });

  await it("resp 不 ok：展示后端错误与排查指引", async() => {
    const w = setup();
    w.setResponder(() => badResp(500, { error: "MCP 未连接" }));
    await w.a.runAssemblyAnalysis();
    await flush();
    const html = w.els["assembly-result"].innerHTML;
    assert(html.includes("装配分析不可用") && html.includes("MCP 未连接"), "错误原因展示");
    assert(html.includes("BlenderMCP → Connect to MCP server"), "排查指引");
    assert(w.els["assembly-analyze-btn"].disabled === false, "finally 恢复按钮");
  });

  await it("resp.ok 但 success=false：同样走不可用提示", async() => {
    const w = setup();
    w.setResponder(() => okResp({ success: false, error: "Blender 场景为空" }));
    await w.a.runAssemblyAnalysis();
    await flush();
    const html = w.els["assembly-result"].innerHTML;
    assert(html.includes("装配分析不可用"), "success=false 也走不可用分支");
    assert(html.includes("Blender 场景为空"), "展示后端错误原因");
    assert(w.els["assembly-analyze-btn"].disabled === false, "finally 恢复按钮");
  });

  await it("fetch 抛错：展示请求失败原因", async() => {
    const w = setup();
    w.setResponder(() => { throw new Error("boom"); });
    await w.a.runAssemblyAnalysis();
    await flush();
    const html = w.els["assembly-result"].innerHTML;
    assert(html.includes("请求失败") && html.includes("boom"), "失败原因展示");
    assert(w.els["assembly-analyze-btn"].disabled === false, "finally 恢复按钮");
  });
});

describe("共享状态桥接不变量", async() => {
  await it("s.* 写经 patch 回落，且只含变动键", async() => {
    const parts = [makePart("a", 1), makePart("b", 2)];
    const w = setup({ state: { hasCustomModel: true, customModelParts: parts } });
    w.setResponder(url => (url.includes("/api/assembly/sequence") ?
      okResp({ success: true, order: ["b", "a"] }) :
      okResp({ success: true })));
    await w.a.maybeApplyAssemblySequence("m.glb");
    await flush();
    const keys = new Set(w.store.patches.flatMap(p => Object.keys(p)));
    const allowed = new Set(["assemblySequenceOrder", "stepGroups", "totalSteps", "currentStep"]);
    for (const k of keys) assert(allowed.has(k), `patch 键 ${k} 在约定集合内`);
    assert(w.store.state.stepGroups.length > 0, "stepGroups 写后立即可见");
  });
});

// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
  }
  restoreGlobals();
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
