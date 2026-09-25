// AI 绘画 / 图片转 3D 面板（从 main.js 抽取，L2 前端模块化）
// 仅依赖 DOM + fetch + 注入的共享函数（loadCustomModel / showStatus），无 3D 场景强耦合。
import { postGlbRequest } from "./glb-request.js";
import { validateImageFile } from "./image-validate.js";
import { fetchConfigAndHighlight } from "./config-panel.js";
import { getPromptIcon } from "./prompt-icon.js";
import { buildFeatureStatusHtml, extractImageFeatures } from "./image-features.js";
import { API_BASE } from "../config.js";

// 后端 AI 服务地址（从统一配置读取）
const BLENDER_SERVER_AI = API_BASE;
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
  const imgTo3DModeLocal = document.getElementById("img-to-3d-mode-local");
  const imgTo3DTilesLocal = document.getElementById("img-to-3d-tiles-local");
  const imgTo3DReal = document.getElementById("img-to-3d-real");
  const imgTo3DRemoveBg = document.getElementById("img-to-3d-remove-bg");
  const imgTo3DBake = document.getElementById("img-to-3d-bake");
  const imgTo3DModel = document.getElementById("img-to-3d-model");
  const imgTo3DModelCustom = document.getElementById("img-to-3d-model-custom");
  const textTo3DBtn = document.getElementById("text-to-3d-btn");
  const textTo3DMode = document.getElementById("text-to-3d-mode");
  const genToBlenderBtn = document.getElementById("gen-to-blender-btn");
  const blenderReadbackBtn = document.getElementById("blender-readback-btn");

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

  // ========== 图片特征提取与特征文案 ==========
  // 实现迁至 src/panels/image-features.js：extractImageFeatures 是纯 canvas 运算
  // （只用 document.createElement 与传入的 imgElement），buildFeatureStatusHtml
  // 是纯字符串运算，两者闭包里都不引用 setupAIPaint 的状态，故无 DI 接缝。
  // 处理图片文件
  async function handleImageFile(file) {
    const invalid = validateImageFile(file);
    if (invalid) {
      showAIStatus(invalid, "error");
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
          showAIStatus(buildFeatureStatusHtml(uploadedImageFeatures), "info");
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
    if (imgTo3DModeLocal) imgTo3DModeLocal.classList.toggle("hidden", !isLocal);
    if (imgTo3DTilesLocal) imgTo3DTilesLocal.classList.toggle("hidden", !isLocal);
    if (imgTo3DReal && imgTo3DReal.parentElement) imgTo3DReal.parentElement.classList.toggle("hidden", !isLocal);
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
      local: "本地可拆解",
      replicate: "Replicate 云端",
      meshy: "Meshy AI 云端",
      tripo: "Tripo 云端",
      hyper3d: "Hyper3D(Rodin) 云端",
    }[deploy] || "云端";
    showAIStatus(
      "<span class=\"ai-paint-spinner\"></span>" +
        (isLocal ?
          "正在用本地 Blender 重建 3D（零依赖、可拆解，按图切块，约 10-30 秒）..." :
          `正在用 ${providerLabel} 重建 3D 模型...（约 1-3 分钟，请耐心等待）`),
      "info",
    );

    try {
      // 部署方式 + 模型：本地走 TripoSR 真重建，云端走 Replicate（owner/name）
      const payload = { image: uploadedImageDataUrl, deploy };
      if (deploy === "local") {
        payload.mode = imgTo3DModeLocal ? imgTo3DModeLocal.value : "depth"; // depth | relief | voxel
        payload.tiles = imgTo3DTilesLocal ? (parseInt(imgTo3DTilesLocal.value, 10) || 3) : 3; // 拆解块数，越大越易拆解
        payload.real = !!(imgTo3DReal && imgTo3DReal.checked); // 真重建需本机就绪 TripoSR
        payload.removeBg = imgTo3DRemoveBg ? imgTo3DRemoveBg.checked : true; // 去背景（真重建时用）
        payload.bakeTexture = imgTo3DBake ? imgTo3DBake.checked : false; // 烘焙纹理（真重建时用）
      } else if (deploy === "replicate") {
        let m = imgTo3DModel ? imgTo3DModel.value : "";
        if (m === "__custom__" && imgTo3DModelCustom) m = imgTo3DModelCustom.value.trim();
        if (m) payload.model = m;
      }

      const result = await postGlbRequest({
        url: `${BLENDER_SERVER_AI}/api/image-to-3d`,
        payload,
        timeoutMs: 1200000, // 20 分钟（CPU 首跑含权重下载可能较慢）
        timeoutLabel: "20分钟",
      });

      showAIStatus("✅ 重建成功！正在加载到场景...", "success");
      await loadCustomModel(result.arrayBuffer, "图片转3D", result.manifest);
      showAIStatus(
        "✅ 图片转3D 已加载\n可旋转/缩放，可切换乐高/原生风格",
        "success",
      );
      showStatus("✅ 图片转3D：模型已加载", "success");
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

  // 把生成结果的 modelUrl 拉成 GLB 并载入场景。
  // 展示失败不致命：Blender 已导入成功才是主路径，这里只保证「网页也能看到」，
  // 因此吃掉了全部异常。genToBlender 的失败回退与成功路径共用它。
  async function loadModelFromUrl(modelUrl, label) {
    try {
      const ab = await (await fetch(`${BLENDER_SERVER_AI}${modelUrl}`)).arrayBuffer();
      await loadCustomModel(ab, label, null);
    } catch {
      /* 展示失败不致命 */
    }
  }

  // 全自动：云端生成 → 导入 Blender 实时场景 → 同时在网页展示
  async function genToBlender() {
    if (!uploadedImageDataUrl) {
      showAIStatus("❌ 请先上传一张参考图（拖入或点击上方区域）", "error");
      return;
    }
    const deploy = imgTo3DDeploy ? imgTo3DDeploy.value : "tripo";
    const providerLabel =
      { meshy: "Meshy AI", tripo: "Tripo", hyper3d: "Hyper3D(Rodin)" }[deploy] || deploy;
    if (genToBlenderBtn) {
      genToBlenderBtn.disabled = true;
      genToBlenderBtn.textContent = "⏳ 生成并导入中...";
    }
    showAIStatus(
      `<span class="ai-paint-spinner"></span>正在用 ${providerLabel} 生成，并自动导入 Blender 实时场景...（约 1-3 分钟）`,
      "info",
    );
    try {
      const resp = await fetch(`${BLENDER_SERVER_AI}/api/gen-to-blender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: uploadedImageDataUrl, deploy }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        // 即便导入失败，只要已生成模型也展示到网页，避免白跑一趟
        if (data.modelUrl) {
          await loadModelFromUrl(data.modelUrl, "生成→Blender");
        }
        throw new Error(data.error || `服务器错误 ${resp.status}`);
      }
      const objName = (data.imported && data.imported.name) || "模型";
      const objCount = (data.scene && data.scene.object_count) || "?";
      showAIStatus(
        `✅ 已生成并导入 Blender！对象「${objName}」\n场景共 ${objCount} 个对象（${data.elapsed}s）。可点「📥 从 Blender 读回」拉回网页。`,
        "success",
      );
      showStatus(`✅ 已发送到 Blender：${objName}`, "success");
      if (data.modelUrl) {
        await loadModelFromUrl(data.modelUrl, `Blender: ${objName}`);
      }
    } catch (err) {
      console.error("生成并发送到 Blender 失败:", err);
      showAIStatus(`❌ ${err.message}`, "error");
    } finally {
      if (genToBlenderBtn) {
        genToBlenderBtn.disabled = false;
        genToBlenderBtn.textContent = "📤 生成并发送到 Blender";
      }
    }
  }

  // 从 Blender 读回最近导入的对象（二进制 GLB）并显示到网页
  async function blenderReadback() {
    if (blenderReadbackBtn) {
      blenderReadbackBtn.disabled = true;
      blenderReadbackBtn.textContent = "⏳ 读取中...";
    }
    showAIStatus("<span class=\"ai-paint-spinner\"></span>正在从 Blender 读回对象...", "info");
    try {
      const resp = await fetch(`${BLENDER_SERVER_AI}/api/blender/export`);
      if (!resp.ok) {
        let msg = `服务器错误 ${resp.status}`;
        try {
          msg = (await resp.json()).error || msg;
        } catch {
          /* 非 JSON 响应 */
        }
        throw new Error(msg);
      }
      const objName = decodeURIComponent(resp.headers.get("X-Object-Name") || "blender_object");
      const arrayBuffer = await resp.arrayBuffer();
      showAIStatus(`✅ 已从 Blender 读回「${objName}」，正在加载到场景...`, "success");
      await loadCustomModel(arrayBuffer, `Blender: ${objName}`, null);
      showStatus(`✅ 从 Blender 读回：${objName}`, "success");
    } catch (err) {
      console.error("从 Blender 读回失败:", err);
      showAIStatus(`❌ 读回失败：${err.message}`, "error");
    } finally {
      if (blenderReadbackBtn) {
        blenderReadbackBtn.disabled = false;
        blenderReadbackBtn.textContent = "📥 从 Blender 读回";
      }
    }
  }

  if (genToBlenderBtn) genToBlenderBtn.addEventListener("click", genToBlender);
  if (blenderReadbackBtn) blenderReadbackBtn.addEventListener("click", blenderReadback);

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
    const actionLabel = isTextTo3D ? "🌐 文生3D" : "正在生成";
    showAIStatus(
      `<span class="ai-paint-spinner"></span>${actionLabel} "${prompt}" ${imgHint}` +
        "...（云端 Hyper3D 生成中，约1-3分钟）",
      "info",
    );

    try {
      const payload = { prompt };
      if (isTextTo3D) {
        payload.mode = textMode; // auto / cloud / local
      } else if (uploadedImageFeatures) {
        payload.imageFeatures = uploadedImageFeatures;
      }

      const result = await postGlbRequest({
        url: `${BLENDER_SERVER_AI}/${isTextTo3D ? "api/text-to-3d" : "api/ai-paint"}`,
        payload,
        timeoutMs: 120000, // 2 分钟
        timeoutLabel: "2分钟",
        requireSuccess: true,
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
    recent.forEach(item => {
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
