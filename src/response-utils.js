// 响应工具（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的「响应工具」段：sendJSON / respondError / wrap /
// sendBinaryResult / shouldOpenInBlender / saveGeneratedModel /
// openInBlender，以及只服务 openInBlender 的 activeBlenderChild——grep 确认
// 它的读者与写者都只有这一个函数，故随段搬进工厂闭包。
//
// DI / 接缝（createResponseUtils 工厂，与 createStaticServer /
//   createAIConfigHandlers 同构，参数名沿用原名，故段内正文逐字未改）：
//   · GENERATED_DIR / UPLOAD_DIR / BLENDER_PATH 是服务器级配置（前两者依赖
//     __dirname 与 os.tmpdir()，后者依赖启动期 Blender 探测），注入而非各自
//     重建，保证与路由共用同一份；
//   · AI_CONFIG 直接 import（live binding，与 src/ai-call.js 同一套前提），
//     shouldOpenInBlender 因此始终读到最新配置；
//   · 其余依赖（getCORSHeaders / log / fs / path / os）均为纯内置模块或已是
//     独立模块，直接 import；
//   · spawn 与 platform 两个可选参数默认取真实实现（server.js 无需传）：
//     openInBlender 真的会 `spawn` 出 Blender 窗口并在 macOS 上 `open -a`，
//     测试必须能换掉；platform 则是沿用 findBlenderCandidates(platform, ...)
//     的既有做法，让 darwin / 其它平台两条命令行分支都可测。
//   activeBlenderChild 收在闭包内而非模块顶层：每个工厂实例各持一份 GUI
// 子进程句柄，测试之间不会互相看到对方拉起的窗口。
import fs from "fs";
import path from "path";
import os from "os";
import { spawn as spawnChild } from "child_process";
import { getCORSHeaders } from "./server-utils.js";
import { log } from "./logger.js";
import { AI_CONFIG } from "./ai-config.js";

// ── 响应工具 ──────────────────────────────────────────

// 注入服务器级配置；返回的七个函数与 server.js 原先的同名函数一一对应。
export function createResponseUtils({
  GENERATED_DIR,
  UPLOAD_DIR,
  BLENDER_PATH,
  spawn = spawnChild,
  platform = os.platform(),
}) {
  // GUI 单飞守卫：本服务器当前持有的 Blender 子进程（原 server.js「Blender
  // 单飞守卫」段声明，读者与写者都只有 openInBlender）
  let activeBlenderChild = null;


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

  return { sendJSON, respondError, wrap, sendBinaryResult, shouldOpenInBlender, saveGeneratedModel, openInBlender };
}
