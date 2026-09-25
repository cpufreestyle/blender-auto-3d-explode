// 从生成库加载已拆解模型（models/generated/）（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「生成库」块：#generated-select 选项经 fetch API_BASE
// /api/generated 填充（名称 + KB 体积；无数据或请求失败静默跳过），
// #generated-load 点击后拉取该 URL 并经 loadCustomModel 载入。
// showStatus / loadCustomModel 由 main.js 注入：loadCustomModel 是
// custom-model-loader 工厂实例方法，运行期才调用。
import { API_BASE } from "./config.js";

export function setupGeneratedLibrary({ showStatus, loadCustomModel }) {
  const generatedSelect = document.getElementById("generated-select");
  const generatedLoadBtn = document.getElementById("generated-load");
  if (generatedSelect && generatedLoadBtn) {
    fetch(`${API_BASE}/api/generated`)
      .then(r => r.json())
      .then(data => {
        if (!data.success || !data.files || !data.files.length) return;
        data.files.forEach(f => {
          const opt = document.createElement("option");
          opt.value = f.url;
          const kb = (f.size / 1024).toFixed(0);
          opt.textContent = `${f.name} (${kb} KB)`;
          generatedSelect.appendChild(opt);
        });
      })
      .catch(() => {
        /* 忽略：无生成库时不展示 */
      });

    generatedLoadBtn.addEventListener("click", async() => {
      const url = generatedSelect.value;
      if (!url) return;
      try {
        showStatus("📦 正在从生成库加载模型...", "info");
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("加载失败 " + resp.status);
        const buf = await resp.arrayBuffer();
        const name = decodeURIComponent(url.split("/").pop());
        loadCustomModel(buf, name, null);
      } catch (err) {
        showStatus("❌ 从生成库加载失败: " + err.message, "error");
      }
    });
  }
}
