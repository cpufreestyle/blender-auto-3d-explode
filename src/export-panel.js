/**
 * 导出与轻提示（截图 / 教案 Markdown / GLB / STL 3D 打印）——从 main.js 抽取，行为不变。
 *
 * 原 main.js 1826-2023 行的导出块：toast 提示、时间戳、下载入口、截图导出、教案导出
 * （Markdown 文件 + 剪贴板）、GLB 导出六个职能，外加四个按钮绑定；后续新增 STL
 * 3D 打印导出（整体 + 当前选中部件，二进制 STL）。
 *
 * 对主模块的依赖分两类，注入方式 deliberately 不同：
 *   - 稳定引用（const，不会重赋值）：renderer / scene / camera / questGroup /
 *     customModelGroup，按值传入即可；
 *   - 可变状态（let，会重赋值）：currentModelName / totalSteps / displayedStep /
 *     hasCustomModel / customModelParts / stepGroups / parts，统一经 getState()
 *     getter 读取，避免闭包把旧值钉死在导出那一刻。
 *
 * 另外从 main.js 顶部迁入 GLTFExporter 导入。对外暴露 showToast 与各导出函数，
 * 供 main.js 的键盘快捷键（s = 截图）与后续面板复用。
 */

import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

export function createExportPanel({
  renderer,
  scene,
  camera,
  questGroup,
  customModelGroup,
  getState,
  // 仅测试注入的缝：生产中恒为 three 的 GLTFExporter。GLTFExporter.parse 在 Node 里
  // 会卡在 FileReader/纹理路径上，假实现让 GLB 的成功/失败回调用例不依赖浏览器。
  GLTFExporterClass = GLTFExporter,
  // STL 同样走注入缝：STLExporter.parse 是同步调用，假实现驱动成功/抛错两条路径。
  STLExporterClass = STLExporter,
}) {
  // ===== 可变状态（原 main.js 的模块级 let，会随加载/清除自定义模型重赋值）=====
  // 不能在建厂时拷一份快照：按钮点击发生在模块求值之后，必须每次读最新值。
  let currentModelName;
  let totalSteps;
  let displayedStep;
  let hasCustomModel;
  let customModelParts;
  let stepGroups;
  let parts;
  let selectedPartName;

  function syncState() {
    const s = getState();
    currentModelName = s.currentModelName;
    totalSteps = s.totalSteps;
    displayedStep = s.displayedStep;
    hasCustomModel = s.hasCustomModel;
    customModelParts = s.customModelParts;
    stepGroups = s.stepGroups;
    parts = s.parts;
    selectedPartName = s.selectedPartName || null;
  }

  function getToastWrap() {
    let wrap = document.getElementById("toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "toast-wrap";
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function showToast(msg, type = "info") {
    const wrap = getToastWrap();
    // 主题跟随：亮色主题的 class 挂在 .ui-overlay 上，而 toast 挂在 body（避免被面板裁剪）
    const isLightTheme = !!document.querySelector(".ui-overlay.light-theme");
    const el = document.createElement("div");
    el.className = `toast toast-${type}${isLightTheme ? " toast-light" : ""}`;
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    // 最多同时保留 3 条，避免连续操作时堆积
    while (wrap.children.length > 3) wrap.firstElementChild.remove();
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 2200);
  }

  // 文件名安全的时间戳：20260918-095030
  function fileTimestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${date}-${time}`;
  }

  function triggerDownload(href, filename) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ===== 截图导出：当前拆解视图 → PNG =====
  function exportScreenshot() {
    syncState();
    try {
      // 必须在同一同步执行栈内 render() 后立刻取像素：
      // 未开启 preserveDrawingBuffer 时，缓冲区会在浏览器合成后被清空，晚取只能拿到空白图。
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL("image/png");
      triggerDownload(url, `${currentModelName}-拆解截图-${fileTimestamp()}.png`);
      showToast("🖼️ 截图已保存为 PNG", "success");
    } catch (err) {
      showToast("❌ 截图失败：" + err.message, "error");
    }
  }

  // ===== 教案导出：拆解方案 → Markdown（备课 / 教学资料）=====
  function stripTags(html) {
    return String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function buildLessonMarkdown() {
    syncState();
    const partsInModel = hasCustomModel ? customModelParts : parts;
    const lines = [
      `# ${currentModelName} · 拆解教学教案`,
      "",
      `> 导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
      `- 模型名称：${currentModelName}`,
      `- 拆解步骤：${totalSteps} 步`,
      `- 部件总数：${partsInModel.length}`,
      `- 导出时进度：步骤 ${displayedStep} / ${totalSteps}`,
      "",
      "## 拆解步骤",
      "",
    ];

    stepGroups.forEach((step, idx) => {
      lines.push(`### 步骤 ${idx + 1}：${stripTags(step.name)}`);
      lines.push("");
      const desc = stripTags(step.description);
      if (desc) {
        // 描述里的多行纯文本转成 Markdown 引用块，避免被折成一行
        lines.push(...desc.split("\n").map(l => (l.trim() ? `> ${l}` : ">")));
        lines.push("");
      }
      const stepParts = step.parts || [];
      lines.push(`- **涉及部件（${stepParts.length}）**：${stepParts.length ? stepParts.join("、") : "无（概览步骤）"}`);
      const tools = step.tools || [];
      lines.push(`- **所需工具**：${tools.length ? tools.map(stripTags).join("、") : "无需工具"}`);
      lines.push("");
    });

    // 工具清单汇总（跨步骤去重）
    const allTools = [];
    stepGroups.forEach(step =>
      (step.tools || []).forEach(t => {
        const name = stripTags(t);
        if (name && !allTools.includes(name)) allTools.push(name);
      }),
    );

    lines.push("## 工具清单汇总", "");
    if (allTools.length) allTools.forEach(t => lines.push(`- ${t}`));
    else lines.push("- 本拆解流程无需额外工具（纯观察教学）");
    lines.push("", "---", "", `_由 blender-auto-3d-explode 自动生成 · ${location.origin}_`);

    return lines.join("\n");
  }

  function exportLessonMarkdown() {
    syncState();
    try {
      const blob = new Blob([buildLessonMarkdown()], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `${currentModelName}-拆解教案.md`);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast("📄 教案已导出（Markdown）", "success");
    } catch (err) {
      showToast("❌ 导出失败：" + err.message, "error");
    }
  }

  // 复制教案到剪贴板：安全上下文用 Clipboard API，否则回退 execCommand
  function copyLessonMarkdown() {
    try {
      const text = buildLessonMarkdown();
      const ok = () => showToast("📋 教案已复制到剪贴板", "success");
      const fail = (msg) => showToast("❌ 复制失败：" + msg, "error");
      const fallback = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          const copied = document.execCommand && document.execCommand("copy");
          ta.remove();
          copied ? ok() : fail("浏览器不支持复制");
        } catch (e) {
          fail(e.message);
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok).catch(fallback);
      } else {
        fallback();
      }
    } catch (err) {
      showToast("❌ 复制失败：" + err.message, "error");
    }
  }

  // ===== GLB 导出：当前拆解状态 → 二进制 glTF =====
  function exportGLB() {
    syncState();
    try {
      const target = hasCustomModel ? customModelGroup : questGroup;
      if (!target || target.children.length === 0) {
        showToast("❌ 当前没有可导出的模型", "error");
        return;
      }
      const exporter = new GLTFExporterClass();
      exporter.parse(
        target,
        (result) => {
          const blob = new Blob([result], { type: "model/gltf-binary" });
          const url = URL.createObjectURL(blob);
          triggerDownload(url, `${currentModelName}-拆解步骤${displayedStep}-${fileTimestamp()}.glb`);
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          showToast("💾 GLB 已导出（当前拆解状态）", "success");
        },
        (err) => {
          showToast("❌ GLB 导出失败：" + (err && err.message ? err.message : err), "error");
        },
        { binary: true },
      );
    } catch (err) {
      showToast("❌ GLB 导出失败：" + err.message, "error");
    }
  }

  // ===== STL 导出（3D 打印）：二进制 STL =====
  // 导出的是当前显示状态：整体打印建议先把拆解滑块调回 0（合体）再导出；
  // AI 生成/照片转 3D 的网格常不水密，切片器需自行修复。
  function exportSTLWhole() {
    syncState();
    try {
      const target = hasCustomModel ? customModelGroup : questGroup;
      if (!target || target.children.length === 0) {
        showToast("❌ 当前没有可导出的模型", "error");
        return;
      }
      const exporter = new STLExporterClass();
      const data = exporter.parse(target, { binary: true });
      const blob = new Blob([data], { type: "model/stl" });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `${currentModelName}-拆解步骤${displayedStep}-${fileTimestamp()}.stl`);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast("🖨️ STL 已导出（当前拆解状态）", "success");
    } catch (err) {
      showToast("❌ STL 导出失败：" + err.message, "error");
    }
  }

  // 深度优先在组里按名字找部件网格：先精确匹配，找不到再退到包含匹配（部件清单的
  // 名字可能只是网格名的子串）。找到后把该对象直接交给 STLExporter.parse。
  function findPartMesh(root, name) {
    if (!root || !Array.isArray(root.children)) return null;
    let exact = null;
    let loose = null;
    const walk = (node) => {
      if (exact) return;
      for (const child of node.children) {
        if (child.name === name) {
          exact = child;
          return;
        }
        if (!loose && child.name && String(child.name).includes(name)) loose = child;
        if (child.children) walk(child);
      }
    };
    walk(root);
    return exact || loose;
  }

  // 导出当前选中/单独显示的部件（部件清单点击或 isolate 的那个）为二进制 STL
  function exportSTLPart() {
    syncState();
    try {
      if (!selectedPartName) {
        showToast("❌ 请先在部件清单中选中部件", "error");
        return;
      }
      const target = hasCustomModel ? customModelGroup : questGroup;
      const mesh = findPartMesh(target, selectedPartName);
      if (!mesh) {
        showToast(`❌ 未找到部件“${selectedPartName}”`, "error");
        return;
      }
      const exporter = new STLExporterClass();
      const data = exporter.parse(mesh, { binary: true });
      const blob = new Blob([data], { type: "model/stl" });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `${currentModelName}-部件${selectedPartName}-${fileTimestamp()}.stl`);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast(`🖨️ 部件 STL 已导出：${selectedPartName}`, "success");
    } catch (err) {
      showToast("❌ 部件 STL 导出失败：" + err.message, "error");
    }
  }

  const shotBtn = document.getElementById("shot-btn");
  if (shotBtn) shotBtn.addEventListener("click", exportScreenshot);
  const exportMdBtn = document.getElementById("export-md-btn");
  if (exportMdBtn) exportMdBtn.addEventListener("click", exportLessonMarkdown);
  const copyMdBtn = document.getElementById("copy-md-btn");
  if (copyMdBtn) copyMdBtn.addEventListener("click", copyLessonMarkdown);
  const exportGlbBtn = document.getElementById("export-glb-btn");
  if (exportGlbBtn) exportGlbBtn.addEventListener("click", exportGLB);
  const exportStlBtn = document.getElementById("export-stl-btn");
  if (exportStlBtn) exportStlBtn.addEventListener("click", exportSTLWhole);
  const exportStlPartBtn = document.getElementById("export-stl-part-btn");
  if (exportStlPartBtn) exportStlPartBtn.addEventListener("click", exportSTLPart);
  return {
    showToast,
    getToastWrap,
    fileTimestamp,
    triggerDownload,
    stripTags,
    buildLessonMarkdown,
    exportScreenshot,
    exportLessonMarkdown,
    copyLessonMarkdown,
    exportGLB,
    exportSTLWhole,
    exportSTLPart,
  };
}
