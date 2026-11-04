// 从生成库加载已拆解模型（models/generated/）（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「生成库」块：#generated-select 选项经 fetch API_BASE
// /api/generated 填充（名称 + KB 体积；无数据或请求失败静默跳过），
// #generated-load 点击后拉取该 URL 并经 loadCustomModel 载入。
// showStatus / loadCustomModel 由 main.js 注入：loadCustomModel 是
// custom-model-loader 工厂实例方法，运行期才调用。
import { API_BASE } from "./config.js";
import { fetchArrayBufferWithProgress, formatProgressText } from "./model-progress.js";

// 模型下载进行中去重（model-viewer CachingGLTFLoader 的 in-flight promise 模式）：
// 同一 URL 的并发点击共享同一个下载 Promise，成功后保留 ArrayBuffer 供再次
// 加载直接复用，失败则从缓存清除，保证重试路径不被旧错误卡死。
const modelBufferCache = new Map();
const inFlightDownloads = new Map();

/** 清空生成库模型下载缓存（页面级测试或切换模型来源时使用）。 */
export function clearGeneratedModelCache() {
  modelBufferCache.clear();
  inFlightDownloads.clear();
}

function fetchModelBuffer(url, { onProgress } = {}) {
  if (modelBufferCache.has(url)) return Promise.resolve(modelBufferCache.get(url));
  if (inFlightDownloads.has(url)) return inFlightDownloads.get(url);

  const download = fetchArrayBufferWithProgress(url, { onProgress })
    .then(buf => {
      modelBufferCache.set(url, buf);
      return buf;
    })
    .finally(() => inFlightDownloads.delete(url));

  inFlightDownloads.set(url, download);
  return download;
}

function formatBytes(sizeInBytes) {
  return (sizeInBytes / 1024).toFixed(0);
}

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
          const kb = formatBytes(f.size);
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
        const buf = await fetchModelBuffer(url, {
          onProgress: ({ loaded, total }) =>
            showStatus(
              `📦 正在从生成库加载模型... ${formatProgressText({ loaded, total })}`,
              "info",
            ),
        });
        const name = decodeURIComponent(url.split("/").pop());
        loadCustomModel(buf, name, null);
      } catch (err) {
        showStatus("❌ 从生成库加载失败: " + err.message, "error");
      }
    });
  }
}
