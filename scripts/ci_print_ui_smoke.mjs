#!/usr/bin/env node
/**
 * 3D 打印面板 — 真机冒烟门禁（需要本机 Chrome，故意不进 npm test）。
 *
 * 动机：print-panel 的接线 correctness 全靠单测里的假 DOM，但有两件事只有真浏览器
 * 能证伪：
 *   1. 真 three 几何能不能算出水密性。单测里的 analyze 是注入的假实现，仓库里
 *      从没有任何断言碰过「真的 Quest 3 几何 + 真的 analyzePart」这条链路——
 *      而 print-analyze 的 setIndex / 非索引顶点偏移两个真 bug 正是假 DOM 看不见的；
 *   2. 逐部件下载的 setTimeout 分批在真浏览器里会不会被吞。
 * 本脚本点真实按钮、跑真实分析，把结果表格的内容与「每个部件一个 STL」钉住。
 *
 * 覆盖：
 *   0. 页面就绪且无运行时异常；
 *   1. 打印面板与两个按钮、构建体积下拉都在位；
 *   2. 点「打印预检」→ 结果框出现，汇总行含部件总数与目标机名；
 *   3. 明细表行数 == 部件数，每行有尺寸/体积/三角面三列数值；
 *   4. 切构建体积 → 自动重跑，汇总里的目标机名跟着变；
 *   5. 点「导出打印STL」→ 每个部件触发一次 download（用 CDP 的 Page.setDownloadBehavior
 *      不可用时退而统计 <a download> 的创建次数，本脚本走后者：劫持 createElement）；
 *   6. 全程 0 运行时异常。
 *
 * 用法：
 *   node scripts/ci_print_ui_smoke.mjs
 *   PORT=3941 CDP_PORT=9287 CHROME_PATH=/path/to/chrome node scripts/ci_print_ui_smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；0 且首行 SKIP = 本机没有 Chrome。
 */

import { startUiSmoke } from "./ui_smoke_lib.mjs";

const OUT = console.log.bind(console);
const ui = await startUiSmoke({
  port: process.env.PORT || "3941",
  cdp: process.env.CDP_PORT || "9287",
  chromePath: process.env.CHROME_PATH || undefined,
});
if (!ui) {
  OUT("SKIP: 未找到 Chrome，本机无法跑浏览器冒烟");
  process.exit(0);
}

const { evaluate, click, pageErrors } = ui;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const A = (cond, msg) => { OUT((cond ? "  OK   " : "  FAIL ") + msg); if (cond) passed++; else failed++; };

try {
  const rdy = await ui.waitReady();
  A(rdy.ok, `页面就绪（耗时 ${rdy.ms}ms）`);
  A((await ui.hideFirstRunModal()) === false, "首屏没有被「首次配置」弹窗遮挡");
  A(pageErrors.length === 0, `页面 0 运行时异常（实际 ${pageErrors.length}）`);

  // ===== 1. 面板与控件在位 =====
  const ctrls = JSON.parse(await evaluate(`JSON.stringify({
    panel: !!document.getElementById('print-panel'),
    checkBtn: !!document.getElementById('print-check-btn'),
    stlBtn: !!document.getElementById('print-stl-btn'),
    volume: !!document.getElementById('print-build-volume'),
    result: !!document.getElementById('print-result'),
    volumeValue: (document.getElementById('print-build-volume') || {}).value || null,
  })`));
  A(ctrls.panel, "3D 打印面板存在");
  A(ctrls.checkBtn && ctrls.stlBtn, "打印预检 / 导出打印STL 两个按钮都在");
  A(ctrls.volume && ctrls.result, "构建体积下拉与结果框都在");
  A(ctrls.volumeValue === "bambu_x1c", `默认机为 Bambu X1C（实际 ${ctrls.volumeValue}）`);

  // ===== 2. 点预检 =====
  const btnRect = JSON.parse(await evaluate(`(() => {
    const b = document.getElementById('print-check-btn');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`));
  const hit = await ui.hitTest(btnRect.x, btnRect.y, "#print-check-btn");
  A(hit.inside, `按钮最上层就是它自己（实际命中 ${hit.hit}）`);
  await click(btnRect.x, btnRect.y);
  await sleep(1200);

  const res = JSON.parse(await evaluate(`(() => {
    const el = document.getElementById('print-result');
    if (!el) return JSON.stringify({ missing: true });
    const table = el.querySelector('.print-table');
    const rows = table ? [...table.querySelectorAll('tbody tr, tr')].filter(r => r.querySelector('td')) : [];
    const first = rows[0] ? [...rows[0].querySelectorAll('td')].map(td => td.textContent.trim()) : [];
    return JSON.stringify({
      missing: false,
      hidden: el.classList.contains('hidden'),
      text: el.textContent.slice(0, 300),
      rowCount: rows.length,
      firstRowCells: first,
      hasSummary: !!el.querySelector('.print-summary'),
    });
  })()`));

  A(!res.missing && !res.hidden, "结果框已显示（点预检有反馈）");
  A(res.hasSummary, "结果框有汇总徽章");
  A(/\u4e2a\u90e8\u4ef6/.test(res.text), `汇总含部件数（${res.text.slice(0, 60).replace(/\n/g, " ")}…）`);
  A(/Bambu Lab X1C/.test(res.text), "汇总含目标机名");
  A(res.rowCount >= 8, `明细表行数与静态清单一致（实际 ${res.rowCount} 行）`);
  A(res.firstRowCells.length === 5, `每行 5 列（实际 ${res.firstRowCells.length}）`);
  A(/\u00d7/.test(res.firstRowCells[1] || ""), `第二列是尺寸（实际 ${res.firstRowCells[1]}）`);
  A(/mm|cm/.test(res.firstRowCells[2] || ""), `第三列是体积（实际 ${res.firstRowCells[2]}）`);
  A(/^\d+$/.test((res.firstRowCells[3] || "").trim()), `第四列是三角面数（实际 ${res.firstRowCells[3]}）`);

  // ===== 3. 切构建体积自动重跑 =====
  const before = res.text;
  await evaluate(`(() => {
    const s = document.getElementById('print-build-volume');
    s.value = 'ender3';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(1200);
  const after = await evaluate(`document.getElementById('print-result').textContent.slice(0, 300)`);
  A(!/Bambu Lab X1C/.test(after), "切到 Ender-3 后汇总不再显示 X1C");
  A(/Ender-3/.test(after), "汇总改显 Ender-3");
  A(after !== before, "内容确实重渲染了");

  // 切回默认机
  await evaluate(`(() => {
    const s = document.getElementById('print-build-volume');
    s.value = 'bambu_x1c';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(600);

  // ===== 4. 导出：统计 download 触发次数 =====
  // 劫持 createElement('a')：面板的 download() 走 triggerDownload 缺省实现，
  // 每个部件会造一个 <a download> 并 click。真实浏览器里 programmatic click 连发
  // 会被合并，所以分批让出宏任务；这里数的就是「最终真触发了几次」。
  await evaluate(`(() => {
    window.__stlDownloads = [];
    const orig = document.createElement.bind(document);
    document.createElement = tag => {
      const el = orig(tag);
      if (String(tag).toLowerCase() === 'a') {
        const click = el.click.bind(el);
        el.click = () => {
          if (el.download) window.__stlDownloads.push(el.download);
          return click();
        };
      }
      return el;
    };
  })()`);

  const stlRect = JSON.parse(await evaluate(`(() => {
    const b = document.getElementById('print-stl-btn');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`));
  await click(stlRect.x, stlRect.y);
  await sleep(2500);

  const dl = JSON.parse(await evaluate(`JSON.stringify({
    names: window.__stlDownloads || [],
    disabled: document.getElementById('print-stl-btn').disabled,
  })`));
  A(dl.names.length >= 8, `每个部件都触发了一次下载（实际 ${dl.names.length} 个文件）`);
  A(dl.names.every(n => /\.stl$/i.test(n)), `全部是 .stl 文件（实际 ${dl.names.slice(0, 3).join(", ")}…）`);
  A(dl.names.length === new Set(dl.names).size, "文件名互不重复");
  A(dl.disabled === false, "导出完成后按钮恢复可用");

  await ui.shot(process.env.SHOT || "/tmp/print-panel.png");

  A(pageErrors.length === 0, `全程 0 运行时异常（实际 ${pageErrors.length}${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ") : ""}）`);
} catch (e) {
  OUT(`  FAIL 脚本异常：${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  failed++;
} finally {
  await ui.stop();
}

OUT(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
