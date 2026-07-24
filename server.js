#!/usr/bin/env node
/**
 * GLB 拆解服务器（零依赖版 — 仅使用 Node.js 内置模块）
 *
 * 功能：
 *   POST /api/split  —  接收 GLB 文件，调用 Blender CLI 拆解，返回二进制 GLB + manifest 头
 *   GET  /api/health —  健康检查（检测 Blender 是否可用）
 *
 * 改进：
 *   - 错误处理作用域修复（blenderStdout/blenderStderr 提到外层）
 *   - GLB 以二进制流返回（不再 base64 编码，节省 33% 带宽和内存）
 *   - multipart 解析器增加输入校验（boundary 长度、part 数量、文件名消毒）
 *   - 启动时清理超过 1 小时的残留临时文件
 *
 * 用法：
 *   node server.js                 # 默认端口 3001
 *   PORT=8080 node server.js       # 自定义端口
 *   BLENDER_PATH=/custom/blender node server.js  # 自定义 Blender 路径
 */

import http from "http";
import net from "net";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import {
  getCORSHeaders,
  cleanupOldTempFiles,
  MAX_FILE_SIZE,
} from "./src/server-utils.js";
import { readBody } from "./src/body.js";
import { runMeshyImageTo3D, runTripoImageTo3D, runHyper3DImageTo3D } from "./src/providers/image-to-3d.js";
import { DEFAULT_MODELS } from "./src/provider-models.js";
import { log } from "./src/logger.js";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 统一日志：将 console.* 重定向到结构化 logger（保留原有消息内容，追加时间戳/级别）。
// 放在此处（findBlender 调用之前），使全部后续 console.* 均获得结构化输出。
console.log = (...a) => log.info(...a);
console.info = (...a) => log.info(...a);
console.warn = (...a) => log.warn(...a);
console.error = (...a) => log.error(...a);
console.debug = (...a) => log.debug(...a);

const PORT = process.env.PORT || 3001;

// ── 配置 ──────────────────────────────────────────────
const BLENDER_PATH = process.env.BLENDER_PATH || findBlender();
const UPLOAD_DIR = path.join(os.tmpdir(), "blender-split-uploads");
const GENERATED_DIR = path.join(__dirname, "models", "generated");

// Blender MCP addon（scripts/blender_mcp_addon.py）监听的 TCP 端口
const BLENDER_MCP_HOST = process.env.BLENDERMCP_HOST || "localhost";
const BLENDER_MCP_PORT = Number(process.env.BLENDERMCP_PORT || 9876);

// 确保上传目录存在
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(GENERATED_DIR, { recursive: true });

// 启动时清理残留临时文件
cleanupOldTempFiles(UPLOAD_DIR, fs, path);

// ── 工具函数 ──────────────────────────────────────────

/**
 * 在系统中查找 Blender 可执行文件（跨平台支持）
 * 检测顺序：环境变量 > macOS > Linux > Windows > PATH
 */
function findBlender() {
  const platform = os.platform();
  const candidates = [];

  if (platform === "darwin") {
    // macOS — /Applications, ~/Applications, Homebrew
    candidates.push(
      "/Applications/Blender.app/Contents/MacOS/Blender",
      "/Applications/Blender.app/Contents/MacOS/blender",
      path.join(os.homedir(), "Applications/Blender.app/Contents/MacOS/Blender"),
      "/opt/homebrew/bin/blender",
      "/usr/local/bin/blender"
    );
  } else if (platform === "linux") {
    candidates.push(
      "/usr/bin/blender",
      "/usr/local/bin/blender",
      "/snap/bin/blender",
      "/opt/blender/blender",
      path.join(os.homedir(), ".local/bin/blender")
    );
  } else if (platform === "win32") {
    // Windows — Program Files, scoop, chocolatey
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidates.push(
      path.join(programFiles, "Blender Foundation", "Blender", "blender.exe"),
      path.join(programFilesX86, "Blender Foundation", "Blender", "blender.exe"),
      path.join(os.homedir(), "scoop", "apps", "blender", "current", "blender.exe"),
      path.join("C:\\", "ProgramData", "chocolatey", "bin", "blender.exe")
    );
  }

  // 最后回退到 PATH 中的 blender
  candidates.push("blender");

  for (const c of candidates) {
    try {
      if (c === "blender") return c; // 依赖 PATH 解析
      if (fs.existsSync(c)) {
        console.log(`  🔍 检测到 Blender: ${c}`);
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  console.log("  ⚠️  未找到 Blender 可执行文件，将使用 PATH 中的 blender");
  return "blender";
}

/**
 * 调用 Blender CLI 进行 AI 绘画（生成模型）
 */
async function runBlenderAIPaint(prompt, outputPath, manifestPath, imageFeaturesPath) {
  const scriptPath = path.join(__dirname, "blender_ai_paint.py");
  const args = [
    "--factory-startup",
    "--background",
    "--python",
    scriptPath,
    "--",
    "--prompt",
    prompt,
    "--output",
    outputPath,
    "--manifest",
    manifestPath,
  ];

  // 如果有图片特征文件，传递给 Blender
  if (imageFeaturesPath) {
    args.push("--image-features", imageFeaturesPath);
  }

  console.log(`  🎨 AI 绘画: ${BLENDER_PATH} ${args.join(" ")}`);

  const { stdout, stderr } = await execFileAsync(BLENDER_PATH, args, {
    timeout: 120_000, // 2 分钟超时
    maxBuffer: 50 * 1024 * 1024,
  });

  return { stdout, stderr };
}

/**
 * 调用 Blender CLI 拆解 GLB
 */
async function runBlenderSplit(inputPath, outputPath, manifestPath, originalFileName) {
  const scriptPath = path.join(__dirname, "blender_split_glb.py");
  const args = [
    "--factory-startup",
    "--background",
    "--python",
    scriptPath,
    "--",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--manifest",
    manifestPath,
    "--original-filename",
    originalFileName,
  ];

  console.log(`  🔧 调用 Blender: ${BLENDER_PATH} ${args.join(" ")}`);

  const { stdout, stderr } = await execFileAsync(BLENDER_PATH, args, {
    timeout: 600_000, // 10 分钟超时（大模型需要更久）
    maxBuffer: 50 * 1024 * 1024,
  });

  return { stdout, stderr };
}

// ── 安全的 multipart 解析器 ────────────────────────────

/**
 * 解析 multipart/form-data 请求体
 * 提取上传的文件内容（增加输入校验）
 * @param {http.IncomingMessage} req
 * @returns {Promise<{filename: string, data: Buffer, contentType: string}>}
 */

// ── 响应工具 ──────────────────────────────────────────

/**
 * 发送 JSON 响应
 */
function sendJSON(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...getCORSHeaders(),
  });
  res.end(json);
}

/**
 * 统一错误响应：从 err.status 取状态码（默认 500），返回一致的错误信封
 * { success:false, error }。若响应头已发送（如流式传输中途出错），则安全结束。
 */
function respondError(res, err) {
  const status =
    typeof err?.status === "number" && err.status >= 400 && err.status < 600
      ? err.status
      : 500;
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  sendJSON(res, status, {
    success: false,
    error: err?.message || "Internal Server Error",
  });
}

/**
 * 中间件式包裹：统一捕获 handler 抛出的异常并转为错误响应，
 * 避免未捕获异常导致连接挂起 / 进程崩溃。
 * 用法：http.createServer(wrap(async (req, res) => { ... }))
 */
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      log.error(`请求处理异常 ${req.method} ${req.url}:`, err);
      respondError(res, err);
    }
  };
}

/**
 * 发送二进制 GLB + manifest 头
 * 改进：GLB 以二进制流返回，manifest 通过自定义头传递
 * 节省 33% 带宽（不再 base64 编码）
 */
function sendBinaryResult(res, glbBuffer, manifest, elapsed, baseName) {
  const manifestJson = JSON.stringify(manifest);
  const manifestBase64 = Buffer.from(manifestJson, "utf-8").toString("base64");

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": glbBuffer.length,
    ...getCORSHeaders(),
    "X-Success": "true",
    "X-Total-Parts": String(manifest.total_parts || 0),
    "X-Elapsed-Seconds": elapsed,
    "X-Manifest": manifestBase64,
  });
  res.end(glbBuffer);

  // 生成完成后：把模型存盘，并按需自动用 Blender GUI 打开显示
  try {
    const saved = saveGeneratedModel(glbBuffer, baseName || "model");
    if (shouldOpenInBlender()) openInBlender(saved);
  } catch (e) {
    console.warn(`  ⚠️ 模型存盘/在 Blender 中打开失败: ${e.message}`);
  }
}

/**
 * 是否自动用 Blender GUI 打开生成的三维模型。
 * 默认开启；可用环境变量 OPEN_IN_BLENDER=0 临时关闭（如自动化测试）。
 */
function shouldOpenInBlender() {
  if (process.env.OPEN_IN_BLENDER === "0") return false;
  return AI_CONFIG.openInBlender !== false;
}

/**
 * 把生成的 GLB 存盘到 models/generated/，返回文件路径
 */
function saveGeneratedModel(glbBuffer, baseName) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${baseName}-${ts}.glb`;
  const outPath = path.join(GENERATED_DIR, fileName);
  fs.writeFileSync(outPath, glbBuffer);
  console.log(`  💾 模型已存盘: ${outPath}`);
  return outPath;
}

/**
 * 记录上一个被打开的 Blender GUI 进程，用于「打开新窗口后自动关闭旧窗口」。
 */
let lastBlenderChild = null;

/**
 * 用 Blender GUI 打开指定 GLB（fire-and-forget，不阻塞响应）
 * 每次调用都会拉起一个新的 Blender 窗口；新窗口就绪后，自动关闭上一个窗口。
 */
function openInBlender(glbPath) {
  const platform = os.platform();
  // 写一个「导入 + 框选」脚本，并单独把 GLB 路径写入临时文件，
  // 避免路径含空格/特殊字符导致命令行解析问题。
  // 注意：不能用 `open -a Blender file.glb`，macOS 会把它当文档交给 Blender，
  // 触发「格式不支持」。必须显式 import_scene.gltf。
  const pathFile = path.join(UPLOAD_DIR, `open_path-${Date.now()}.txt`);
  fs.writeFileSync(pathFile, glbPath);
  const importerPath = path.join(UPLOAD_DIR, `open_importer-${Date.now()}.py`);
  const importer = [
    "import bpy",
    "pf = r'" + pathFile + "'",
    "with open(pf, 'r', encoding='utf-8') as f:",
    "    fp = f.read().strip()",
    "# 清场（移除默认立方体等）",
    "for o in list(bpy.data.objects):",
    "    bpy.data.objects.remove(o, do_unlink=True)",
    "bpy.ops.import_scene.gltf(filepath=fp)",
    "# 框选所有物体（仅在有 3D 视口时）",
    "for area in (bpy.context.screen.areas if getattr(bpy.context, 'screen', None) else []):",
    "    if area.type == 'VIEW_3D':",
    "        for region in area.regions:",
    "            if region.type == 'WINDOW':",
    "                ctx = bpy.context.copy()",
    "                ctx['area'] = area",
    "                ctx['region'] = region",
    "                try:",
    "                    bpy.ops.view3d.view_all(ctx)",
    "                except Exception:",
    "                    pass",
    "                break",
  ].join("\n");
  fs.writeFileSync(importerPath, importer);

  let cmd, args;
  if (platform === "darwin") {
    // 直接启动 GUI Blender 二进制并传 --python，确保每次生成都拉起新实例并正确导入
    cmd = BLENDER_PATH;
    args = ["--python", importerPath];
  } else {
    cmd = "blender";
    args = ["--python", importerPath];
  }

  // 记录旧窗口进程，待新窗口拉起并加载完成后自动关闭
  const prevChild = lastBlenderChild;
  lastBlenderChild = null;

  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  lastBlenderChild = child;

  // macOS：把 Blender 窗口提到最前，确保用户能看到
  if (platform === "darwin") {
    let appName = "Blender";
    const mm = BLENDER_PATH && BLENDER_PATH.match(/(.+?\.app)\/Contents\/MacOS\/Blender$/);
    if (mm) appName = mm[1];
    try { spawn("open", ["-a", appName], { detached: true, stdio: "ignore" }).unref(); } catch {}
  }

  // 新窗口已拉起；稍等 GUI 完成加载后再关闭旧窗口，避免画面空白闪烁
  if (prevChild) {
    const prevPid = prevChild.pid;
    setTimeout(() => {
      try {
        prevChild.kill("SIGTERM");
      } catch {
        /* 进程可能已自行退出 */
      }
      // 兜底：若 SIGTERM 后仍未退出，3 秒后强制结束
      setTimeout(() => {
        try { process.kill(prevPid, "SIGKILL"); } catch {}
      }, 3000);
    }, 4000);
  }

  // Blender 读完脚本后清理临时文件
  setTimeout(() => {
    try { fs.unlinkSync(importerPath); } catch {}
    try { fs.unlinkSync(pathFile); } catch {}
  }, 15000);
  console.log(`  🪟 已在 Blender 中打开模型: ${glbPath}` + (prevChild ? "（旧窗口将自动关闭）" : ""));
}

// ── 路由处理 ──────────────────────────────────────────

/**
 * AI 绘画 — 根据提示词生成3D模型
 * POST /api/ai-paint
 * Body: { "prompt": "红色球体", "imageFeatures": { ... } }
 * 返回：二进制 GLB + manifest 头（同 /api/split 格式）
 */
async function handleAIPaint(req, res) {
  const startTime = Date.now();
  let blenderStdout = "";
  let blenderStderr = "";

  try {
    // 1. 读取 JSON body
    const body = await readBody(req, { maxSize: 10 * 1024 });
    const prompt = body.prompt || "球体";

    if (typeof prompt !== "string" || prompt.length > 500) {
      sendJSON(res, 400, { error: "提示词无效或过长（最多500字符）" });
      return;
    }

    const imageFeatures = body.imageFeatures || null;
    console.log(
      `\n🎨 AI 绘画请求: "${prompt}"${imageFeatures ? ` + 图片特征(${imageFeatures.mood}色调, ${imageFeatures.dominantColors?.length || 0}主色)` : ""}`
    );

    // 2. 临时文件路径
    const jobId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputPath = path.join(UPLOAD_DIR, `ai-output-${jobId}.glb`);
    const manifestPath = path.join(UPLOAD_DIR, `ai-manifest-${jobId}.json`);

    // 如果有图片特征，写入临时 JSON 文件供 Blender 读取
    let imageFeaturesPath = null;
    if (imageFeatures) {
      imageFeaturesPath = path.join(UPLOAD_DIR, `ai-imgfeat-${jobId}.json`);
      fs.writeFileSync(imageFeaturesPath, JSON.stringify(imageFeatures, null, 2), "utf-8");
      console.log(`  🖼️ 图片特征已写入: ${imageFeaturesPath}`);
    }

    try {
      // 3. 调用 Blender 生成模型
      try {
        const result = await runBlenderAIPaint(prompt, outputPath, manifestPath, imageFeaturesPath);
        blenderStdout = result.stdout || "";
        blenderStderr = result.stderr || "";
      } catch (berr) {
        blenderStdout = berr.stdout || "";
        blenderStderr = berr.stderr || berr.message || "";
      }

      if (blenderStdout) console.log(`  📤 Blender stdout:\n${blenderStdout.slice(0, 3000)}`);
      if (blenderStderr) console.log(`  📤 Blender stderr:\n${blenderStderr.slice(0, 3000)}`);

      // 4. 检查输出
      if (!fs.existsSync(outputPath)) {
        const detail = (blenderStderr || blenderStdout || "").slice(0, 3000);
        throw new Error(`Blender 未生成 GLB 文件。日志:\n${detail}`);
      }
      if (!fs.existsSync(manifestPath)) {
        const detail = (blenderStderr || blenderStdout || "").slice(0, 3000);
        throw new Error(`Blender 未生成 manifest。日志:\n${detail}`);
      }

      // 5. 读取结果
      const outputBuffer = fs.readFileSync(outputPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(
        `  ✅ AI 绘画完成: ${manifest.total_parts} 个部件 (${elapsed}s, ${(outputBuffer.length / 1024).toFixed(1)} KB)`
      );

      // 6. 返回二进制 GLB + manifest 头
      sendBinaryResult(res, outputBuffer, manifest, elapsed, "ai-paint");
    } finally {
      // 清理临时文件
      [outputPath, manifestPath].forEach(f => {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      });
    }
  } catch (err) {
    console.error(`  ❌ AI 绘画失败: ${err.message}`);
    sendJSON(res, 500, {
      success: false,
      error: err.message,
      blender_output: blenderStdout || blenderStderr || "",
    });
  }
}

/**
 * 读取较大的 JSON 请求体（图片转 3D 需要传 base64 图片，默认 10KB 不够）
 */

const REPLICATE_BASE = "https://api.replicate.com/v1";

/**
 * POST /api/image-to-3d
 * Body: { "image": "data:image/png;base64,....", "deploy": "local"|"replicate", "model": "..." }
 * 本地模式：POST {localUrl}/generate → 响应直接返回 GLB 二进制（无需轮询）
 * 云端模式：上传 Replicate → 创建预测 → 轮询 → 下载 GLB
 * 返回：二进制 GLB + manifest 头（同 /api/split 格式）
 */
function finishImageTo3D(res, { glbBuffer, manifest }, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
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

    const rep = AI_CONFIG.replicate || {};
    const mode = body.deploy || rep.mode || "local";

    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(imageDataUrl);
    if (!match) {
      sendJSON(res, 400, { error: "图片 data URL 格式错误" });
      return;
    }
    const imageBase64 = match[2]; // 不含 data: 前缀的纯 base64

    // 本地部署模式：调用本地 TripoSR 真重建（scripts/triposr_infer.py）由图片生成真·GLB
    if (mode === "local") {
      try {
        await runLocalImageTo3D(rep, body, imageBase64, res, startTime);
        return;
      } catch (localErr) {
        // 已配置 Replicate Token 时，本地服务不可用则自动回退云端，提升易用性
        if (rep.token) {
          console.warn(`  ⚠️ 本地图像转3D服务不可用，自动回退到 Replicate 云端: ${localErr.message}`);
          // 继续走下方云端逻辑
        } else {
          throw localErr;
        }
      }
    }

    // 第三方云端提供商（与 MCP tools 一致）：Meshy / Tripo / Hyper3D(Rodin)
    if (mode === "meshy") {
      const out = await runMeshyImageTo3D(AI_CONFIG.providers?.meshy, body, imageBase64);
      return finishImageTo3D(res, out, startTime);
    }
    if (mode === "tripo") {
      const out = await runTripoImageTo3D(AI_CONFIG.providers?.tripo, body, imageBase64);
      return finishImageTo3D(res, out, startTime);
    }
    if (mode === "hyper3d") {
      const out = await runHyper3DImageTo3D(AI_CONFIG.providers?.hyper3d, body, imageBase64);
      return finishImageTo3D(res, out, startTime);
    }

    // VLM 视觉模型程序化重建（看图→生成 3D 代码→自动修复→导出 GLB）
    if (mode === "vlm") {
      return await runVLMImageTo3D(AI_CONFIG.vlm, body, imageBase64, res, startTime);
    }

    // 云端 Replicate 模式
    const token = rep.token;
    if (!token) {
      sendJSON(res, 400, {
        error:
          "图片转3D 失败：未配置 Replicate Token。请先在 ai-config.html 填写 Replicate API Token（及模型 owner/name），" +
          "并在下拉框选择「Replicate 云端」；或运行 `bash scripts/setup_triposr.sh` 准备本地 TripoSR 真重建环境。",
      });
      return;
    }
    const imageBytes = Buffer.from(imageBase64, "base64");
    const auth = { Authorization: `Bearer ${token}` };
    const mime = match[1];

    // 1. 上传图片到 Replicate 文件服务，换取可访问 URL
    //    注意：Replicate /v1/files 要求 multipart/form-data，文件字段名为 "content"
    console.log(`  ☁️ 图片转3D: 上传图片到 Replicate (${(imageBytes.length / 1024).toFixed(1)} KB)`);
    const form = new FormData();
    form.append("content", new Blob([imageBytes], { type: mime }), "image.png");
    const uploadRes = await fetch(`${REPLICATE_BASE}/files`, {
      method: "POST",
      headers: auth, // 不手动设 Content-Type，由 fetch 自动附加 multipart boundary
      body: form,
    });
    if (!uploadRes.ok) {
      const t = await uploadRes.text();
      throw new Error(`Replicate 文件上传失败 ${uploadRes.status}: ${t.slice(0, 500)}`);
    }
    const uploadJson = await uploadRes.json();
    const fileUrl = uploadJson?.urls?.get;
    if (!fileUrl) throw new Error("Replicate 未返回文件 URL");

    // 2. 创建预测任务（请求体里的 model 可临时覆盖配置；优先用 modelVersion，否则自动解析模型最新版本）
    //    注意：Replicate 已弃用 /models/{owner}/{name}/predictions 路由，创建预测必须用 /v1/predictions + version
    //    仅当显式选择「云端」模式时，才使用 body.model 作为云端模型；
    //    本地模式回退到云端时，body.model 是本地生成方式（relief/voxel 等），不能当作 Replicate 模型名
    const reqModel = mode === "replicate" ? body.model : undefined;
    const [reqOwner, reqName] = reqModel ? reqModel.split("/") : [];
    const owner = reqOwner || rep.owner || "tencent";
    const name = reqName || rep.name || "hunyuan3d-2";
    let version = body.modelVersion || rep.modelVersion;
    if (!version) {
      const mRes = await fetch(`${REPLICATE_BASE}/models/${owner}/${name}`, { headers: auth });
      if (!mRes.ok) {
        const t = await mRes.text();
        throw new Error(`获取模型 ${owner}/${name} 版本失败 ${mRes.status}: ${t.slice(0, 300)}`);
      }
      const mJson = await mRes.json();
      version = mJson?.latest_version?.id;
      if (!version) throw new Error(`模型 ${owner}/${name} 未找到可用版本`);
    }
    const predUrl = `${REPLICATE_BASE}/predictions`;
    const predBody = { version, input: { image: fileUrl } };
    console.log(`  🚀 图片转3D: 创建 Replicate 预测 ${owner}/${name}`);
    const predRes = await fetch(predUrl, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(predBody),
    });
    if (!predRes.ok) {
      const t = await predRes.text();
      // 余额不足（402）：给出中文指引，避免暴露原始英文报错
      if (predRes.status === 402) {
        throw new Error(
          "Replicate 余额不足：请到 https://replicate.com/account/billing 绑定支付方式并充值，" +
            "等待几分钟后重试。当前图片转3D功能需要在 Replicate 上消耗额度。"
        );
      }
      throw new Error(`Replicate 预测创建失败 ${predRes.status}: ${t.slice(0, 500)}`);
    }
    const pred = await predRes.json();
    const predId = pred.id;
    if (!predId) throw new Error("Replicate 未返回预测 ID");

    // 3. 轮询任务状态（最长 8 分钟）
    let result = pred;
    const deadline = Date.now() + 8 * 60 * 1000;
    while (result.status !== "succeeded" && result.status !== "failed" && result.status !== "canceled") {
      if (Date.now() > deadline) throw new Error("Replicate 任务超时（8 分钟）");
      await new Promise(r => setTimeout(r, 4000));
      const pr = await fetch(`${REPLICATE_BASE}/predictions/${predId}`, { headers: auth });
      if (!pr.ok) throw new Error(`Replicate 状态查询失败 ${pr.status}`);
      result = await pr.json();
    }
    if (result.status !== "succeeded") {
      const detail = result.error ? " - " + JSON.stringify(result.error) : "";
      throw new Error(`Replicate 任务失败: ${result.status}${detail}`);
    }

    // 4. 解析输出（TripoSR 返回单个 glb 文件 URL；兼容数组/对象）
    const out = result.output;
    let glbUrl = null;
    if (typeof out === "string") glbUrl = out;
    else if (Array.isArray(out)) glbUrl = typeof out[0] === "string" ? out[0] : out[0]?.url;
    else if (out && typeof out === "object") glbUrl = out.url || out.mesh || out.model;
    if (!glbUrl) throw new Error("Replicate 输出中未找到 GLB 文件 URL");

    // 5. 下载 GLB
    console.log("  ⬇️ 图片转3D: 下载生成的 GLB...");
    const glbRes = await fetch(glbUrl);
    if (!glbRes.ok) throw new Error(`GLB 下载失败 ${glbRes.status}`);
    const glbBuffer = Buffer.from(await glbRes.arrayBuffer());

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const manifest = { total_parts: 0, parts: [] };
    console.log(`  ✅ 图片转3D 完成 (${(glbBuffer.length / 1024).toFixed(1)} KB, ${elapsed}s)`);
    sendBinaryResult(res, glbBuffer, manifest, elapsed, "img-to-3d");
  } catch (err) {
    console.error(`  ❌ 图片转3D 失败: ${err.message}`);
    if (err.status === 400) sendJSON(res, 400, { error: err.message });
    else sendJSON(res, 500, { success: false, error: err.message });
  }
}

/**
 * VLM 视觉模型程序化重建（图片转3D 的 VLM 路线）
 * 调用 scripts/vlm_img_to_blender.py：视觉模型看图→生成 Blender 代码→沙箱执行+自动修复→导出 GLB
 */
async function runVLMImageTo3D(vlmCfg, body, imageBase64, res, startTime) {
  try {
    const provider = vlmCfg?.provider || "stepfun";
    const model = vlmCfg?.model || "step-3.7-flash";
    const imgPath = path.join(os.tmpdir(), "vlm_in.png");
    fs.writeFileSync(imgPath, Buffer.from(imageBase64, "base64"));

    const script = path.join(__dirname, "scripts", "vlm_img_to_blender.py");
    const args = ["--provider", provider, "--model", model, "--image", imgPath];
    console.log(`  🤖 图片转3D(VLM): spawn ${provider}/${model}`);

    const child = spawn("python3", [script, ...args], { cwd: __dirname });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    await new Promise((resolve, reject) => {
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`VLM 脚本退出 ${code}: ${stderr.slice(-800)}`))
      );
      child.on("error", reject);
    });

    const glbPath = "/tmp/vlm_img_to_3d.glb";
    if (!fs.existsSync(glbPath)) {
      throw new Error("VLM 未导出 GLB；脚本输出: " + stdout.slice(-600));
    }
    const glbBuffer = fs.readFileSync(glbPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const manifest = { total_parts: 0, parts: [] };
    console.log(`  ✅ 图片转3D(VLM) 完成 (${(glbBuffer.length / 1024).toFixed(1)} KB, ${elapsed}s)`);
    sendBinaryResult(res, glbBuffer, manifest, elapsed, "img-to-3d");
  } catch (err) {
    console.error(`  ❌ 图片转3D(VLM) 失败: ${err.message}`);
    sendJSON(res, 500, { success: false, error: err.message });
  }
}

/**
 * 本地部署图像转3D（TripoSR 真重建，离线推理）
 * 把 base64 图片写成临时 PNG，调用 scripts/triposr_infer.py（TripoSR 虚拟环境 python）
 * 生成真正的 3D 网格 GLB（有体积/背面），返回二进制结果。
 */
async function runLocalImageTo3D(rep, body, imageBase64, res, startTime) {
  const jobId = `img3d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const imgPath = path.join(UPLOAD_DIR, `img3d-${jobId}.png`);
  const outputPath = path.join(UPLOAD_DIR, `img3d-${jobId}.glb`);
  const manifestPath = path.join(UPLOAD_DIR, `img3d-${jobId}.json`);

  fs.writeFileSync(imgPath, Buffer.from(imageBase64, "base64"));

  // 定位 TripoSR 仓库与它的虚拟环境 python（由 scripts/setup_triposr.sh 创建）
  const triposrDir = process.env.TRIPOSR_DIR || path.join(__dirname, "external", "TripoSR");
  const venvPython = path.join(triposrDir, ".venv", "bin", "python3");
  const inferScript = path.join(__dirname, "scripts", "triposr_infer.py");

  if (!fs.existsSync(venvPython)) {
    throw new Error(
      "本地真重建环境未就绪：未找到 TripoSR 虚拟环境（" + venvPython + "）。\n" +
      "请先运行：bash scripts/setup_triposr.sh"
    );
  }
  if (!fs.existsSync(inferScript)) {
    throw new Error("未找到推理脚本: " + inferScript);
  }

  const mcResolution = body.mcResolution ?? rep.mcResolution ?? 256;
  const bakeTexture = body.bakeTexture ?? rep.bakeTexture ?? false;
  const removeBg = body.removeBg ?? rep.removeBg ?? true; // 本地 TriPoSR 默认去背景：带背景会严重拉低重建质量
  const device = body.device ?? rep.device ?? "auto";
  const textureResolution = body.textureResolution ?? rep.textureResolution ?? 2048;
  const chunkSize = body.chunkSize ?? rep.chunkSize ?? 8192;

  const args = [
    inferScript,
    "--image", imgPath,
    "--output", outputPath,
    "--manifest", manifestPath,
    "--device", device,
    "--mc-resolution", String(mcResolution),
    "--texture-resolution", String(textureResolution),
    "--chunk-size", String(chunkSize),
    "--triposr-dir", triposrDir,
  ];
  if (bakeTexture) args.push("--bake-texture");
  if (removeBg) args.push("--remove-bg");

  console.log(`  🧊 图片转3D: 本地 TripoSR 真重建 ${inferScript} (mc=${mcResolution}, bake=${bakeTexture}, device=${device})`);
  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileAsync(venvPython, args, {
      timeout: 900_000, // 单图真重建在 CPU 上需数分钟（含首次权重下载），放宽到 15 分钟
      maxBuffer: 200 * 1024 * 1024,
    });
    stdout = r.stdout || "";
    stderr = r.stderr || "";
  } catch (berr) {
    throw new Error(`TripoSR 推理失败: ${(berr.stderr || berr.stdout || berr.message || "").slice(0, 2000)}`);
  }
  if (stdout) console.log(`  📤 TripoSR stdout:\n${stdout.slice(0, 2000)}`);
  if (stderr) console.log(`  📤 TripoSR stderr:\n${stderr.slice(0, 2000)}`);

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `本地真实重建未生成 GLB 文件。请确认 TripoSR 环境已就绪（bash scripts/setup_triposr.sh）。` +
      `TripoSR stderr: ${stderr.slice(0, 800)}`
    );
  }

  const glbBuffer = fs.readFileSync(outputPath);
  let manifest = { total_parts: 0, parts: [] };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch { /* 用默认 manifest */ }
  }

  // 清理临时文件
  [imgPath, outputPath, manifestPath].forEach(f => {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`  ✅ 图片转3D（本地·真重建）完成 (${(glbBuffer.length / 1024).toFixed(1)} KB, ${elapsed}s)`);
  sendBinaryResult(res, glbBuffer, manifest, elapsed, "img-to-3d");
}


/**
 * AI 配置存储
 */
let AI_CONFIG = {
  provider: 'openai',
  openai: { key: '', model: DEFAULT_MODELS.openai },
  anthropic: { key: '', model: DEFAULT_MODELS.anthropic },
  ollama: { url: 'http://localhost:11434', model: DEFAULT_MODELS.ollama },
  lmstudio: { url: 'http://localhost:1234/v1', model: DEFAULT_MODELS.lmstudio },
  stepfun: { key: '', model: DEFAULT_MODELS.stepfun },
  nvidia: { key: '', model: DEFAULT_MODELS.nvidia, base_url: 'https://integrate.api.nvidia.com/v1' },
  // Kimi（月之暗面 / Moonshot AI）— OpenAI 兼容接口；默认最新旗舰 kimi-k3（原生 1M 上下文）
  kimi: { key: '', model: 'kimi-k3', longContext: false },
  // 生成的三维模型完成后是否自动用 Blender GUI 打开显示（默认开启）
  openInBlender: true,
  // 图片转 3D：mode=local 调用本地 TripoSR 真重建（scripts/triposr_infer.py，离线推理，需先 bash scripts/setup_triposr.sh）；
  //          mode=replicate 走 Replicate 云端（token/owner/name/modelVersion）
  replicate: {
    mode: 'local',
    // 本地真重建（TripoSR）参数
    mcResolution: 256,
    bakeTexture: false,
    removeBg: false,
    device: 'auto',
    textureResolution: 2048,
    token: '',
    owner: 'tencent',
    name: 'hunyuan3d-2',
    modelVersion: ''
  },
  // 图片转 3D 第三方云端提供商（Meshy / Tripo / Hyper3D-Rodin）的 API Key 配置。
  // mode 可直接设为 "meshy" / "tripo" / "hyper3d" 来走对应云端（与 MCP tools 一致）。
  providers: {
    meshy: { apiKey: '', model: 'meshy-6' },
    tripo: { apiKey: '', model: 'v3.1-20260211' },
    hyper3d: { apiKey: '', mode: 'MAIN_SITE' },
  },
};

// 加载保存的配置（与默认值深度合并，避免缺字段导致崩溃）
const CONFIG_FILE = path.join(__dirname, 'ai-config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    AI_CONFIG = {
      ...AI_CONFIG,
      ...loaded,
      openai: { ...AI_CONFIG.openai, ...(loaded.openai || {}) },
      anthropic: { ...AI_CONFIG.anthropic, ...(loaded.anthropic || {}) },
      ollama: { ...AI_CONFIG.ollama, ...(loaded.ollama || {}) },
      lmstudio: { ...AI_CONFIG.lmstudio, ...(loaded.lmstudio || {}) },
      stepfun: { ...AI_CONFIG.stepfun, ...(loaded.stepfun || {}) },
      nvidia: { ...AI_CONFIG.nvidia, ...(loaded.nvidia || {}) },
      kimi: { ...AI_CONFIG.kimi, ...(loaded.kimi || {}) },
      replicate: { ...AI_CONFIG.replicate, ...(loaded.replicate || {}) },
      providers: { ...AI_CONFIG.providers, ...(loaded.providers || {}) },
    };
    console.log('  ✅ AI 配置已加载');
  }
} catch (err) {
  console.log('  ⚠️  无法加载 AI 配置:', err.message);
}

/**
 * 获取 AI 配置
 */
function handleAIConfigGet(req, res) {
  // 返回配置（隐藏 API Key）
  const safeConfig = {
    // 是否已保存过配置文件：用于前端判断「首次使用」引导
    saved: fs.existsSync(CONFIG_FILE),
    // 是否已配置 Replicate Token（不泄露明文，仅供前端决定默认部署方式）
    replicateConfigured: Boolean(AI_CONFIG.replicate && AI_CONFIG.replicate.token),
    provider: AI_CONFIG.provider,
    openai: { ...AI_CONFIG.openai, key: AI_CONFIG.openai.key ? '***' : '' },
    anthropic: { ...AI_CONFIG.anthropic, key: AI_CONFIG.anthropic.key ? '***' : '' },
    ollama: AI_CONFIG.ollama,
    lmstudio: AI_CONFIG.lmstudio,
    stepfun: { ...AI_CONFIG.stepfun, key: AI_CONFIG.stepfun.key ? '***' : '' },
    nvidia: { ...AI_CONFIG.nvidia, key: AI_CONFIG.nvidia.key ? '***' : '' },
    kimi: { ...AI_CONFIG.kimi, key: AI_CONFIG.kimi.key ? '***' : '' },
    replicate: {
      mode: AI_CONFIG.replicate?.mode || 'local',
      mcResolution: AI_CONFIG.replicate?.mcResolution ?? 256,
      bakeTexture: AI_CONFIG.replicate?.bakeTexture ?? false,
      removeBg: AI_CONFIG.replicate?.removeBg ?? false,
      device: AI_CONFIG.replicate?.device || 'auto',
      token: (AI_CONFIG.replicate?.token) ? '***' : '',
      owner: AI_CONFIG.replicate?.owner || 'tencent',
      name: AI_CONFIG.replicate?.name || 'hunyuan3d-2',
      modelVersion: AI_CONFIG.replicate?.modelVersion || '',
    },
    providers: {
      meshy: { apiKey: (AI_CONFIG.providers?.meshy?.apiKey) ? '***' : '' },
      tripo: { apiKey: (AI_CONFIG.providers?.tripo?.apiKey) ? '***' : '' },
      hyper3d: { apiKey: (AI_CONFIG.providers?.hyper3d?.apiKey) ? '***' : '' },
    },
    // 图片转3D 的 VLM 视觉模型路线（无 Key，仅 provider/model）
    vlm: AI_CONFIG.vlm ? { provider: AI_CONFIG.vlm.provider, model: AI_CONFIG.vlm.model } : undefined,
    openInBlender: AI_CONFIG.openInBlender !== false,
  };
  sendJSON(res, 200, safeConfig);
}

/**
 * 保存 AI 配置
 */
function handleAIConfigPost(req, res) {
  readBody(req, { maxSize: 10 * 1024 })
    .then(config => {
      // 保留现有的 API Key（新值为空或脱敏占位 '***' 时视为未修改）
      if (config.openai && (!config.openai.key || config.openai.key === '***')) {
        config.openai.key = AI_CONFIG.openai.key;
      }
      if (config.anthropic && (!config.anthropic.key || config.anthropic.key === '***')) {
        config.anthropic.key = AI_CONFIG.anthropic.key;
      }
      if (config.stepfun && (!config.stepfun.key || config.stepfun.key === '***')) {
        config.stepfun.key = AI_CONFIG.stepfun.key;
      }
      if (config.nvidia && (!config.nvidia.key || config.nvidia.key === '***')) {
        config.nvidia.key = AI_CONFIG.nvidia.key;
      }
      // 保留现有的 Kimi Token（脱敏值 '***' 或空都视为未修改）
      if (config.kimi) {
        const existingKimi = (AI_CONFIG.kimi || {}).key || '';
        if (!config.kimi.key || config.kimi.key === '***') {
          config.kimi.key = existingKimi;
        }
      }
      // 保留现有的 Replicate Token（脱敏值 '***' 或空都视为未修改）
      if (config.replicate) {
        const existing = (AI_CONFIG.replicate || {}).token || '';
        if (!config.replicate.token || config.replicate.token === '***') {
          config.replicate.token = existing;
        }
      }
      // 保留现有的第三方提供商 API Key（脱敏值 '***' 或空都视为未修改）
      if (config.providers) {
        for (const p of ['meshy', 'tripo', 'hyper3d']) {
          const existing = (AI_CONFIG.providers?.[p] || {}).apiKey || '';
          if (!config.providers[p]) config.providers[p] = {};
          if (!config.providers[p].apiKey || config.providers[p].apiKey === '***') {
            config.providers[p].apiKey = existing;
          }
        }
      }
      
      AI_CONFIG = { ...AI_CONFIG, ...config };
      
      // 保存到文件
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(AI_CONFIG, null, 2));
      
      sendJSON(res, 200, { success: true, message: '配置已保存' });
    })
    .catch(err => {
      sendJSON(res, 400, { success: false, error: err.message });
    });
}

/**
 * 测试 AI 连接
 */
async function handleAITest(req, res) {
  try {
    const body = await readBody(req, { maxSize: 10 * 1024 });
    const prompt = body.prompt || 'Hello';
    
    // 根据配置调用相应的 AI
    const result = await callAI(prompt);
    
    sendJSON(res, 200, { success: true, result });
  } catch (err) {
    sendJSON(res, 500, { success: false, error: err.message });
  }
}

/**
 * 轻量探测某个需要鉴权的端点：
 *   - 2xx         → 鉴权通过（key 有效）
 *   - 401/403     → 鉴权失败（key 无效）
 *   - 其它/网络错 → 无法确定（避免误报无效，提示用生成验证）
 * 都不发起真正生成，不消耗额度。
 */
async function probeAuth(method, url, headers, body) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "invalid", message: `API Key 无效（HTTP ${res.status}）`, httpStatus: res.status };
    }
    if (res.ok) {
      return { status: "valid", message: `API Key 有效（HTTP ${res.status}）`, httpStatus: res.status };
    }
    return {
      status: "uncertain",
      message: `无法静态校验（HTTP ${res.status}），建议直接生成一次验证`,
      httpStatus: res.status,
    };
  } catch (err) {
    return { status: "uncertain", message: `无法连接（${err.name === "AbortError" ? "超时" : err.message}），建议直接生成验证`, httpStatus: 0 };
  }
}

// 各厂商的只读/鉴权探测（不消耗额度）
const PROVIDER_PROBES = {
  meshy: (key) =>
    probeAuth("GET", "https://api.meshy.ai/openapi/v1/image-to-3d", {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    }),
  tripo: (key) =>
    probeAuth("GET", "https://openapi.tripo3d.ai/v3/tasks", {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    }),
  // Rodin status 需要 subscription_key，但鉴权失败会返回 401；用占位 key 即可区分「key 是否有效」
  hyper3d: (key) =>
    probeAuth(
      "POST",
      "https://hyperhuman.deemos.com/api/v2/status",
      { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      { subscription_key: "00000000-0000-0000-0000-000000000000" }
    ),
};

/**
 * POST /api/test-provider  { provider, apiKey }
 * 校验某家 3D 生成厂商 API Key 是否有效（只读探测，不生成）
 */
async function handleProviderTest(req, res) {
  try {
    const body = await readBody(req, { maxSize: 10 * 1024 });
    const provider = body.provider;
    const apiKey = (body.apiKey || "").trim();
    const probe = PROVIDER_PROBES[provider];
    if (!probe) {
      sendJSON(res, 400, { status: "invalid", message: `未知提供商: ${provider}` });
      return;
    }
    if (!apiKey) {
      sendJSON(res, 400, { status: "invalid", message: "API Key 为空" });
      return;
    }
    const result = await probe(apiKey);
    sendJSON(res, 200, result);
  } catch (err) {
    sendJSON(res, 500, { status: "uncertain", message: err.message });
  }
}

/**
 * 调用 AI 模型 — 统一路由
 */
async function callAI(prompt) {
  const { provider } = AI_CONFIG;

  // OpenAI 兼容的提供商（共享 /chat/completions 接口）
  const OPENAI_COMPATIBLE = {
    openai: { cfg: AI_CONFIG.openai, url: 'https://api.openai.com/v1', label: 'OpenAI' },
    lmstudio: { cfg: AI_CONFIG.lmstudio, url: AI_CONFIG.lmstudio.url, label: 'LM Studio' },
    stepfun: { cfg: AI_CONFIG.stepfun, url: 'https://api.stepfun.com/v1', label: 'StepFun' },
    nvidia: {
      cfg: AI_CONFIG.nvidia,
      url: AI_CONFIG.nvidia.base_url || 'https://integrate.api.nvidia.com/v1',
      label: 'NVIDIA',
      systemPrompt: '你是一个乐高积木模型专家。根据用户的描述，用标准的乐高砖块拼接出模型。返回 JSON 格式：{ "bricks": [{ "name": "名称", "type": "2x4|2x2|1x2", "position": [x,y,z], "rotation": 0|90|180|270, "color": "red|blue|green" }] }',
    },
    kimi: {
      cfg: AI_CONFIG.kimi,
      url: 'https://api.moonshot.cn/v1',
      label: 'Kimi',
    },
  };

  const compat = OPENAI_COMPATIBLE[provider];
  if (compat) return await callOpenAICompatible(prompt, compat);

  switch (provider) {
    case 'anthropic':
      return await callAnthropic(prompt);
    case 'ollama':
      return await callOllama(prompt);
    default:
      throw new Error('未知的 AI 提供商: ' + provider);
  }
}

/**
 * 调用 OpenAI 兼容接口（OpenAI / LM Studio / StepFun / NVIDIA 共用）
 */
async function callOpenAICompatible(prompt, { cfg, url, label, systemPrompt }) {
  const { key, model } = cfg;
  if (key === '' && label !== 'LM Studio') throw new Error(`${label} API Key 未配置`);

  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  const response = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: model || undefined, messages, temperature: 0.7, max_tokens: 4096 }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `${label} API 错误`);
  return data.choices[0].message.content;
}

/**
 * 调用 Anthropic Claude（独立接口格式）
 */
async function callAnthropic(prompt) {
  const { key, model } = AI_CONFIG.anthropic;
  if (!key) throw new Error('Anthropic API Key 未配置');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.anthropic,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Anthropic API 错误');
  return data.content[0].text;
}

/**
 * 调用 Ollama（本地推理，独立接口格式）
 */
async function callOllama(prompt) {
  const { url, model } = AI_CONFIG.ollama;

  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || DEFAULT_MODELS.ollama, prompt, stream: false }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ollama 错误');
  return data.response;
}

/**
 * 健康检查
 */
async function handleHealth(req, res) {
  try {
    const { stdout } = await execFileAsync(BLENDER_PATH, ["--version"], { timeout: 10_000 });
    const version = stdout.match(/Blender ([\d.]+)/)?.[1] || "unknown";
    sendJSON(res, 200, {
      status: "ok",
      blender: BLENDER_PATH,
      version: version,
      message: `Blender ${version} 可用`,
    });
  } catch (err) {
    sendJSON(res, 503, {
      status: "error",
      blender: BLENDER_PATH,
      message: `Blender 不可用: ${err.message}`,
    });
  }
}

/**
 * 列出 models/generated/ 下已生成的模型（最新在前），供前端「从生成库加载」
 */
async function handleGeneratedList(req, res) {
  try {
    const entries = fs.readdirSync(GENERATED_DIR, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile() && /\.(glb|gltf|stl)$/i.test(e.name))
      .map(e => {
        const full = path.join(GENERATED_DIR, e.name);
        const stat = fs.statSync(full);
        return {
          name: e.name,
          url: `/models/generated/${encodeURIComponent(e.name)}`,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    sendJSON(res, 200, { success: true, files });
  } catch (err) {
    sendJSON(res, 500, { success: false, error: err.message });
  }
}

/**
 * 在本机启动 Blender 应用程序（GUI），用于「一键启动」功能。
 * 仅负责打开应用，不改变 BLENDER_PATH 检测逻辑。
 */
function launchBlenderApp() {
  const platform = os.platform();
  let cmd, args;
  if (platform === "darwin") {
    cmd = "open";
    args = ["-a", "Blender"];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", "blender"];
  } else {
    // Linux：后台启动 blender GUI
    cmd = "blender";
    args = [];
  }
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

/**
 * 一键启动 Blender：打开应用并重新检测可用性
 */
async function handleLaunchBlender(req, res) {
  try {
    launchBlenderApp();
    // 启动后重新检测 Blender CLI 是否可用（GUI 打开不影响 CLI 检测，此处仅做状态反馈）
    let health = null;
    try {
      const { stdout } = await execFileAsync(BLENDER_PATH, ["--version"], { timeout: 10_000 });
      const version = stdout.match(/Blender ([\d.]+)/)?.[1] || "unknown";
      health = { status: "ok", blender: BLENDER_PATH, version };
    } catch {
      health = { status: "error", blender: BLENDER_PATH };
    }
    sendJSON(res, 200, { launched: true, health });
  } catch (err) {
    sendJSON(res, 500, { launched: false, error: err.message });
  }
}

/**
 * 拆解 GLB
 * 修复：blenderStdout/blenderStderr 提到 try 外层，catch 可访问
 */
async function handleSplit(req, res) {
  const startTime = Date.now();
  // 提到外层 try 之前，确保 catch 块可以访问
  let blenderStdout = "";
  let blenderStderr = "";

  try {
    // 1. 解析上传的文件
    const file = await readBody(req, { maxSize: MAX_FILE_SIZE });
    if (!file) {
      sendJSON(res, 400, { error: "未收到文件" });
      return;
    }

    const fileName = file.filename;
    const ext = path.extname(fileName).toLowerCase();
    if (![".glb", ".gltf", ".stl", ".obj"].includes(ext)) {
      sendJSON(res, 400, { error: `不支持的格式: ${ext}，支持 .glb / .gltf / .stl / .obj` });
      return;
    }

    console.log(`\n📦 收到拆解请求: ${fileName} (${(file.data.length / 1024).toFixed(1)} KB)`);

    // 2. 临时文件路径
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputPath = path.join(UPLOAD_DIR, `input-${jobId}${ext}`);
    const outputPath = path.join(UPLOAD_DIR, `output-${jobId}.glb`);
    const manifestPath = path.join(UPLOAD_DIR, `manifest-${jobId}.json`);

    try {
      // 3. 写入临时文件
      fs.writeFileSync(inputPath, file.data);
      console.log(`  📝 临时文件: ${inputPath}`);

      // 4. 调用 Blender
      try {
        const result = await runBlenderSplit(inputPath, outputPath, manifestPath, fileName);
        blenderStdout = result.stdout || "";
        blenderStderr = result.stderr || "";
      } catch (berr) {
        // Blender 进程本身出错（崩溃/超时）
        blenderStdout = berr.stdout || "";
        blenderStderr = berr.stderr || berr.message || "";
      }

      // 打印 Blender 输出到服务器日志
      if (blenderStdout) console.log(`  📤 Blender stdout:\n${blenderStdout.slice(0, 2000)}`);
      if (blenderStderr) console.log(`  📤 Blender stderr:\n${blenderStderr.slice(0, 2000)}`);

      // 5. 检查输出
      if (!fs.existsSync(outputPath)) {
        const detail = (blenderStderr || blenderStdout || "").slice(0, 3000);
        throw new Error(`Blender 未生成输出文件。Blender 日志:\n${detail}`);
      }
      if (!fs.existsSync(manifestPath)) {
        const detail = (blenderStderr || blenderStdout || "").slice(0, 3000);
        throw new Error(`Blender 未生成清单文件。Blender 日志:\n${detail}`);
      }

      // 6. 读取结果
      const outputBuffer = fs.readFileSync(outputPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`  ✅ 拆解完成: ${manifest.total_parts} 个部件 (${elapsed}s)`);

      // 7. 返回二进制 GLB + manifest 头（不再 base64 编码）
      sendBinaryResult(res, outputBuffer, manifest, elapsed, "split");
    } finally {
      // 清理临时文件
      [inputPath, outputPath, manifestPath].forEach(f => {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      });
    }
  } catch (err) {
    console.error(`  ❌ 拆解失败: ${err.message}`);
    sendJSON(res, 500, {
      success: false,
      error: err.message,
      blender_output: blenderStdout || blenderStderr || "",
    });
  }
}

// ── Blender MCP addon 客户端（TCP，行分隔 JSON）────────

/**
 * 向 Blender MCP addon 发送单条命令并返回解析后的 JSON 结果。
 * addon 对每条命令回复一个完整 JSON。
 * @param {string} type   命令类型（如 get_assembly_sequence）
 * @param {object} params 命令参数
 * @param {number} timeoutMs 超时（默认 15s）
 * @returns {Promise<object>} addon 的 result 字段
 */
function callBlenderMcp(type, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      { host: BLENDER_MCP_HOST, port: BLENDER_MCP_PORT },
      () => {
        socket.write(JSON.stringify({ type, params }) + "\n");
      },
    );
    let buf = "";
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("Blender MCP addon 响应超时")),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buf += chunk;
      try {
        const parsed = JSON.parse(buf);
        if (parsed && parsed.status === "error") {
          finish(reject, new Error(parsed.message || "addon error"));
        } else {
          finish(resolve, parsed && "result" in parsed ? parsed.result : parsed);
        }
      } catch {
        /* JSON 尚不完整，继续接收 */
      }
    });
    socket.on("error", err =>
      finish(
        reject,
        new Error(`无法连接 Blender MCP addon (${BLENDER_MCP_HOST}:${BLENDER_MCP_PORT})：${err.message}`),
      ),
    );
    socket.on("end", () => {
      if (!done && buf) {
        try {
          const parsed = JSON.parse(buf);
          finish(resolve, parsed && "result" in parsed ? parsed.result : parsed);
        } catch (e) {
          finish(reject, new Error("addon 响应解析失败: " + e.message));
        }
      }
    });
  });
}

/**
 * GET /api/assembly/sequence?method=distance|size|hierarchy
 * 返回：{ success, order:[名称...], method, count }
 */
async function handleAssemblySequence(req, res, url) {
  const method = url.searchParams.get("method") || "distance";
  try {
    const result = await callBlenderMcp("get_assembly_sequence", { method });
    sendJSON(res, 200, { success: true, ...result });
  } catch (err) {
    sendJSON(res, 502, { success: false, error: err.message });
  }
}

/**
 * GET /api/assembly/analysis?tolerance=0.001
 * 返回：analyze_assembly 的完整结果（含 production_readiness）
 */
async function handleAssemblyAnalysis(req, res, url) {
  const tolerance = Number(url.searchParams.get("tolerance") || 0.001);
  try {
    const result = await callBlenderMcp("analyze_assembly", { tolerance });
    sendJSON(res, 200, { success: true, ...result });
  } catch (err) {
    sendJSON(res, 502, { success: false, error: err.message });
  }
}

// ── 创建 HTTP 服务器 ──────────────────────────────────

const server = http.createServer(
  wrap(async (req, res) => {
    // CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, getCORSHeaders());
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    log.info(`${req.method} ${url.pathname}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
    await handleHealth(req, res);
  } else if (req.method === "GET" && url.pathname === "/api/generated") {
    await handleGeneratedList(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/blender/launch") {
    await handleLaunchBlender(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/split") {
    await handleSplit(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-paint") {
    await handleAIPaint(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/image-to-3d") {
    await handleImageTo3D(req, res);
  } else if (req.method === "GET" && url.pathname === "/api/ai-config") {
    handleAIConfigGet(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-config") {
    handleAIConfigPost(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-test") {
    await handleAITest(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/test-provider") {
    await handleProviderTest(req, res);
  } else if (req.method === "GET" && url.pathname === "/api/assembly/sequence") {
    await handleAssemblySequence(req, res, url);
  } else if (req.method === "GET" && url.pathname === "/api/assembly/analysis") {
    await handleAssemblyAnalysis(req, res, url);
  } else if (req.method === "GET") {
    serveStatic(req, res, url);
  } else {
    sendJSON(res, 404, { error: "Not Found", path: url.pathname });
  }
  })
);

// ── 静态文件服务 ──────────────────────────────────────

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);

  // 安全：防止路径遍历
  if (pathname.includes("..")) {
    sendJSON(res, 403, { error: "Forbidden" });
    return;
  }

  // 默认 index.html
  if (pathname === "/" || pathname === "") {
    pathname = "/index.html";
  }

  const filePath = path.join(__dirname, pathname);

  // 确保文件在 __dirname 下
  if (!filePath.startsWith(__dirname)) {
    sendJSON(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJSON(res, 404, { error: "Not Found", path: pathname });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Content-Length": data.length,
    });
    res.end(data);
  });
}

// ── 启动 ──────────────────────────────────────────────

server.listen(PORT, () => {
  console.log("═".repeat(50));
  console.log("  🔧 GLB 拆解服务器（零依赖版 v2）");
  console.log(`  📡 http://localhost:${PORT}`);
  console.log(`  🎨 Blender: ${BLENDER_PATH}`);
  console.log("═".repeat(50));
  console.log("\n  端点:");
  console.log("    GET  /              — 静态文件 (index.html)");
  console.log("    GET  /api/health   — 健康检查");
  console.log("    POST /api/blender/launch — 一键启动 Blender（GUI）");
  console.log("    POST /api/split    — 拆解 GLB（二进制响应）");
  console.log("    POST /api/ai-paint — AI 绘画（生成3D模型）");
  console.log("    POST /api/image-to-3d — 图片转3D（本地 TripoSR / Replicate / Meshy / Tripo / Hyper3D）");
  console.log("    GET  /api/assembly/sequence — 装配拆解顺序（Blender MCP）");
  console.log("    GET  /api/assembly/analysis — 装配/干涉/可制造性分析（Blender MCP）\n");

  // 启动时检测 Blender
  execFileAsync(BLENDER_PATH, ["--version"], { timeout: 10_000 })
    .then(({ stdout }) => {
      const version = stdout.match(/Blender ([\d.]+)/)?.[1] || "unknown";
      console.log(`  ✅ Blender ${version} 已就绪\n`);
    })
    .catch(() => {
      console.log("  ⚠️  Blender 不可用，服务器仍会运行（前端将回退到 JS 拆解）\n");
    });
});

// ── 进程级异常守卫 ──────────────────────────────────
// 捕获未被 handler 兜住的致命错误，记录结构化日志后退出（由进程管理器重启），
// 避免静默挂死；unhandledRejection 仅记录，不退出（多为可恢复的异步问题）。
process.on("uncaughtException", (err) => {
  log.error("未捕获异常(进程级):", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("未处理的 Promise 拒绝:", reason);
});
