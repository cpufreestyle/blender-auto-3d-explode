// AI 绘画 / 图片转 3D 面板（从 main.js 抽取，L2 前端模块化）
// 仅依赖 DOM + fetch + 注入的共享函数（loadCustomModel / showStatus），无 3D 场景强耦合。
import { base64ToUtf8 } from "../utils.js";
import { fetchConfigAndHighlight } from "./config-panel.js";

// 后端 AI 服务地址（仅本面板使用）
const BLENDER_SERVER_AI = "http://localhost:3001";
// 存储已生成的模型 { id, prompt, arrayBuffer, manifest, icon, parts }
let aiPaintGallery = [];

export function setupAIPaint({ loadCustomModel, showStatus }) {
  const promptInput = document.getElementById("ai-paint-prompt");
  const paintBtn = document.getElementById("ai-paint-btn");
  const presetBtns = document.querySelectorAll(".chip");
  const statusEl = document.getElementById("ai-paint-status");
  const galleryEl = document.getElementById("ai-paint-gallery");

  // 图片上传相关元素
  const dropzone = document.getElementById("ai-paint-dropzone");
  const fileInput = document.getElementById("ai-paint-image");
  const dropzoneText = document.getElementById("ai-paint-dropzone-text");
  const imagePreview = document.getElementById("ai-paint-image-preview");
  const previewImg = document.getElementById("ai-paint-preview-img");
  const removeImgBtn = document.getElementById("ai-paint-remove-image");
  const imgTo3DBtn = document.getElementById("img-to-3d-btn");
  const imgTo3DDeploy = document.getElementById("img-to-3d-deploy");
  const imgTo3DModelLocal = document.getElementById("img-to-3d-model-local");
  const imgTo3DRemoveBg = document.getElementById("img-to-3d-remove-bg");
  const imgTo3DBake = document.getElementById("img-to-3d-bake");
  const imgTo3DModel = document.getElementById("img-to-3d-model");
  const imgTo3DModelCustom = document.getElementById("img-to-3d-model-custom");
  const textTo3DBtn = document.getElementById("text-to-3d-btn");
  const textTo3DMode = document.getElementById("text-to-3d-mode");

  // 当前上传的图片特征
  let uploadedImageFeatures = null;
  // 当前上传图片的 data URL（用于图片转 3D）
  let uploadedImageDataUrl = null;

  if (!promptInput || !paintBtn) {
    console.warn("AI 绘画元素未找到，跳过初始化");
    return;
  }

  function showAIStatus(msg, type = "info") {
    if (!statusEl) return;
    statusEl.innerHTML = msg;
    statusEl.className = "status-box " + type;
    statusEl.classList.remove("hidden");
  }

  function hideAIStatus() {
    if (statusEl) statusEl.classList.add("hidden");
  }

  // 获取提示词对应的图标
  function getPromptIcon(prompt) {
    const p = prompt.toLowerCase();
    if (p.includes("篮球") || p.includes("basketball")) return "🏀";
    if (p.includes("quest") || p.includes("vr") || p.includes("头显")) return "🕶️";
    if (p.includes("机器人") || p.includes("robot")) return "🤖";
    if (p.includes("汽车") || p.includes("车") || p.includes("car")) return "🚗";
    if (p.includes("房子") || p.includes("house")) return "🏠";
    if (p.includes("人") || p.includes("角色") || p.includes("character")) return "🧑";
    if (p.includes("火箭") || p.includes("rocket")) return "🚀";
    if (p.includes("球") || p.includes("sphere") || p.includes("ball")) return "🔴";
    return "🎨";
  }

  // ========== 图片特征提取 ==========
  // 从图片中提取主色调、明暗、宽高比、圆度等特征
  function extractImageFeatures(imgElement) {
    return new Promise(resolve => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const SAMPLE_SIZE = 100; // 缩小采样以加速

      // 计算缩放比例
      const scale = Math.min(
        SAMPLE_SIZE / imgElement.naturalWidth,
        SAMPLE_SIZE / imgElement.naturalHeight,
      );
      const w = Math.max(1, Math.round(imgElement.naturalWidth * scale));
      const h = Math.max(1, Math.round(imgElement.naturalHeight * scale));

      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(imgElement, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      // 颜色量化与统计
      const colorMap = new Map();
      let totalR = 0,
        totalG = 0,
        totalB = 0;
      let pixelCount = 0;
      let brightPixels = 0;
      let darkPixels = 0;
      let edgePixels = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 128) continue; // 跳过透明像素

        totalR += r;
        totalG += g;
        totalB += b;
        pixelCount++;

        // 亮度判断
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 180) brightPixels++;
        if (lum < 60) darkPixels++;

        // 量化颜色（每个通道分8档）
        const qr = Math.round(r / 32) * 32;
        const qg = Math.round(g / 32) * 32;
        const qb = Math.round(b / 32) * 32;
        const key = `${qr},${qg},${qb}`;
        colorMap.set(key, (colorMap.get(key) || 0) + 1);
      }

      if (pixelCount === 0) {
        resolve(null);
        return;
      }

      // 平均色
      const avgR = Math.round(totalR / pixelCount);
      const avgG = Math.round(totalG / pixelCount);
      const avgB = Math.round(totalB / pixelCount);
      const avgLum = (0.299 * avgR + 0.587 * avgG + 0.114 * avgB) / 255;

      // 提取前5个主色
      const sortedColors = [...colorMap.entries()].sort((a, b) => b[1] - a[1]);
      const dominantColors = sortedColors.slice(0, 5).map(([key, count]) => {
        const [r, g, b] = key.split(",").map(Number);
        return { r, g, b, ratio: count / pixelCount };
      });

      // 边缘检测（简单 Sobel）
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = (y * w + x) * 4;
          const idxRight = (y * w + (x + 1)) * 4;
          const idxDown = ((y + 1) * w + x) * 4;
          const lumC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          const lumR =
            0.299 * data[idxRight] + 0.587 * data[idxRight + 1] + 0.114 * data[idxRight + 2];
          const lumD =
            0.299 * data[idxDown] + 0.587 * data[idxDown + 1] + 0.114 * data[idxDown + 2];
          if (Math.abs(lumC - lumR) > 30 || Math.abs(lumC - lumD) > 30) {
            edgePixels++;
          }
        }
      }
      const edgeRatio = edgePixels / (w * h);

      // 判断整体色调
      let mood = "neutral";
      if (avgLum > 0.7) mood = "bright";
      else if (avgLum < 0.3) mood = "dark";
      if (avgR > avgG + 30 && avgR > avgB + 30) mood = "warm";
      if (avgB > avgR + 20 && avgB > avgG) mood = "cool";
      if (avgG > avgR + 20 && avgG > avgB + 10) mood = "natural";

      // 宽高比
      const aspectRatio = imgElement.naturalWidth / imgElement.naturalHeight;

      // 是否对称（左右翻转差异大说明不对称）
      let symScore = 0;
      const halfW = Math.floor(w / 2);
      let symCount = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < halfW; x += 2) {
          const idxL = (y * w + x) * 4;
          const idxR = (y * w + (w - 1 - x)) * 4;
          const diff =
            Math.abs(data[idxL] - data[idxR]) +
            Math.abs(data[idxL + 1] - data[idxR + 1]) +
            Math.abs(data[idxL + 2] - data[idxR + 2]);
          if (diff < 30) symScore++;
          symCount++;
        }
      }
      const symmetry = symCount > 0 ? symScore / symCount : 0;

      const features = {
        dominantColors: dominantColors.map(c => ({
          r: c.r,
          g: c.g,
          b: c.b,
          ratio: parseFloat(c.ratio.toFixed(3)),
        })),
        avgColor: { r: avgR, g: avgG, b: avgB },
        avgLuminance: parseFloat(avgLum.toFixed(3)),
        mood,
        aspectRatio: parseFloat(aspectRatio.toFixed(2)),
        edgeDensity: parseFloat(edgeRatio.toFixed(3)),
        symmetry: parseFloat(symmetry.toFixed(3)),
        brightRatio: parseFloat((brightPixels / pixelCount).toFixed(3)),
        darkRatio: parseFloat((darkPixels / pixelCount).toFixed(3)),
        width: imgElement.naturalWidth,
        height: imgElement.naturalHeight,
      };

      console.log("🎨 图片特征提取:", features);
      resolve(features);
    });
  }

  // 处理图片文件
  async function handleImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      showAIStatus("❌ 请上传图片文件", "error");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showAIStatus("❌ 图片不能超过 10MB", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = async e => {
      const dataUrl = e.target.result;
      previewImg.src = dataUrl;
      uploadedImageDataUrl = dataUrl;
      imagePreview.classList.remove("hidden");
      dropzoneText.textContent = `已上传: ${file.name}`;

      // 创建 Image 对象提取特征
      const img = new Image();
      img.onload = async() => {
        uploadedImageFeatures = await extractImageFeatures(img);
        if (uploadedImageFeatures) {
          const colorSwatches = uploadedImageFeatures.dominantColors
            .map(
              c =>
                `<span class="ai-paint-color-swatch" style="background:rgb(${c.r},${c.g},${c.b})" title="rgb(${c.r},${c.g},${c.b}) ${(c.ratio * 100).toFixed(0)}%"></span>`,
            )
            .join("");
          showAIStatus(
            `🖼️ 已提取图片特征: ${uploadedImageFeatures.mood}色调 · 对称度${(uploadedImageFeatures.symmetry * 100).toFixed(0)}% · 边缘密度${(uploadedImageFeatures.edgeDensity * 100).toFixed(0)}%<div class="ai-paint-color-swatches">${colorSwatches}</div>`,
            "info",
          );
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  // 清除已上传图片
  function clearUploadedImage() {
    uploadedImageFeatures = null;
    uploadedImageDataUrl = null;
    previewImg.removeAttribute("src");
    imagePreview.classList.add("hidden");
    dropzoneText.textContent = "上传参考图片（可选）— 提取颜色和形状特征";
    if (fileInput) fileInput.value = "";
  }

  // 绑定图片上传事件
  if (dropzone && fileInput) {
    // 点击上传
    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", e => {
      if (e.target.files && e.target.files[0]) {
        handleImageFile(e.target.files[0]);
      }
    });

    // 拖拽上传
    dropzone.addEventListener("dragover", e => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });
    dropzone.addEventListener("drop", e => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleImageFile(e.dataTransfer.files[0]);
      }
    });
  }

  // 清除图片按钮
  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", e => {
      e.stopPropagation();
      clearUploadedImage();
    });
  }

  // 图片转 3D 按钮
  if (imgTo3DBtn) {
    imgTo3DBtn.addEventListener("click", () => imageTo3D());
  }

  // 部署方式：本地显示本地模型下拉，Replicate 显示云端模型下拉，其余云厂商走配置里的 Key
  function refreshTo3DControls() {
    const deploy = imgTo3DDeploy ? imgTo3DDeploy.value : "local";
    const isLocal = deploy === "local";
    const isReplicate = deploy === "replicate";
    if (imgTo3DModelLocal) imgTo3DModelLocal.classList.toggle("hidden", !isLocal);
    if (imgTo3DModel) imgTo3DModel.classList.toggle("hidden", !isReplicate);
    if (imgTo3DModelCustom) imgTo3DModelCustom.classList.add("hidden");
  }
  if (imgTo3DDeploy) {
    imgTo3DDeploy.addEventListener("change", refreshTo3DControls);
  }
  if (imgTo3DModel) {
    imgTo3DModel.addEventListener("change", () => {
      const isCustom = imgTo3DModel.value === "__custom__";
      if (imgTo3DModelCustom) imgTo3DModelCustom.classList.toggle("hidden", !isCustom);
    });
  }
  refreshTo3DControls();

  // 默认使用本地重建（离线、无需 Token）；如需云端，可在下拉框手动选择「Replicate 云端」

  // 图片转 3D：上传图 → 服务端生成 GLB → 载入场景
  async function imageTo3D() {
    if (!uploadedImageDataUrl) {
      showAIStatus("❌ 请先上传一张参考图（拖入或点击上方区域）", "error");
      return;
    }

    const deploy = imgTo3DDeploy ? imgTo3DDeploy.value : "local";
    const isLocal = deploy === "local";

    if (imgTo3DBtn) {
      imgTo3DBtn.disabled = true;
      imgTo3DBtn.textContent = "⏳ 重建中...";
    }
    const providerLabel = {
      local: "本地 TripoSR",
      replicate: "Replicate 云端",
      meshy: "Meshy AI 云端",
      tripo: "Tripo 云端",
      hyper3d: "Hyper3D(Rodin) 云端",
    }[deploy] || "云端";
    showAIStatus(
      `<span class="ai-paint-spinner"></span>` +
        (isLocal
          ? "正在用本地 TripoSR 真重建 3D（单图重建，首次需下载模型权重，约 1-3 分钟）..."
          : `正在用 ${providerLabel} 重建 3D 模型...（约 1-3 分钟，请耐心等待）`),
      "info",
    );

    try {
      const xhr = new XMLHttpRequest();
      xhr.responseType = "arraybuffer";
      xhr.timeout = 1200000; // 20 分钟（CPU 首跑含权重下载可能较慢）

      const result = await new Promise((resolve, reject) => {
        xhr.addEventListener("load", () => {
          try {
            if (xhr.status !== 200) {
              const errText = new TextDecoder().decode(xhr.response);
              let errMsg = `服务器错误 ${xhr.status}`;
              try {
                errMsg = JSON.parse(errText).error || errMsg;
              } catch {}
              reject(new Error(errMsg));
              return;
            }
            const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";
            let manifest = null;
            if (manifestBase64) manifest = JSON.parse(base64ToUtf8(manifestBase64));
            resolve({
              arrayBuffer: xhr.response,
              manifest,
              totalParts: parseInt(xhr.getResponseHeader("X-Total-Parts") || "0", 10),
            });
          } catch (err) {
            reject(err);
          }
        });
        xhr.addEventListener("error", () =>
          reject(new Error("网络错误：无法连接到服务器（请确认 server.js 已启动）")),
        );
        xhr.addEventListener("timeout", () => reject(new Error("请求超时（20分钟）")));

        xhr.open("POST", `${BLENDER_SERVER_AI}/api/image-to-3d`);
        xhr.setRequestHeader("Content-Type", "application/json");
        // 部署方式 + 模型：本地走 TripoSR 真重建，云端走 Replicate（owner/name）
        const payload = { image: uploadedImageDataUrl, deploy };
        if (deploy === "local") {
          const q = imgTo3DModelLocal ? imgTo3DModelLocal.value : "256";
          payload.mcResolution = parseInt(q, 10) || 256; // 真重建：重建质量（marching cubes 分辨率）
          payload.tiles = 1; // 真重建为单网格，不再切块
          payload.removeBg = imgTo3DRemoveBg ? imgTo3DRemoveBg.checked : true; // 去背景显著提升重建质量
          payload.bakeTexture = imgTo3DBake ? imgTo3DBake.checked : false; // 烘焙纹理图集（比顶点色清晰）
        } else if (deploy === "replicate") {
          let m = imgTo3DModel ? imgTo3DModel.value : "";
          if (m === "__custom__" && imgTo3DModelCustom) m = imgTo3DModelCustom.value.trim();
          if (m) payload.model = m;
        }
        xhr.send(JSON.stringify(payload));
      });

      showAIStatus(`✅ 重建成功！正在加载到场景...`, "success");
      await loadCustomModel(result.arrayBuffer, "图片转3D", result.manifest);
      showAIStatus(
        `✅ 图片转3D 已加载\n可旋转/缩放，可切换乐高/原生风格`,
        "success",
      );
      showStatus(`✅ 图片转3D：模型已加载`, "success");
    } catch (err) {
      console.error("图片转3D 失败:", err);
      showAIStatus(`❌ 重建失败：${err.message}`, "error");
    } finally {
      if (imgTo3DBtn) {
        imgTo3DBtn.disabled = false;
        imgTo3DBtn.textContent = "🧊 图片转3D";
      }
    }
  }

  // 发送 AI 绘画请求
  async function generateModel(prompt, mode = "paint", textMode = "auto") {
    if (!prompt || !prompt.trim()) {
      showAIStatus("❌ 请输入提示词", "error");
      return;
    }

    prompt = prompt.trim();
    const isTextTo3D = mode === "text";
    console.log(`🎨 ${isTextTo3D ? "文生3D" : "AI 绘画"}: "${prompt}"${uploadedImageFeatures ? " + 图片特征" : ""}`);

    // 禁用按钮，显示进度
    paintBtn.disabled = true;
    textTo3DBtn.disabled = true;
    paintBtn.textContent = "⏳ 生成中...";
    const imgHint = uploadedImageFeatures ? "（含图片特征）" : "";
    showAIStatus(
      `<span class="ai-paint-spinner"></span>${isTextTo3D ? "🌐 文生3D" : "正在生成"} "${prompt}" ${imgHint}...（云端 Hyper3D 生成中，约1-3分钟）`,
      "info",
    );

    try {
      const xhr = new XMLHttpRequest();
      xhr.responseType = "arraybuffer";
      xhr.timeout = 120000; // 2 分钟

      const result = await new Promise((resolve, reject) => {
        xhr.addEventListener("load", () => {
          try {
            if (xhr.status !== 200) {
              const errText = new TextDecoder().decode(xhr.response);
              let errMsg = `服务器错误 ${xhr.status}`;
              try {
                errMsg = JSON.parse(errText).error || errMsg;
              } catch {}
              reject(new Error(errMsg));
              return;
            }

            const successHeader = xhr.getResponseHeader("X-Success");
            if (successHeader !== "true") {
              reject(new Error("服务器返回异常"));
              return;
            }

            const totalParts = parseInt(xhr.getResponseHeader("X-Total-Parts") || "0");
            const elapsedSeconds = parseFloat(xhr.getResponseHeader("X-Elapsed-Seconds") || "0");
            const manifestBase64 = xhr.getResponseHeader("X-Manifest") || "";

            let manifest = null;
            if (manifestBase64) {
              const manifestJson = base64ToUtf8(manifestBase64);
              manifest = JSON.parse(manifestJson);
            }

            resolve({
              arrayBuffer: xhr.response,
              manifest,
              totalParts,
              elapsedSeconds,
            });
          } catch (err) {
            reject(err);
          }
        });

        xhr.addEventListener("error", () =>
          reject(new Error("网络错误：无法连接到服务器（请确认 server.js 已启动）")),
        );
        xhr.addEventListener("timeout", () => reject(new Error("请求超时（2分钟）")));

        xhr.open("POST", `${BLENDER_SERVER_AI}/${isTextTo3D ? "api/text-to-3d" : "api/ai-paint"}`);
        xhr.setRequestHeader("Content-Type", "application/json");
        const payload = { prompt };
        if (isTextTo3D) {
          payload.mode = textMode; // auto / cloud / local
        } else if (uploadedImageFeatures) {
          payload.imageFeatures = uploadedImageFeatures;
        }
        xhr.send(JSON.stringify(payload));
      });

      // 成功！加载模型到场景
      showAIStatus(
        `✅ 生成成功！${result.totalParts} 个部件 (${result.elapsedSeconds}s)\n正在加载到场景...`,
        "success",
      );

      const fileName = `AI: ${prompt}`;
      await loadCustomModel(result.arrayBuffer, fileName, result.manifest);

      // 更新状态
      showAIStatus(
        `✅ "${prompt}" 已加载\n${result.totalParts} 个部件 · 点击"💥 爆炸"可拆解`,
        "success",
      );

      // 添加到画廊
      const galleryItem = {
        id: Date.now(),
        prompt,
        arrayBuffer: result.arrayBuffer,
        manifest: result.manifest,
        icon: getPromptIcon(prompt),
        parts: result.totalParts,
      };
      aiPaintGallery.push(galleryItem);
      renderGallery();

      // 同时更新上传区域的状态
      showStatus(
        `✅ AI 绘画：${prompt}\n${result.totalParts} 个部件 · 点击爆炸按钮拆解`,
        "success",
      );

      console.log(`✅ AI 绘画完成: ${result.totalParts} 个部件`);
    } catch (err) {
      console.error("AI 绘画失败:", err);
      showAIStatus(`❌ 生成失败：${err.message}`, "error");
    } finally {
      paintBtn.disabled = false;
      paintBtn.textContent = "✨ 生成";
      if (textTo3DBtn) {
        textTo3DBtn.disabled = false;
      }
    }
  }

  // 渲染画廊
  function renderGallery() {
    if (!galleryEl) return;
    galleryEl.innerHTML = "";

    // 只显示最近 8 个
    const recent = aiPaintGallery.slice(-8);
    recent.forEach((item, idx) => {
      const actualIdx = aiPaintGallery.length - recent.length + idx;
      const el = document.createElement("div");
      el.className = "ai-gallery-item";
      el.innerHTML = `
        <span class="gallery-icon">${item.icon}</span>
        <span class="gallery-name">${item.prompt}</span>
        <span class="gallery-parts">${item.parts}件</span>
      `;
      el.addEventListener("click", () => {
        // 重新加载这个模型
        loadCustomModel(item.arrayBuffer, `AI: ${item.prompt}`, item.manifest);
        showAIStatus(`✅ 已切换到 "${item.prompt}"`, "success");
        // 标记活跃
        galleryEl.querySelectorAll(".ai-gallery-item").forEach(e => e.classList.remove("active"));
        el.classList.add("active");
      });
      galleryEl.appendChild(el);
    });
  }

  // 生成按钮点击
  paintBtn.addEventListener("click", () => {
    generateModel(promptInput.value);
  });

  // 文生3D 按钮（Hyper3D Rodin / 本地 Hunyuan3D-2）
  if (textTo3DBtn) {
    textTo3DBtn.addEventListener("click", () => {
      const mode = textTo3DMode ? textTo3DMode.value : "auto";
      generateModel(promptInput.value, "text", mode);
    });
  }

  // 回车键提交
  promptInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      generateModel(promptInput.value);
    }
  });

  // 预设按钮
  presetBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.prompt;
      promptInput.value = preset;
      generateModel(preset);
    });
  });

  console.log("🎨 AI 绘画功能已启用");

  // ===== 顶部「配置 AI」按钮：打开统一 AI 配置弹窗（复用页面已有的配置引导弹窗）=====
  const openConfigBtn = document.getElementById("open-config-btn");
  if (openConfigBtn) {
    openConfigBtn.addEventListener("click", () => {
      const modal = document.getElementById("first-config-modal");
      const iframe = document.getElementById("fcm-iframe");
      if (modal && iframe) {
        iframe.src = iframe.src || "ai-config.html";
        modal.classList.remove("hidden");
      }
    });
  }

  // 进入页面时检查 AI 配置是否就绪，缺关键项则在首页按钮上做提醒
  fetchConfigAndHighlight(openConfigBtn);
}
