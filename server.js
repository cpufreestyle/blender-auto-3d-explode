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
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import {
  getCORSHeaders,
  cleanupOldTempFiles,
  findBlenderCandidates,
} from "./src/server-utils.js";
import { readBody } from "./src/body.js";
import { runHyper3DTextTo3D } from "./src/providers/image-to-3d.js";
import { generateImageTo3D } from "./src/image-to-3d-router.js";
import {
  loadAIConfig,
  autoDetectProvider,
  createAIConfigHandlers,
} from "./src/ai-config.js";
import { log } from "./src/logger.js";
import path from "path";
import os from "os";
import { createStaticServer } from "./src/static-server.js";
import { createBlenderMcpClient } from "./src/blender-mcp-client.js";
import { createClosedLoop } from "./src/closed-loop.js";
import { createResponseUtils } from "./src/response-utils.js";
import { createBlenderRunner } from "./src/blender-runner.js";
import { createGenerateRoutes } from "./src/routes-generate.js";
import { createBlenderRoutes } from "./src/routes-blender.js";
import { callAI } from "./src/ai-call.js";
import { detectProxy } from "./src/proxy-detect.js";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 零配置代理自动探测 ──────────────────────────────
// 实现抽至 src/proxy-detect.js；仍须在下面把 console.* 重定向到结构化
// logger 之前 await 完，否则启动期探测日志会被套上时间戳/级别前缀。
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
// 实现抽至 src/blender-runner.js：串行队列内置在工厂内，runBlenderAIPaint 与
// runBlenderSplit 排到同一条链上，保证任意时刻只有一个 --background Blender
// 在跑；GUI 窗口那一半（activeBlenderChild）在 src/response-utils.js。
const { runBlenderAIPaint, runBlenderSplit } = createBlenderRunner({
  blenderPath: BLENDER_PATH,
  rootDir: __dirname,
  execFile: execFileAsync,
});

// ── 安全的 multipart 解析器 ────────────────────────────
// 解析与输入校验在 src/server-utils.js 的 parseMultipartBuffer，
// 按 Content-Type 分发在 src/body.js 的 readBody。

// ── 响应工具 ──────────────────────────────────────────
// 整段（sendJSON / respondError / wrap / sendBinaryResult /
// shouldOpenInBlender / saveGeneratedModel / openInBlender，以及只服务
// openInBlender 的 activeBlenderChild）抽至 src/response-utils.js；按响应目录 /
// 上传目录 / Blender 路径创建实例，解构出的名字与原先的同名函数一致，路由与
// 下面两个工厂（static-server / closed-loop）的注入方都无需改动。
// 这里只解构 server.js 仍在用的四个；respondError 与 openInBlender 现在分别
// 只被 wrap 与 sendBinaryResult 调用，随模块内部闭环。
const {
  sendJSON,
  wrap,
  sendBinaryResult,
  saveGeneratedModel,
} = createResponseUtils({ GENERATED_DIR, UPLOAD_DIR, BLENDER_PATH });
// ── Blender 类路由（AI 绘画 / 健康检查 / 生成库 / 一键启动 / 拆解）──
// 六个 handler（handleAIPaint / handleHealth / handleGeneratedList /
// launchBlenderApp / handleLaunchBlender / handleSplit）整段抽至
// src/routes-blender.js；它们在 server.js 里原本被「AI 生成类路由」的挂线注释
// 隔成两段不连续，现在合并进同一工厂。BLENDER_PATH 传启动期探测到的路径，
// execFile 传 promisify 后的实现（两个 handler 要跑 `blender --version` 探活）；
// spawn / platform 不传，工厂默认取真实实现——与 createResponseUtils 一致。
const {
  handleAIPaint,
  handleHealth,
  handleGeneratedList,
  launchBlenderApp,
  handleLaunchBlender,
  handleSplit,
} = createBlenderRoutes({
  sendJSON,
  sendBinaryResult,
  runBlenderAIPaint,
  runBlenderSplit,
  UPLOAD_DIR,
  GENERATED_DIR,
  BLENDER_PATH,
  execFile: execFileAsync,
});

// ── AI 生成类路由（图片转3D / 文生3D）──────────────────
// 实现（finishImageTo3D / handleImageTo3D / handleTextTo3D / runLocalTextTo3D）
// 抽至 src/routes-generate.js；本地 Hunyuan3D-2 的脚本与 venv 按仓库根定位，
// 故 rootDir 传本文件的 __dirname。
const { handleImageTo3D, handleTextTo3D } = createGenerateRoutes({
  sendJSON,
  sendBinaryResult,
  IMAGE_TO_3D_DEPS,
  uploadDir: UPLOAD_DIR,
  rootDir: __dirname,
  execFile: execFileAsync,
  generateImageTo3D,
  runHyper3DTextTo3D,
});


// 实现迁至 src/ai-config.js：AI_CONFIG 默认值/落盘加载/首次自动探测与
// probeAuth / PROVIDER_PROBES、/api/ai-config GET·POST、/api/ai-test、
// /api/test-provider 四个 handler 整段搬迁，行为不变。
// AI_CONFIG 以 ESM live binding 导出：src/ai-call.js 的 callAI、
// src/routes-blender.js 的 handleSplit、src/routes-generate.js 的图片转3D
// 编排直接读到的即最新值（POST 保存后整体换新对象）。
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
// 实现（waitForBlenderAddon / handleGenToBlender / handleBlenderExport）抽至
// src/closed-loop.js；lastImportedObject 的读写随之封闭在新模块内（grep 确认原
// 先没有任何外部读者），这里只创建闭合并把两个 handler 接进下方路由。
const { handleGenToBlender, handleBlenderExport } = createClosedLoop({
  sendJSON,
  generateImageTo3D,
  callBlenderMcp,
  launchBlenderApp,
  saveGeneratedModel,
  IMAGE_TO_3D_DEPS,
  UPLOAD_DIR,
  rootDir: __dirname,
});

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
