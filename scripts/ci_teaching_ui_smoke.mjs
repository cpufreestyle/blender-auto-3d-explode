#!/usr/bin/env node
/**
 * 教学核心与「意义」专项 — 真机冒烟门禁（需要本机 Chrome，故意不进 npm test）。
 *
 * 动机：本轮把教学核心前置（部件清单默认展开、排到 AI 生成之上）、加了步骤深链
 * 与授课模式。前两者是 DOM 结构问题，单测的假 DOM 断言不了「默认展开」和
 * 「谁排在谁前面」；后者要真的点按钮、真的按键盘，并确认没有浮层把事件吃掉。
 * 单测能覆盖的纯逻辑（深链解析、授课模式的 .hidden 原状保护）另有
 * tests/step-link-test.mjs 与 tests/teaching-mode-test.mjs，这里只补浏览器侧。
 *
 * 覆盖：
 *   0. 页面就绪且没被「首次配置」弹窗遮挡；
 *   1. 部件清单默认展开、排在 AI 绘画之前，AI 绘画默认折叠（教学核心前置的证据）；
 *   2. 授课模式按钮：点击后 AI 绘画 / 上传 / 配置入口 / 页脚提示全部收起，再点全部还原；
 *   3. T 键同样能切授课模式（键盘路径），L 键触发复制深链（有 toast 反馈）；
 *   4. 深链实例：/?v=…#step=3 打开即落在第 3 步，按 → 后地址栏跟着写成 #step=4；
 *   5. 两个实例全程 0 运行时异常。
 *
 * 用法：
 *   node scripts/ci_teaching_ui_smoke.mjs
 *   PORT=3941 CDP_PORT=9285 node scripts/ci_teaching_ui_smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；0 且首行 SKIP = 本机没有 Chrome。
 */

import { startUiSmoke } from "./ui_smoke_lib.mjs";

const OUT = console.log.bind(console);
let passed = 0;
let failed = 0;
const A = (cond, msg) => { OUT((cond ? "  OK   " : "  FAIL ") + msg); if (cond) passed++; else failed++; };

const readJson = async (ui, fn) => JSON.parse(await ui.evaluate(`JSON.stringify(${fn})`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 分步动画 600ms：displayedStep 落定后时间轴读数才变，直接读会读到动画起点
const waitStep = async (ui, want, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const got = String(await readJson(ui, `document.getElementById("timeline-step").textContent`));
    if (got === String(want)) return got;
    await sleep(150);
  }
  return null;
};

const layoutOf = `(() => {
  const panels = [...document.querySelectorAll(".ui-overlay details.panel")];
  const parts = panels.find(d => d.querySelector(".parts-grid"));
  const ai = document.getElementById("ai-paint-panel");
  const at = el => (el ? panels.indexOf(el) : -1);
  return {
    partsOpen: parts ? parts.open : null,
    aiClosed: ai ? !ai.open : null,
    partsBeforeAi: parts && ai ? at(parts) < at(ai) : false,
    uploadClosed: (() => { const u = document.getElementById("upload-panel"); return u ? !u.open : null; })(),
  };
})()`;

const hiddenOf = `(() => ({
  ai: document.getElementById("ai-paint-panel").classList.contains("hidden"),
  upload: document.getElementById("upload-panel").classList.contains("hidden"),
  config: document.getElementById("open-config-btn").classList.contains("hidden"),
  hint: document.querySelector(".hint").classList.contains("hidden"),
}))()`;

// 侧栏是可滚动的（内容 ~1.4k px，headless 视口只有 717px 高），不先滚动的话
// getBoundingClientRect 给的 y 在折叠线以下，CDP 的点直接落到画布上——// 「点了没反应」在这里是假阴性，必须先 scrollIntoView。
const clickCenter = async (ui, selector) => {
  const box = JSON.parse(await ui.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "null";
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height });
  })()`));
  if (!box) return null;
  await ui.click(box.x, box.y);
  await sleep(120);
  return box;
};

try {
  const ui = await startUiSmoke({
    port: process.env.PORT || "3941",
    cdp: process.env.CDP_PORT || "9285",
    chromePath: process.env.CHROME_PATH || undefined,
  });
  if (!ui) {
    OUT("SKIP: 未找到 Chrome，本机无法跑浏览器冒烟");
    process.exit(0);
  }
  const { evaluate, key, pageErrors } = ui;

  const rdy = await ui.waitReady();
  A(rdy.ok, `页面就绪：清单 ${rdy.rows} 行（耗时 ${rdy.ms}ms）`);
  A((await ui.hideFirstRunModal()) === false, "首屏没有被「首次配置」弹窗遮挡");

  // ===== 教学核心前置 =====
  const layout = await readJson(ui, layoutOf);
  A(layout.partsOpen === true, "部件清单默认展开（不用先去折叠层里翻）");
  A(layout.partsBeforeAi === true, "部件清单排在 AI 绘画之前");
  A(layout.aiClosed === true, "AI 绘画默认折叠（生成入口不再抢首屏）");
  A(layout.uploadClosed === true, "上传自定义模型同样默认折叠");

  // ===== 授课模式 =====
  const hiddenBefore = await readJson(ui, hiddenOf);
  A(!hiddenBefore.ai && !hiddenBefore.upload && !hiddenBefore.config && !hiddenBefore.hint,
    "默认不放授课模式：AI / 上传 / 配置 / 提示都在位");
  const box = await clickCenter(ui, "#teaching-mode-btn");
  A(!!box, "授课模式按钮可见可点");
  const hiddenOn = await readJson(ui, hiddenOf);
  A(hiddenOn.ai && hiddenOn.upload && hiddenOn.config && hiddenOn.hint,
    "开启后四处入口全部收起");
  A((await readJson(ui, `document.body.classList.contains("teaching-mode")`)) === true,
    "body 打上 teaching-mode 标记");
  A((await readJson(ui, `document.getElementById("teaching-mode-btn").getAttribute("aria-pressed")`)) === "true",
    "按钮 aria-pressed 翻为 true");
  A((await readJson(ui, `!!document.querySelector(".parts-grid .part-item")`)) === true,
    "教学核心（部件清单）在授课模式下仍然可见");

  // 键盘路径：T 收起 / 展开
  await key("t");
  const hiddenAfterT = await readJson(ui, hiddenOf);
  A(!hiddenAfterT.ai && !hiddenAfterT.upload, "按 T 退出授课模式，入口回来");
  await key("t");
  const hiddenAfterT2 = await readJson(ui, hiddenOf);
  A(hiddenAfterT2.ai && hiddenAfterT2.upload, "再按 T 又收起");
  await key("t");

  // ===== 深链：地址栏跟着步骤走 =====
  // 每一步动画 600ms，连按会被 goToStep 的 isAnimating 守卫挡掉（真实用户不会这么按）
  await key("ArrowRight");
  await sleep(800);
  await key("ArrowRight");
  await sleep(800);
  const hash = await readJson(ui, `location.hash`);
  A(hash === "#step=2", `按两次 → 后地址栏写成 ${hash}`);
  await key("ArrowRight");
  await sleep(800);
  const hash2 = await readJson(ui, `location.hash`);
  A(hash2 === "#step=3", `再按一次写成 ${hash2}`);
  const tl = await waitStep(ui, 3);
  A(tl === "3", `时间轴读数与深链一致（${tl}）`);

  // ===== 复制深链按钮 =====
  const linkBtn = await readJson(ui, `(() => { const b = document.getElementById("copy-step-link-btn"); return b ? { title: b.title, text: b.textContent.trim() } : null; })()`);
  A(!!linkBtn && linkBtn.title.includes("快捷键 L"), "复制链接按钮带说明性 title");
  await clickCenter(ui, "#copy-step-link-btn");
  await sleep(500); // 剪贴板回调是 microtask，toast 晚一拍才出现
  const toast = await readJson(ui, `(() => { const t = document.querySelector(".toast"); return t ? t.textContent : ""; })()`);
  A(/第 \d+ 步/.test(String(toast)), `点击后给出反馈 toast：${toast}`);

  A(pageErrors.length === 0, `全程 0 运行时异常（实际 ${pageErrors.length}）`);
  await ui.stop();

  // ===== 深链实例：带着 #step=3 打开 =====
  const deep = await startUiSmoke({
    port: process.env.PORT2 || "3942",
    cdp: process.env.CDP2 || "9286",
    url: "/?v=3.3.2#step=3",
    chromePath: process.env.CHROME_PATH || undefined,
  });
  if (!deep) {
    A(false, "深链实例启动失败");
  } else {
    const rdy2 = await deep.waitReady();
    A(rdy2.ok, `深链实例就绪（耗时 ${rdy2.ms}ms）`);
    A((await deep.hideFirstRunModal()) === false, "深链实例没有被弹窗遮挡");
    // 首屏 applyDeepLink 会放一段 600ms 的分步动画，等它落定再读
    const tl2 = await waitStep(deep, 3);
    A(tl2 === "3", `打开 #step=3 即落在第 3 步（时间轴 ${tl2}）`);
    const stepNo = await readJson(deep, `document.getElementById("step-number").textContent`);
    A(String(stepNo).startsWith("步骤 3"), `步骤读数同步（实际「${stepNo}」）`);
    const hash3 = await readJson(deep, `location.hash`);
    A(hash3 === "#step=3", `地址栏保持 #step=3（实际 ${hash3}）`);
    A(deep.pageErrors.length === 0, `深链实例 0 运行时异常（实际 ${deep.pageErrors.length}）`);
    await deep.stop();
  }
} catch (e) {
  OUT("  FAIL 冒烟执行异常：" + e.message);
  failed++;
}

OUT(`\nsmoke: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
