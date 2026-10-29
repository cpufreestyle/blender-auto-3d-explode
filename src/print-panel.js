// 3D 打印面板：可打印性预检 + 逐部件 STL 导出（UI 接线层）
//
// 背景：print-analyze.js 回答问题「能不能打」，print-export.js 把答案变成
// 切片软件能吃的文件，但两者此前都没有入口——用户得自己在 devtools 里调。
// 本模块只做接线：取当前部件 → 跑分析 → 渲染结果表格 → 点导出时逐部件落盘。
//
// 设计取舍：
//   · 部件来源与导出面板同源（hasCustomModel ? customModelParts : parts），
//     经 getState() 惰性读，避免闭包把切换模型前的旧数组钉死；
//   · 结果表格直接渲染进 #print-result（.status-box 的姐妹节点），
//     复用 asm-* 视觉语言（评分徽章 / 明细表 / 建议列表）而不是另起炉灶；
//   · 多文件下载逐个触发：浏览器对连续 programmatic click 的容忍度远高于
//     「一次点十次」，所以分批之间让出一个宏任务，避免前几个 download 被吞；
//   · 分析是同步纯计算（10 个部件以内毫秒级），不需要 loading 态；导出要
//     生成 STL 二进制，仍然同步，但用按钮 disabled 防重复点击。
//
// 依赖注入：analyze / exportModelSTL 可被测试替换，Node 里跑不了真 three 几何
// 的用例因此不必起浏览器。triggerDownload 同样可注入，测试只断言「下载了几次、
// 文件名是什么」。

import { analyzePrintability } from "./print-analyze.js";
import { exportModelSTL } from "./print-export.js";

export function createPrintPanel({
  getState,
  analyze = analyzePrintability,
  exportModelSTL: exportModel = exportModelSTL,
  triggerDownload = null,
  showToast = null,
  root = null,
}) {
  const host = root || (typeof document !== "undefined" ? document : null);

  const getEl = id => (host && host.getElementById ? host.getElementById(id) : null);

  // 与 export-panel 同步 toast：注入缺失时退化成 console，绝不上抛
  // （面板按钮在 Blender 未就绪等场景也要能点，点了要能看到反馈）
  const toast = (msg, type = "info") => {
    if (typeof showToast === "function") showToast(msg, type);
    else console.log(`[print] ${type}: ${msg}`);
  };

  const download = (buffer, filename) => {
    if (typeof triggerDownload === "function") {
      triggerDownload(buffer, filename);
      return;
    }
    const blob = new Blob([buffer], { type: "model/stl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const currentParts = () => {
    const s = getState() || {};
    const list = s.hasCustomModel ? s.customModelParts : s.parts;
    return Array.isArray(list) ? list : [];
  };

  // 部件名要进 innerHTML 表格：自定义模型的部件名来自文件名，含 < > 的概率
  // 不为零（"模型 <v2>.glb"），必须转义，否则整块结果被浏览器吞掉。
  const esc = s =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function renderResult(result, err) {
    const el = getEl("print-result");
    if (!el) return;

    if (err) {
      el.classList.remove("hidden");
      el.className = "status-box error";
      el.textContent = "⚠️ 预检失败：" + err.message;
      return;
    }

    el.classList.remove("hidden");
    el.className = "status-box info";

    if (!result.parts.length) {
      el.textContent = "⚠️ 当前没有可分析的部件";
      return;
    }

    const s = result.summary;
    const color = s.ready ? "#2e7d32" : s.problematic > 0 ? "#c62828" : "#f9a825";
    const level = s.ready ? "可直接切片" : s.problematic + " 个部件有问题";

    const rows = result.parts
      .map(p => {
        const status = p.issues.length === 0 ? "✅" : "⚠️";
        const size = p.sizeMm.map(d => Math.round(d)).join(" × ");
        const vol = p.volumeMm3 >= 1000 ? (p.volumeMm3 / 1000).toFixed(1) + " cm³" : p.volumeMm3 + " mm³";
        const detail = p.issues.length
          ? p.issues.map(i => `<li>${esc(i)}</li>`).join("")
          : "<li>水密、无退化面、构建体积内</li>";
        return `<tr>
          <td>${status} ${esc(p.name)}</td>
          <td>${size}</td>
          <td>${vol}</td>
          <td>${p.triangles}</td>
          <td><ul class="print-issues">${detail}</ul></td>
        </tr>`;
      })
      .join("");

    el.innerHTML = `
      <div class="print-summary">
        <div class="print-badge" style="border-color:${color};color:${color}">${s.ready ? "✓" : "!"}</div>
        <div class="print-summary-meta">
          <div>可打印性预检 <strong style="color:${color}">${esc(level)}</strong></div>
          <div class="asm-sub">${s.total} 个部件 ｜ ${s.watertight} 个合格 ｜ ${s.problematic} 个待修
            ｜ ${s.totalTriangles} 三角形 ｜ 目标机 ${esc(result.buildLabel)}</div>
        </div>
      </div>
      <table class="asm-table print-table">
        <tr><th>部件</th><th>尺寸 (mm)</th><th>体积</th><th>三角面</th><th>问题</th></tr>
        ${rows}
      </table>
      <div class="asm-rec-title">说明</div>
      <ul class="asm-rec">
        <li>体积按散度定理估算，非水密部件仅供参考；用料以切片软件为准。</li>
        <li>预检只报告不修复：开放边 / 非流形边请用 Blender 3D-Print Toolbox 修补。</li>
      </ul>
    `;
  }

  function runCheck() {
    const parts = currentParts();
    if (!parts.length) {
      toast("❌ 当前没有可分析的部件", "error");
      return;
    }
    try {
      const buildKey = buildVolumeKey();
      const result = analyze(parts, { buildVolume: buildKey });
      renderResult(result, null);
      const s = result.summary;
      toast(
        s.ready
          ? `✅ ${s.total} 个部件均可打印`
          : `⚠️ ${s.problematic} / ${s.total} 个部件需要处理`,
        s.ready ? "success" : "info",
      );
    } catch (err) {
      renderResult(null, err);
      toast("❌ 预检失败：" + err.message, "error");
    }
  }

  function buildVolumeKey() {
    const sel = getEl("print-build-volume");
    return sel && sel.value ? sel.value : undefined;
  }

  // 逐部件下载。连续 programmatic click 会被部分浏览器合并/吞掉，所以每两个
  // 之间让出一个宏任务；部件数通常 < 20，这点延迟用户感知不到。
  function runExport() {
    const parts = currentParts();
    if (!parts.length) {
      toast("❌ 当前没有可导出的部件", "error");
      return;
    }
    const btn = getEl("print-stl-btn");
    if (btn) btn.disabled = true;
    try {
      const results = exportModel(parts, { buildVolume: buildVolumeKey() });
      if (!results.length) {
        if (btn) btn.disabled = false;
        toast("❌ 没有可导出的部件（几何体为空？）", "error");
        return;
      }
      let i = 0;
      const step = () => {
        if (i >= results.length) {
          if (btn) btn.disabled = false;
          const plates = results.plateCount;
          toast(
            plates > 1
              ? `🖨️ 已导出 ${results.length} 个 STL（自动拼成 ${plates} 块板，文件名 Bxx 开头按板分组）`
              : `🖨️ 已导出 ${results.length} 个 STL 文件`,
            "success",
          );
          return;
        }
        const r = results[i++];
        download(r.buffer, r.filename);
        setTimeout(step, 0);
      };
      step();
    } catch (err) {
      if (btn) btn.disabled = false;
      toast("❌ STL 导出失败：" + err.message, "error");
    }
  }

  const checkBtn = getEl("print-check-btn");
  if (checkBtn) checkBtn.addEventListener("click", runCheck);
  const stlBtn = getEl("print-stl-btn");
  if (stlBtn) stlBtn.addEventListener("click", runExport);
  const volumeSel = getEl("print-build-volume");
  if (volumeSel) volumeSel.addEventListener("change", runCheck);

  return { runCheck, runExport, renderResult };
}
