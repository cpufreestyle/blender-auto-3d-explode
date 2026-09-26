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
  findBlenderCandidates,
  createBlenderJobQueue,
  isAllowedExtension,
  elapsedSeconds,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
} from "./src/server-utils.js";
import { readBody } from "./src/body.js";
import { runHyper3DTextTo3D } from "./src/providers/image-to-3d.js";
import { generateImageTo3D } from "./src/image-to-3d-router.js";
import {
  AI_CONFIG,
  loadAIConfig,
  autoDetectProvider,
  createAIConfigHandlers,
} from "./src/ai-config.js";
import { log } from "./src/logger.js";
import path from "path";
import os from "os";
import { createStaticServer } from "./src/static-server.js";
import { createBlenderMcpClient } from "./src/blender-mcp-client.js";
import { callAI } from "./src/ai-call.js";
import { fileURLToPath } from "url";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 零配置代理自动探测 ──────────────────────────────
// 让 server 开箱即用：若已设置 HTTP(S)_PROXY 则直接用；否则探测本机常见代理端口
// （Clash 7897/7890、1080、8080），命中即用 undici ProxyAgent 接管全局 fetch。
// 这样外网 API（TokenDance / Tripo / Meshy 等）无需再手动 --require proxy-bootstrap.cjs。
async function detectProxy() {
  const envProxy =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.http_proxy;
  if (envProxy) {
    try {
      setGlobalDispatcher(new ProxyAgent({ uri: envProxy, connect: { rejectUnauthorized: false } }));
      console.log(`  🌐 使用环境变量代理: ${envProxy}`);
      return;
    } catch (e) {
      console.warn(`  ⚠️ 环境变量代理无效，忽略: ${e.message}`);
    }
  }
  const candidates = ["127.0.0.1:7897", "127.0.0.1:7890", "127.0.0.1:1080", "127.0.0.1:8080"];
  for (const c of candidates) {
    const [host, port] = c.split(":");
    const reachable = await new Promise((resolve) => {
      const sock = net.createConnection({ host, port: Number(port), timeout: 400 });
      sock.once("connect", () => { try { sock.destroy(); } catch {} resolve(true); });
      sock.once("error", () => { try { sock.destroy(); } catch {} resolve(false); });
      sock.once("timeout", () => { try { sock.destroy(); } catch {} resolve(false); });
    });
    if (reachable) {
      try {
        setGlobalDispatcher(new ProxyAgent({ uri: `http://${c}`, connect: { rejectUnauthorized: false } }));
        console.log(`  🌐 已自动启用本机代理: http://${c}`);
        return;
      } catch { }
    }
  }
  console.log("  ℹ️ 未检测到本机代理；外网 API（TokenDance/Tripo 等）如需访问请启动代理或设置 HTTP_PROXY");
}
await detectProxy();

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

// 图片转3D 调度器所需的进程级能力（注入 src/image-to-3d-router.js，便于单测用假 deps）
const IMAGE_TO_3D_DEPS = {
  fs,
  path,
  os,
  spawn,
  execFile: execFileAsync,
  blenderPath: BLENDER_PATH,
  uploadDir: UPLOAD_DIR,
  rootDir: __dirname,
};

// 确保上传目录存在
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(GENERATED_DIR, { recursive: true });

// 启动时清理残留临时文件（上传目录 + 生成目录，防止磁盘随使用无限增长）
cleanupOldTempFiles(UPLOAD_DIR, fs, path);
cleanupOldTempFiles(GENERATED_DIR, fs, path);

// 每小时定时清理一次，避免 models/generated 与上传目录持续堆积
const TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const tempCleanupTimer = setInterval(() => {
  cleanupOldTempFiles(UPLOAD_DIR, fs, path);
  cleanupOldTempFiles(GENERATED_DIR, fs, path);
}, TEMP_CLEANUP_INTERVAL_MS);
tempCleanupTimer.unref?.();

// ── 工具函数 ──────────────────────────────────────────

/**
 * 在系统中查找 Blender 可执行文件（跨平台支持）
 * 检测顺序：环境变量 > macOS > Linux > Windows > PATH
 */
function findBlender() {
  const candidates = findBlenderCandidates(os.platform(), os.homedir(), process.env);
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
  console.log("  ⚠️  未找到 Blender 可执行文件，将尝试使用 PATH 中的 blender");
  console.log("     💡 若后续报错「spawn blender ENOENT」，说明本机 Blender 不在 PATH，任选其一：");
  console.log("        1) 显式指定路径后再启动：");
  console.log('           set BLENDER_PATH=D:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe');
  console.log("           node server.js");
  console.log("        2) 把 Blender 安装目录加入系统 PATH；");
  console.log("        3) 直接运行 start.bat 或 start-blender-all.ps1（会自动探测本机 Blender）。");
  return "blender";
}

// ── Blender 单飞守卫 ──────────────────────────────────
// 确保本服务器进程同一时刻最多只持有「一个」Blender：
//   · 后台任务（拆解 / AI 绘画，均为 --background 无窗口）串行执行，互不重叠；
//   · GUI 打开前先结束上一个由本服务器拉起的 Blender，避免窗口堆叠。
// 注：常驻的 Blender MCP 宿主（用户自行启动、监听 9876）不在此管理范围内，保留不动。

let activeBlenderChild = null;          // 本服务器当前持有的 Blender 子进程（GUI）
const blenderJobQueue = createBlenderJobQueue();

/** 后台 Blender 任务串行器：保证任意时刻只有一个 --background Blender 在跑 */
function enqueueBlenderJob(task) {
  return blenderJobQueue.enqueue(task);
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

  // 单飞守卫：与其他后台 Blender 任务串行，确保同一时刻只跑一个
  return enqueueBlenderJob(() =>
    execFileAsync(BLENDER_PATH, args, {
      timeout: 120_000, // 2 分钟超时
      maxBuffer: 50 * 1024 * 1024,
    })
  );
}

/**
 * 调用 Blender CLI 拆解 GLB
 */
async function runBlenderSplit(inputPath, outputPath, manifestPath, originalFileName, vlm = null) {
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

  // 可选的 VLM 部件语义标注：把 provider/model 作为命令行参数传入；
  // API Key 只通过环境变量 VLM_API_KEY 安全传递（绝不出现在命令行，避免 ps 泄露）。
  let env = process.env;
  if (vlm && vlm.provider) {
    args.push("--vlm-provider", vlm.provider);
    if (vlm.model) args.push("--vlm-model", vlm.model);
    if (vlm.key) env = { ...process.env, VLM_API_KEY: vlm.key };
  }

  console.log(`  🔧 调用 Blender: ${BLENDER_PATH} ${args.join(" ")}`);

  // 单飞守卫：与其他后台 Blender 任务串行，确保同一时刻只跑一个
  return enqueueBlenderJob(() =>
    execFileAsync(BLENDER_PATH, args, {
      timeout: 600_000, // 10 分钟超时（大模型需要更久）
      maxBuffer: 50 * 1024 * 1024,
      env,
    })
  );
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
 * 默认关闭（避免每次生成都弹出 Blender 窗口）；可用环境变量强制覆盖：
 *   OPEN_IN_BLENDER=0 强制关闭，OPEN_IN_BLENDER=1 强制开启。
 * 否则跟随配置（ai-config.json 的 openInBlender 字段）。
 */
function shouldOpenInBlender() {
  if (process.env.OPEN_IN_BLENDER === "0") return false;
  if (process.env.OPEN_IN_BLENDER === "1") return true;
  return AI_CONFIG.openInBlender === true;
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
 * 用 Blender GUI 打开指定 GLB（fire-and-forget，不阻塞响应）
 * 每次调用都会拉起一个新的 Blender 窗口；新窗口就绪后，自动关闭上一个窗口。
 * 配合全局单飞守卫（activeBlenderChild 跟踪 + 旧窗口延迟关闭），保证本服务器最多只弹出一个 Blender 窗口。
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

  // 记录旧窗口进程，待新窗口拉起并加载完成后自动关闭（单飞守卫：同一时刻只有一个 GUI Blender）
  const prevChild = activeBlenderChild;
  activeBlenderChild = null;

  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  activeBlenderChild = child;

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

      const elapsed = elapsedSeconds(startTime);
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
  const outputPath = path.join(UPLOAD_DIR, `txt3d-${jobId}.glb`);
  const manifestPath = path.join(UPLOAD_DIR, `txt3d-${jobId}.json`);

  const inferScript = path.join(__dirname, "scripts", "hunyuan3d_text_infer.py");
  // 优先用显式 python（HY3D_PYTHON），否则尝试本地克隆的 venv，最后回退系统 python3
  const hunyuanDir = process.env.HUNYUAN3D_DIR || path.join(__dirname, "external", "Hunyuan3D-2");
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
    const r = await execFileAsync(pythonBin, args, {
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


// 实现迁至 src/ai-config.js：AI_CONFIG 默认值/落盘加载/首次自动探测与
// probeAuth / PROVIDER_PROBES、/api/ai-config GET·POST、/api/ai-test、
// /api/test-provider 四个 handler 整段搬迁，行为不变。
// AI_CONFIG 以 ESM live binding 导出：本文件下方 callAI / handleSplit /
// 图片转3D 编排直接读到的即最新值（POST 保存后整体换新对象）。
// readBody / sendJSON / callAI 经工厂注入（handleAITest 运行期才调用）。
loadAIConfig();
await autoDetectProvider();
const {
  handleAIConfigGet,
  handleAIConfigPost,
  handleAITest,
  handleProviderTest,
} = createAIConfigHandlers({ readBody, sendJSON, callAI });

/**
 * 调用 AI 模型 — 统一路由
 *
 * 四层调度（callAI / callOpenAICompatible / callAnthropic / callOllama）
 * 已抽至 src/ai-call.js：AI_CONFIG 经 ESM live binding 读到最新值，
 * DEFAULT_MODELS 仍取 src/provider-models.js 单一来源。
 */


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
    // 优先使用已探测到的 BLENDER_PATH（可能是非 PATH 的官方安装版，如 D 盘），
    // 否则回退到 PATH 中的 blender。避免装了 Blender 却因不在 PATH 而启动失败。
    const exe = BLENDER_PATH && BLENDER_PATH !== "blender" ? BLENDER_PATH : "blender";
    cmd = "cmd";
    args = ["/c", "start", "", exe];
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
    if (!isAllowedExtension(ext)) {
      sendJSON(res, 400, { error: `不支持的格式: ${ext}，支持 ${ALLOWED_EXTENSIONS.join(" / ")}` });
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
        // 是否启用 VLM 部件语义标注：需同时开启 semanticLabel、配置 vlm provider/model，
        // 且对应 provider（openai/stepfun/kimi/anthropic）已填 API Key；否则跳过。
        let vlm = null;
        if (AI_CONFIG.semanticLabel && AI_CONFIG.vlm && AI_CONFIG.vlm.provider) {
          const prov = AI_CONFIG.vlm.provider;
          const key = (AI_CONFIG[prov] && AI_CONFIG[prov].key) || "";
          if (key) {
            vlm = { provider: prov, model: AI_CONFIG.vlm.model || "", key };
          } else {
            console.warn(`  ⚠️ 已开启语义标注但未配置 ${prov} 的 API Key，跳过 VLM 标注`);
          }
        }
        const result = await runBlenderSplit(inputPath, outputPath, manifestPath, fileName, vlm);
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

      const elapsed = elapsedSeconds(startTime);
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
// 整段（含两个 MCP 地址常量）已抽至 src/blender-mcp-client.js；
// 无参创建即用默认 localhost:9876，与原实现一致。
const callBlenderMcp = createBlenderMcpClient();

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

// ── 全自动闭环：云端生成 → 导入 Blender 实时场景 → 读回 ──────────

// 记录最近一次由本服务器导入 Blender 的对象名，供「读回」默认使用。
let lastImportedObject = null;

/**
 * 等待 Blender MCP addon(9876) 就绪；autoLaunch 为真时先尝试拉起 Blender GUI。
 * @returns {Promise<boolean>} 是否就绪
 */
async function waitForBlenderAddon({ autoLaunch = true, timeoutMs = 30_000 } = {}) {
  const probe = async () => {
    try {
      await callBlenderMcp("get_addon_status", {}, 2000);
      return true;
    } catch {
      return false;
    }
  };
  if (await probe()) return true;
  if (!autoLaunch) return false;
  try {
    launchBlenderApp();
  } catch {
    /* 拉不起来就继续轮询 */
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    if (await probe()) return true;
  }
  return false;
}

/**
 * POST /api/gen-to-blender
 * Body: { image: "data:image/...;base64,...", deploy?: "tripo"|"meshy"|"hyper3d", name?, autoLaunch? }
 * 全自动：云端生成 GLB → 落盘 → 导入 Blender 实时场景 → 返回导入对象与场景信息。
 */
async function handleGenToBlender(req, res) {
  const startTime = Date.now();
  try {
    const body = await readBody(req, { maxSize: 25 * 1024 * 1024 });
    const imageDataUrl = body.image;
    if (!imageDataUrl || !imageDataUrl.startsWith("data:image/")) {
      sendJSON(res, 400, { success: false, error: "缺少有效的图片数据（image 字段应为 data URL）" });
      return;
    }
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(imageDataUrl);
    if (!match) {
      sendJSON(res, 400, { success: false, error: "图片 data URL 格式错误" });
      return;
    }
    const imageBase64 = match[2];
    // 只允许三家云端 provider（历史默认 tripo），其余值一律按 tripo 处理
    const mode = ["meshy", "tripo", "hyper3d"].includes(body.deploy) ? body.deploy : "tripo";

    // 1. 云端生成 GLB（统一走图片转3D 调度器，与 /api/image-to-3d 同一实现）
    const out = await generateImageTo3D({
      mode,
      body,
      imageBase64,
      mime: match[1],
      config: AI_CONFIG,
      deps: IMAGE_TO_3D_DEPS,
    });

    // 2. 落盘（持久化，便于后续拆解/复现）
    const savedPath = saveGeneratedModel(out.glbBuffer, `${mode}-to-blender`);
    // 供前端直接取回展示的相对 URL（静态服务托管 models/generated/）
    const modelUrl = "/" + path.relative(__dirname, savedPath).split(path.sep).join("/");

    // 3. 确保 Blender MCP addon 就绪（必要时自动拉起 Blender GUI）
    const ready = await waitForBlenderAddon({ autoLaunch: body.autoLaunch !== false });
    if (!ready) {
      sendJSON(res, 502, {
        success: false,
        savedPath,
        modelUrl,
        error:
          "Blender MCP addon 未就绪（9876 未监听）。请打开 Blender 并在侧栏点击「Connect to MCP server」后重试。",
      });
      return;
    }

    // 4. 导入 Blender 实时场景
    const name = body.name || `${mode}_model`;
    const imported = await callBlenderMcp("import_glb_from_file", { filepath: savedPath, name }, 120_000);
    if (!imported || imported.succeed === false) {
      sendJSON(res, 502, { success: false, savedPath, error: (imported && imported.error) || "导入 Blender 失败" });
      return;
    }
    lastImportedObject = imported.name || name;

    // 5. 回传场景信息
    let scene = null;
    try {
      scene = await callBlenderMcp("get_scene_info", {}, 10_000);
    } catch {
      /* 非致命：场景信息拿不到也视为导入成功 */
    }

    sendJSON(res, 200, {
      success: true,
      elapsed: elapsedSeconds(startTime),
      savedPath,
      modelUrl,
      imported,
      scene,
    });
  } catch (err) {
    sendJSON(res, err.status || 500, { success: false, error: err.message });
  }
}

/**
 * GET /api/blender/export?name=<对象名>
 * 从 Blender 实时场景导出指定对象为 GLB（默认导出最近一次导入的对象），二进制回传。
 */
async function handleBlenderExport(req, res, url) {
  let name = url.searchParams.get("name") || lastImportedObject;

  // 无显式对象名时，回退到 Blender 当前激活对象 / 场景首个网格对象，
  // 使「从 Blender 读回」在用户未先执行「生成并发送」时也能使用。
  if (!name) {
    try {
      const pick = await callBlenderMcp(
        "execute_code",
        {
          code:
            "import bpy; a=bpy.context.active_object; " +
            "mesh=[o.name for o in bpy.data.objects if o.type=='MESH']; " +
            "print((a.name if (a and a.type=='MESH') else (mesh[0] if mesh else '')))",
        },
        10_000,
      );
      const picked = String((pick && pick.result) || "").trim();
      if (picked) name = picked;
    } catch {
      /* 忽略探测错误，交给下方 400 处理 */
    }
  }

  if (!name) {
    sendJSON(res, 400, {
      success: false,
      error: "Blender 场景中尚无可导出的网格对象，请先在 Blender 中创建或导入对象后再读回",
    });
    return;
  }
  const exportPath = path.join(UPLOAD_DIR, `export-${Date.now()}.glb`);
  try {
    const result = await callBlenderMcp("export_object_glb", { name, filepath: exportPath }, 120_000);
    if (!result || result.succeed === false) {
      sendJSON(res, 502, { success: false, error: (result && result.error) || "从 Blender 导出失败" });
      return;
    }
    if (!fs.existsSync(exportPath)) {
      sendJSON(res, 502, { success: false, error: "导出文件不存在" });
      return;
    }
    const buf = fs.readFileSync(exportPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": buf.length,
      "X-Object-Name": encodeURIComponent(name),
      ...getCORSHeaders(),
    });
    res.end(buf);
  } catch (err) {
    sendJSON(res, 502, { success: false, error: err.message });
  } finally {
    try {
      fs.unlinkSync(exportPath);
    } catch {
      /* 文件不存在则忽略 */
    }
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
  } else if (req.method === "POST" && url.pathname === "/api/text-to-3d") {
    await handleTextTo3D(req, res);
  } else if (req.method === "GET" && url.pathname === "/api/ai-config") {
    handleAIConfigGet(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-config") {
    handleAIConfigPost(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-test") {
    await handleAITest(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/test-provider") {
    await handleProviderTest(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/gen-to-blender") {
    await handleGenToBlender(req, res);
  } else if (req.method === "GET" && url.pathname === "/api/blender/export") {
    await handleBlenderExport(req, res, url);
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
// MIME 映射 / 三段式缓存策略 / 协商缓存 / gzip / 流式直出已抽至
// src/static-server.js；serveStatic 在此绑定 server.js 的 sendJSON，
// 供下面 createServer 的 GET 兜底路由调用。
const serveStatic = createStaticServer({ sendJSON });

// ── 启动 ──────────────────────────────────────────────

// 端口/权限类错误的可操作中文提示（否则会落到进程级 uncaughtException 打英文堆栈）
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`\n  ❌ 端口 ${PORT} 已被占用（可能还有一个 node server.js 在跑）。`);
    console.error("     💡 解决办法（任选其一）：");
    console.error(`        1) 关掉占用进程：netstat -ano | findstr :${PORT}  →  taskkill /PID <PID> /F`);
    console.error("        2) 换个端口启动：set PORT=3002 && node server.js");
    console.error("");
    process.exit(1);
  }
  if (err && err.code === "EACCES") {
    console.error(`\n  ❌ 没有权限监听端口 ${PORT}（该端口被系统保留或受保护）。`);
    console.error("     💡 换一个大于 1024 的端口：set PORT=3002 && node server.js\n");
    process.exit(1);
  }
  log.error("服务器错误:", err);
});

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
  console.log("    POST /api/gen-to-blender   — 云端生成 → 自动导入 Blender 实时场景");
  console.log("    GET  /api/blender/export   — 从 Blender 导出对象 GLB（读回）");
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
