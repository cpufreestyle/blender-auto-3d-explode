// AI 生成类路由（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 路由段里的四个本地函数：finishImageTo3D / handleImageTo3D /
// handleTextTo3D / runLocalTextTo3D。前两个只做请求体校验与响应收尾，
// 真正的分派在 src/image-to-3d-router.js；runLocalTextTo3D 负责拉起本地
// Hunyuan3D-2 推理脚本（脚本与 venv 都按仓库根定位）。
//
// DI / 接缝（createGenerateRoutes 工厂，与 createResponseUtils /
//   createBlenderRunner 同构）：
//   · sendJSON / sendBinaryResult 是响应工具的两个出口，注入以便测试断言；
//   · IMAGE_TO_3D_DEPS / uploadDir / rootDir / execFile 是服务器级配置与前两者
//     的副作用入口：IMAGE_TO_3D_DEPS 依赖 BLENDER_PATH 与本机 tmpdir，execFile
//     用假实现即可跑完整条本地链路而不必真的装 hy3dgen；
//   · generateImageTo3D / runHyper3DTextTo3D 也注入：前者是 /api/image-to-3d
//     分派调度器的唯一出口，后者供云端文生3D 调 Hyper3D，二者都会触网；与
//     createAIConfigHandlers({ callAI }) 及 closed-loop 注入
//     generateImageTo3D 同理，否则单测只能连真实云端；
//   · AI_CONFIG / readBody / elapsedSeconds / fs / path 直接 import
//     （AI_CONFIG 是 live binding，与 src/ai-call.js 同一套前提）。
import fs from "fs";
import path from "path";
import { readBody } from "./body.js";
import { AI_CONFIG } from "./ai-config.js";
import { elapsedSeconds } from "./server-utils.js";

export function createGenerateRoutes({
  sendJSON,
  sendBinaryResult,
  IMAGE_TO_3D_DEPS,
  uploadDir,
  rootDir,
  execFile,
  generateImageTo3D,
  runHyper3DTextTo3D,
}) {
/**
 * POST /api/image-to-3d
 * Body: { "image": "data:image/png;base64,....", "deploy": "local"|"replicate"|"meshy"|"tripo"|"hyper3d"|"vlm", "model": "..." }
 * 本地模式：零依赖 Blender 可拆解重建（显式勾选「真重建」且 TripoSR 就绪时走真重建）
 * 云端模式：Meshy / Tripo / Hyper3D / Replicate；VLM：看图生成 Blender 代码再执行
 * 返回：二进制 GLB + manifest 头（同 /api/split 格式）
 *
 * 调度（本地/云端/VLM 分派、本地失败回退云端、各路线超时）统一在
 * src/image-to-3d-router.js；这里只负责读请求体、校验 data URL、写响应。
 */
function finishImageTo3D(res, { glbBuffer, manifest }, startTime) {
  const elapsed = elapsedSeconds(startTime);
  sendBinaryResult(res, glbBuffer, manifest, elapsed, "img-to-3d");
}

async function handleImageTo3D(req, res) {
  const startTime = Date.now();
  try {
    const body = await readBody(req, { maxSize: 25 * 1024 * 1024 }); // 25MB
    const imageDataUrl = body.image;
    if (!imageDataUrl || !imageDataUrl.startsWith("data:image/")) {
      sendJSON(res, 400, { error: "缺少有效的图片数据（image 字段应为 data URL）" });
      return;
    }

    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(imageDataUrl);
    if (!match) {
      sendJSON(res, 400, { error: "图片 data URL 格式错误" });
      return;
    }
    const imageBase64 = match[2]; // 不含 data: 前缀的纯 base64

    const out = await generateImageTo3D({
      mode: body.deploy || (AI_CONFIG.replicate || {}).mode || "local",
      body,
      imageBase64,
      mime: match[1],
      config: AI_CONFIG,
      deps: IMAGE_TO_3D_DEPS,
    });
    finishImageTo3D(res, out, startTime);
  } catch (err) {
    console.error(`  ❌ 图片转3D 失败: ${err.message}`);
    if (err.status === 400) sendJSON(res, 400, { error: err.message });
    else sendJSON(res, 500, { success: false, error: err.message });
  }
}

/**
 * POST /api/text-to-3d
 * Body: { "prompt": "一架红色客机", "mode": "auto"|"cloud"|"local" }
 * 文生3D：
 *   - mode=cloud：调用 Hyper3D(Rodin) text-to-3d（需 API Key）
 *   - mode=local：调用本地 Hunyuan3D-2（免费，需 pip install hy3dgen + CUDA GPU）
 *   - mode=auto（默认）：有 Hyper3D Key 走云端，否则回退本地
 * 返回的 GLB 可直接喂给现有拆解流水线（前端加载后点「爆炸」）。
 */
async function handleTextTo3D(req, res) {
  const startTime = Date.now();
  try {
    const body = await readBody(req, { maxSize: 64 * 1024 }); // 纯文本，很小
    const prompt = ((body.prompt || "") + "").toString().trim();
    if (!prompt) {
      sendJSON(res, 400, { error: "缺少 prompt 文本（文生3D 需要自然语言提示词）" });
      return;
    }

    const mode = body.mode || "auto";
    const hasCloudKey = !!(AI_CONFIG.providers?.hyper3d?.apiKey || process.env.HYPER3D_API_KEY);

    if (mode === "local") {
      return await runLocalTextTo3D(prompt, res, startTime);
    }
    if (mode === "cloud") {
      const out = await runHyper3DTextTo3D(AI_CONFIG.providers?.hyper3d, prompt);
      return finishImageTo3D(res, out, startTime);
    }
    // auto：云端优先，无 Key 回退本地
    if (hasCloudKey) {
      try {
        const out = await runHyper3DTextTo3D(AI_CONFIG.providers?.hyper3d, prompt);
        return finishImageTo3D(res, out, startTime);
      } catch (cloudErr) {
        console.warn(`  ⚠️ 云端文生3D 失败，回退本地 Hunyuan3D-2: ${cloudErr.message}`);
      }
    }
    return await runLocalTextTo3D(prompt, res, startTime);
  } catch (err) {
    console.error(`  ❌ 文生3D 失败: ${err.message}`);
    if (err.status === 400) sendJSON(res, 400, { error: err.message });
    else sendJSON(res, 500, { success: false, error: err.message });
  }
}

/**
 * 本地「文本转3D」真生成（Hunyuan3D-2，离线推理，免费，无需云端 Key）。
 * 由 scripts/hunyuan3d_text_infer.py 调用 hy3dgen 生成 GLB。
 * 前置：pip install hy3dgen（权重会自动下载）；text-to-3D 依赖 CUDA GPU。
 */
async function runLocalTextTo3D(prompt, res, startTime) {
  const jobId = `txt3d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(uploadDir, `txt3d-${jobId}.glb`);
  const manifestPath = path.join(uploadDir, `txt3d-${jobId}.json`);

  const inferScript = path.join(rootDir, "scripts", "hunyuan3d_text_infer.py");
  // 优先用显式 python（HY3D_PYTHON），否则尝试本地克隆的 venv，最后回退系统 python3
  const hunyuanDir = process.env.HUNYUAN3D_DIR || path.join(rootDir, "external", "Hunyuan3D-2");
  const venvPython = path.join(hunyuanDir, ".venv", "bin", "python3");
  const pythonBin =
    process.env.HY3D_PYTHON ||
    (fs.existsSync(venvPython) ? venvPython : "python3");

  if (!fs.existsSync(inferScript)) {
    throw new Error("未找到推理脚本: " + inferScript);
  }

  const args = [
    inferScript,
    "--prompt", prompt,
    "--output", outputPath,
    "--manifest", manifestPath,
    "--device", process.env.HY3D_DEVICE || "auto",
  ];
  if (process.env.HUNYUAN3D_DIR) args.push("--hunyuan-dir", process.env.HUNYUAN3D_DIR);

  console.log(`  🌐 本地文生3D: ${pythonBin} ${inferScript} (prompt='${prompt}')`);
  let stdout = "";
  let stderr = "";
  try {
    const r = await execFile(pythonBin, args, {
      timeout: 1800_000, // 本地文生3D 含首次权重下载，放宽到 30 分钟
      maxBuffer: 200 * 1024 * 1024,
    });
    stdout = r.stdout || "";
    stderr = r.stderr || "";
  } catch (berr) {
    throw new Error(`Hunyuan3D-2 推理失败: ${(berr.stderr || berr.stdout || berr.message || "").slice(0, 2000)}`);
  }
  if (stdout) console.log(`  📤 Hunyuan3D stdout:\n${stdout.slice(0, 2000)}`);
  if (stderr) console.log(`  📤 Hunyuan3D stderr:\n${stderr.slice(0, 2000)}`);

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      "本地文生3D 未生成 GLB。请先准备环境：bash scripts/setup_hunyuan3d.sh" +
      "（会自动检测 GPU 并安装匹配的 PyTorch + hy3dgen），" +
      "且运行环境需有 NVIDIA CUDA GPU（text-to-3D 不支持纯 CPU / Apple Silicon）。\n" +
      `Hunyuan3D stderr: ${stderr.slice(0, 800)}`
    );
  }

  const glbBuffer = fs.readFileSync(outputPath);
  let manifest = { total_parts: 0, parts: [] };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch { /* 用默认 manifest */ }
  }

  [outputPath, manifestPath].forEach(f => {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  });

  const elapsed = elapsedSeconds(startTime);
  console.log(`  ✅ 本地文生3D 完成 (${(glbBuffer.length / 1024).toFixed(1)} KB, ${elapsed}s)`);
  sendBinaryResult(res, glbBuffer, manifest, elapsed, "text-to-3d");
}
  return { handleImageTo3D, handleTextTo3D };
}
