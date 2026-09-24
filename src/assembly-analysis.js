// Blender MCP 装配顺序对接与自定义模型步骤生成（从 main.js 抽取，行为不变）。
//
// 搬迁原 main.js「Blender MCP 装配顺序对接」整段：
//   - fetchAssemblySequenceOrder：拉取后端（server.js -> Blender MCP addon）的装配顺序；
//   - maybeApplyAssemblySequence：顺序与当前部件重叠足够时改写 stepGroups/totalSteps，
//     刷新步骤 UI、展开装配面板并触发可制造性分析；
//   - runAssemblyAnalysis：在「装配分析」面板渲染评分 / 等级 / 扣分明细 / 建议；
//   - generateCustomStepGroups：按 computeStepGroupCount 分组，生成欢迎 / 分组拆解 /
//     完成三步文字模板（纯函数，仅读 assemblySequenceOrder）。
//
// 状态归属同样分三类：
//   - hasCustomModel / customModelParts / assemblySequenceOrder / stepGroups /
//     totalSteps / currentStep 是被 main.js 多处重赋值的共享状态，经 s.* 惰性读
//     getState()、写立即回落 setState({ key })；
//   - updateStepUI 钩子替代原 explodeCtl.updateStepUI 调用（保留 typeof 守卫，
//     含控制器尚未就绪时的容错）；
//   - showStatus 轻提示由 main.js 注入；fetch 与 DOM 按原样使用。
//

import { API_BASE } from "./config.js";
import { computeStepGroupCount, sortPartsForDisassembly } from "./utils.js";

// 与 main.js 约定的共享状态键集合：s.* 读取走 getState()，写入走 setState({ key: value })
const SHARED_STATE_KEYS = [
  "hasCustomModel",
  "customModelParts",
  "assemblySequenceOrder",
  "stepGroups",
  "totalSteps",
  "currentStep",
];

/**
 * 创建装配顺序对接与步骤生成器。
 *
 * @param {object} deps
 * @param {() => object} deps.getState - 读共享状态，键见 SHARED_STATE_KEYS
 * @param {(patch: object) => void} deps.setState - 写共享状态，只接收含变动键的 patch
 * @param {(() => void)|null} deps.updateStepUI - 步骤 UI 刷新钩子（main.js 接 explodeCtl）
 * @param {(msg: string, type: string) => void} deps.showStatus - 轻提示
 */
export function createAssemblyAnalysis({
  getState,
  setState,
  updateStepUI,
  showStatus,
}) {
  // 共享状态响应式视图：读时现取、写时立即回写，等价于直接操作 main.js 的那些 let
  const s = {};
  for (const key of SHARED_STATE_KEYS) {
    Object.defineProperty(s, key, {
      get: () => getState()[key],
      set: value => setState({ [key]: value }),
      enumerable: true,
    });
  }


  /**
 * 从后端（server.js -> Blender MCP addon）拉取装配拆解顺序。
 * @param {string} method distance|size|hierarchy
 * @returns {Promise<string[]|null>} 部件名称数组；不可用时返回 null
 */
  async function fetchAssemblySequenceOrder(method = "distance") {
    try {
      const url = `${API_BASE}/api/assembly/sequence?method=${encodeURIComponent(method)}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data && data.success && Array.isArray(data.order) && data.order.length) {
        return data.order;
      }
    } catch {
    /* 后端或 Blender 未就绪，静默回退 */
    }
    return null;
  }

  /**
 * 尝试用 Blender 装配分析结果优化当前自定义模型的拆解步骤。
 * 仅当返回顺序与当前部件名称有足够重叠（判定为同一模型）时才应用。
 * 非阻塞：失败时保持原有距离排序。
 * @param {string} fileName 当前模型文件名（用于重建步骤）
 */
  async function maybeApplyAssemblySequence(fileName) {
    if (!s.hasCustomModel || !s.customModelParts.length) return;
    const order = await fetchAssemblySequenceOrder();
    if (!order || !order.length) return;

    // 校验：Blender 场景中的部件名称需与前端模型有足够重叠
    const names = new Set(s.customModelParts.map(p => p.name));
    const overlap = order.filter(n => names.has(n));
    if (overlap.length < 2) return; // 判定为不同模型，跳过

    s.assemblySequenceOrder = order;
    s.stepGroups = generateCustomStepGroups(s.customModelParts, fileName);
    s.totalSteps = s.stepGroups.length;
    if (s.currentStep >= s.totalSteps) s.currentStep = s.totalSteps - 1;
    if (typeof updateStepUI === "function") updateStepUI();
    showStatus(`🔧 已根据 Blender 装配分析优化拆解顺序（匹配 ${overlap.length} 个部件）`, "success");

    // 同一份 Blender 数据可用：自动拉取可制造性评分并展开面板
    const panel = document.getElementById("assembly-panel");
    if (panel && typeof panel.open !== "undefined") panel.open = true;
    runAssemblyAnalysis();
  }

  /**
 * 调用后端装配分析接口，在「装配分析」面板展示可制造性评分（0-100）、
 * 等级、扣分明细与建议。Blender/后端不可用时给出友好提示。
 */
  async function runAssemblyAnalysis() {
    const btn = document.getElementById("assembly-analyze-btn");
    const resultEl = document.getElementById("assembly-result");
    if (!resultEl) return;

    if (btn) btn.disabled = true;
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = "⏳ 正在分析…（需 Blender 后端运行）";

    try {
      const resp = await fetch("/api/assembly/analysis");
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success) {
        resultEl.innerHTML =
        `⚠️ 装配分析不可用：<br>${data.error || resp.status}<br><br>` +
        "请确认 Blender 已启动且 MCP addon 已连接（侧栏 BlenderMCP → Connect to MCP server）。";
        return;
      }

      const pr = data.production_readiness || {};
      const score = typeof pr.score === "number" ? pr.score : null;
      const level = pr.level || "—";
      const color =
      score == null ? "#888" : score >= 80 ? "#2e7d32" : score >= 55 ? "#f9a825" : "#c62828";

      const recs =
      Array.isArray(pr.recommendations) && pr.recommendations.length ?
        pr.recommendations.map(r => `<li>${r}</li>`).join("") :
        "<li>无明显制造风险</li>";

      const bd = pr.breakdown || {};
      const bdRows = Object.keys(bd).length ?
        "<table class=\"asm-table\"><tr><th>扣分项</th><th>分值</th></tr>" +
        Object.entries(bd)
          .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
          .join("") +
        "</table>" :
        "";

      const counts =
      `部件数：${data.part_count ?? "—"} ｜ 干涉：${data.interference_count ?? "—"}` +
      ` ｜ 配合面：${data.interface_count ?? "—"}`;
      resultEl.innerHTML = `
      <div class="asm-score">
        <div class="asm-score-badge" style="border-color:${color};color:${color}">${score == null ? "—" : score}</div>
        <div class="asm-score-meta">
          <div>可制造性评分 <strong style="color:${color}">${level}</strong></div>
          <div class="asm-sub">${counts}</div>
        </div>
      </div>
      ${bdRows}
      <div class="asm-rec-title">改进建议</div>
      <ul class="asm-rec">${recs}</ul>
    `;
    } catch (e) {
      resultEl.innerHTML = `⚠️ 请求失败：${e.message}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 为自定义模型生成动态步骤
  function generateCustomStepGroups(customParts, fileName) {
    const partCount = customParts.length;
    const groupCount = computeStepGroupCount(partCount);

    const groups = [];

    // 步骤 0：欢迎
    groups.push({
      name: "👋 模型概览",
      parts: [],
      tools: [],
      description: `已加载模型：<strong>${fileName}</strong><br><br>
📦 检测到 <strong>${partCount}</strong> 个独立部件<br>
🤖 已自动完成拆分分析<br><br>
💡 点击"下一步"开始逐步拆解，或点击"爆炸视图"一键展开。`,
    });

    // 部件拆解排序：优先使用 Blender MCP 装配分析给出的顺序
    const sortedParts = sortPartsForDisassembly(customParts, s.assemblySequenceOrder);

    // 将部件分组到各步骤
    const partsPerGroup = Math.ceil(partCount / groupCount);
    for (let g = 0; g < groupCount; g++) {
      const groupParts = sortedParts.slice(g * partsPerGroup, (g + 1) * partsPerGroup);
      const partNames = groupParts.map(p => p.name);
      groups.push({
        name: `${g + 1}️⃣ 第 ${g + 1} 组部件`,
        parts: partNames,
        tools: ["🖱️ 鼠标拖拽旋转", "🔍 滚轮缩放观察"],
        description: `正在拆解第 ${g + 1} 组（共 ${groupCount} 组）<br><br>
📦 本组包含 ${groupParts.length} 个部件：<br>
${partNames.map(n => `• ${n}`).join("<br>")}<br><br>
💡 拖动旋转视角，仔细观察每个部件的细节。`,
      });
    }

    // 最后一步：完成
    groups.push({
      name: "🎉 拆解完成",
      parts: [],
      tools: [],
      description: `拆解完成！共展示 ${partCount} 个部件。<br><br>
💡 你可以：<br>
• 点击"爆炸视图"重新展开<br>
• 点击"重置"回到初始状态<br>
• 拖动"爆炸深度"滑块控制展开程度<br>
• 上传新的模型继续探索`,
    });

    return groups;
  }

  return {
    maybeApplyAssemblySequence,
    runAssemblyAnalysis,
    generateCustomStepGroups,
  };
}
