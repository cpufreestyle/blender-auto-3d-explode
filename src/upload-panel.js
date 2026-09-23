// 文件上传与自定义模型加载（从 main.js 抽取，行为不变）。
//
// 原 main.js 的「文件上传与自定义模型」块：drop-zone / file-input 的事件绑定、
// 格式与体积校验、URDF / STL / GLB 三条派发，以及 tryBlenderSplit 这个
// 「XMLHttpRequest 上传取进度 + 二进制响应 + manifest 走 header」的长函数。
//
// 依赖注入方式与同目录的 ai-paint-panel.js 一致：
//   - showStatus：状态条 DOM 归 main.js 持有（十余处复用它写进度），这里只当回调用；
//   - customModelGroup / getCustomModelParts / loadCustomModel /
//     clearCustomModelGroup / finalizeCustomModelLoad / clearCustomModel：
//     main.js 的自定义模型生命周期，注入以避免反向依赖；
//   - API_BASE / base64ToUtf8 / loadURDFModel / loadSTLModel 是纯模块依赖，直接 import。
//
// 「DOM 未就绪时等 DOMContentLoaded」的门禁由 main.js 持有（与 setupAIPaint 一致），
// 本模块只负责拿到已就绪的 DOM 之后做什么。

import { API_BASE } from "./config.js";
import { base64ToUtf8 } from "./utils.js";
import { loadSTLModel, loadURDFModel } from "./model-loaders.js";

/**
 * 初始化文件上传。DOM 未就绪时会等 DOMContentLoaded，语义与 main.js 内联版一致。
 *
 * @param {object} deps
 * @param {(msg: string, type?: string) => void} deps.showStatus - 状态条回写（main.js 持有 DOM）
 * @param {object} deps.customModelGroup - 自定义模型的 three.js Group（const，不重赋值）
 * @param {() => Array} deps.getCustomModelParts - 自定义模型部件数组；main.js 里是 let、会被整体
 *   替换，必须每次调用现取，不能在建厂时拷一份引用
 * @param {(arrayBuffer: ArrayBuffer, fileName: string, manifest: object|null) => Promise} deps.loadCustomModel
 * @param {() => void} deps.clearCustomModelGroup
 * @param {(fileName: string, opts?: object) => void} deps.finalizeCustomModelLoad
 * @param {() => void} deps.clearCustomModel
 */
export function setupUpload({
  showStatus,
  customModelGroup,
  getCustomModelParts,
  loadCustomModel,
  clearCustomModelGroup,
  finalizeCustomModelLoad,
  clearCustomModel,
}) {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const uploadBtn = document.getElementById("upload-btn");
  const clearBtn = document.getElementById("clear-model-btn");

  console.log("Upload elements:", { dropZone, fileInput, uploadBtn, clearBtn });

  // 如果找不到上传相关元素，跳过上传功能
  if (!uploadBtn || !fileInput || !dropZone) {
    console.warn("上传功能所需元素未找到，跳过上传功能初始化");
    return;
  }

  // ── Blender 后端配置（从 src/config.js 统一读取） ──
  const BLENDER_SERVER = API_BASE;

  /**
     * 尝试调用 Blender 后端拆解 GLB
     * 改进：使用 XMLHttpRequest 获取上传进度 + 二进制响应（不再 base64）
     * @param {File} file 上传的 GLB/GLTF 文件
     * @returns {Promise<{arrayBuffer: ArrayBuffer, manifest: object} | null>}
     */
  function tryBlenderSplit(file) {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append("file", file);

      showStatus("🔧 正在通过 Blender 拆解模型... (上传中)", "info");

      // 上传进度
      xhr.upload.addEventListener("progress", e => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          if (pct < 100) {
            showStatus(
              `📤 上传中... ${pct}% (${(e.loaded / 1024).toFixed(0)} / ${(e.total / 1024).toFixed(0)} KB)`,
              "info",
            );
          } else {
            showStatus("🔧 Blender 正在拆解模型... (已上传，等待后端处理)", "info");
          }
        }
      });

      // 下载进度：Blender 边生成边返回时，进度条会随响应体增长而推进，
      // 避免长耗时（数十秒）时用户误以为卡死。
      xhr.addEventListener("progress", e => {
        if (e.lengthComputable && e.total > 0) {
          const pct = Math.round((e.loaded / e.total) * 100);
          showStatus(`⏳ Blender 拆解中... ${pct}%`, "info");
        } else if (e.loaded > 0) {
          // 无 Content-Length 时（分块流式），仅显示已接收大小
          showStatus(
            `⏳ Blender 拆解中... 已接收 ${(e.loaded / 1024 / 1024).toFixed(1)} MB`,
            "info",
          );
        }
      });

      xhr.addEventListener("load", () => {
        try {
          if (xhr.status !== 200) {
            // 错误响应是 JSON
            const errData = JSON.parse(xhr.responseText || "{}");
            throw new Error(errData.error || `服务器错误 ${xhr.status}`);
          }

          // 检查是否是二进制响应（成功）
          const successHeader = xhr.getResponseHeader("X-Success");
          if (successHeader !== "true") {
            // 可能是旧的 JSON 格式，尝试解析
            const data = JSON.parse(xhr.responseText);
            if (!data.success) {
              throw new Error(data.error || "拆解失败");
            }
            // 兼容旧格式（base64）
            const binaryStr = atob(data.glb_base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            showStatus(
              `✅ Blender 拆解完成：${data.total_parts} 个部件 (${data.elapsed_seconds}s)`,
              "success",
            );
            resolve({ arrayBuffer: bytes.buffer, manifest: data });
            return;
          }

          // 新格式：二进制 GLB body + manifest 在 header
          const totalParts = parseInt(xhr.getResponseHeader("X-Total-Parts") || "0");
          const elapsedSeconds = parseFloat(xhr.getResponseHeader("X-Elapsed-Seconds") || "0");
          const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";

          // 解析 manifest（base64 → UTF-8 JSON，正确处理中文）
          let manifest = null;
          if (manifestBase64) {
            const manifestJson = base64ToUtf8(manifestBase64);
            manifest = JSON.parse(manifestJson);
          } else {
            throw new Error("响应中缺少 manifest 头");
          }

          showStatus(`✅ Blender 拆解完成：${totalParts} 个部件 (${elapsedSeconds}s)`, "success");

          resolve({
            arrayBuffer: xhr.response,
            manifest,
          });
        } catch (err) {
          console.error("Blender 响应解析失败:", err);
          showStatus(`⚠️ Blender 响应解析失败，回退到 JS 拆解：${err.message || err}`, "warn");
          resolve(null);
        }
      });

      xhr.addEventListener("error", () => {
        console.warn("Blender 后端不可用，回退到 JS 拆解: 网络错误");
        resolve(null);
      });

      xhr.addEventListener("timeout", () => {
        console.warn("Blender 后端超时，回退到 JS 拆解");
        resolve(null);
      });

      xhr.responseType = "arraybuffer";
      xhr.timeout = 600000; // 10 分钟
      xhr.open("POST", `${BLENDER_SERVER}/api/split`);
      xhr.send(formData);
    });
  }

  async function handleFile(file) {
    if (!file) return;

    const ext = file.name.split(".").pop().toLowerCase();
    if (!["glb", "gltf", "stl", "urdf", "obj"].includes(ext)) {
      showStatus("❌ 不支持的文件格式\n请上传 .glb / .gltf / .stl / .urdf / .obj 文件", "error");
      return;
    }

    if (file.size > 150 * 1024 * 1024) {
      showStatus("❌ 文件太大\n请上传小于 150MB 的文件", "error");
      return;
    }

    // URDF 文件：前端解析 XML 结构
    if (ext === "urdf") {
      showStatus("📦 正在解析 URDF 文件...", "info");
      const reader = new FileReader();
      reader.onload = e => {
        loadURDFModel(e.target.result, file.name, {
          showStatus,
          clearCustomModelGroup,
          finalizeCustomModelLoad,
          customModelGroup,
          customModelParts: getCustomModelParts(),
        });
      };
      reader.onerror = () => showStatus("❌ 读取文件失败", "error");
      reader.readAsText(file);
      return;
    }

    // STL 文件：前端 STLLoader 加载，或送 Blender 拆解
    if (ext === "stl") {
      // 优先尝试 Blender 后端拆解
      const blenderResult = await tryBlenderSplit(file);
      if (blenderResult) {
        loadCustomModel(blenderResult.arrayBuffer, file.name, blenderResult.manifest);
        return;
      }
      // 回退：前端 STLLoader 直接加载（单部件）
      showStatus("⏳ 正在用前端加载 STL 模型...", "info");
      const reader = new FileReader();
      reader.onload = e => {
        loadSTLModel(e.target.result, file.name, {
          showStatus,
          clearCustomModelGroup,
          finalizeCustomModelLoad,
          customModelGroup,
          customModelParts: getCustomModelParts(),
        });
      };
      reader.onerror = () => showStatus("❌ 读取文件失败", "error");
      reader.readAsArrayBuffer(file);
      return;
    }

    // GLB / GLTF / OBJ 文件：优先尝试 Blender 后端拆解（包括 Quest 3 模型）
    const blenderResult = await tryBlenderSplit(file);

    if (blenderResult) {
      // Blender 拆解成功，使用拆解后的 GLB + 清单
      loadCustomModel(blenderResult.arrayBuffer, file.name, blenderResult.manifest);
      return;
    }

    // 回退：读取文件用 JS 拆解（包括 Quest 3 面级别切割）
    showStatus("⏳ 正在用前端 JS 拆解模型...", "info");

    const reader = new FileReader();
    reader.onload = e => {
      loadCustomModel(e.target.result, file.name, null);
    };
    reader.onerror = () => showStatus("❌ 读取文件失败", "error");
    reader.readAsArrayBuffer(file);
  }

  // 点击上传按钮
  uploadBtn.addEventListener("click", () => fileInput.click());

  // 文件选择
  fileInput.addEventListener("change", e => {
    handleFile(e.target.files[0]);
    e.target.value = ""; // 重置 input
  });

  // 拖拽上传
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    dropZone.style.borderColor = "#4a9eff";
    dropZone.style.background = "rgba(74, 158, 255, 0.1)";
  });

  dropZone.addEventListener("dragleave", e => {
    e.preventDefault();
    dropZone.style.borderColor = "";
    dropZone.style.background = "";
  });

  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.style.borderColor = "";
    dropZone.style.background = "";
    const file = e.dataTransfer.files[0];
    handleFile(file);
  });

  // 清除自定义模型
  if (clearBtn) {
    clearBtn.addEventListener("click", clearCustomModel);
  }

  console.log("文件上传功能已启用");
}
