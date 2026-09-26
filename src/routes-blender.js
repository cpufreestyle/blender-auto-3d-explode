// Blender 类路由（AI 绘画 / 健康检查 / 生成库 / 一键启动 / 拆解）。
//
// 搬迁 server.js「路由处理」段里除 AI 生成类之外的六个 handler：handleAIPaint
// （POST /api/ai-paint）、handleHealth（GET /api/health）、handleGeneratedList、
// handleLaunchBlender 与只服务它的 launchBlenderApp、handleSplit
// （POST /api/split）。前四个在 server.js 里被「AI 生成类路由」的挂线注释隔成
// 两段不连续，但同属 Blender 侧路由，合并进同一工厂；两处调用点一字未改。
//
// DI / 接缝（createBlenderRoutes 工厂，与 createGenerateRoutes /
//   createBlenderRunner 同构，参数名沿用原名，故段内正文逐字未改）：
//   · sendJSON / sendBinaryResult 是响应工具的两个出口（src/response-utils.js），
//     注入以便测试断言；
//   · runBlenderAIPaint / runBlenderSplit 是 Blender 单飞队列的两个出口
//     （src/blender-runner.js），注入后测试用假实现即可跑完整条链路，不必真装
//     Blender，也不必担心真的拉起 GUI；
//   · UPLOAD_DIR / GENERATED_DIR / BLENDER_PATH 是服务器级配置，注入而非各自
//     重建，保证与启动期清理、/api/image-to-3d 共用同一份；
//   · execFile 注入 promisify 后的实现：handleHealth 与 handleLaunchBlender 都要
//     跑 `blender --version` 探活，测试用假实现即可断言超时与版本解析；
//   · spawn 与 platform 两个可选参数默认取真实实现（server.js 无需传）：
//     launchBlenderApp 真的会 spawn 出 Blender GUI，测试必须能换掉；platform
//     沿用 createResponseUtils / findBlenderCandidates 的既有做法，让 darwin /
//     win32 / 其它三条分支都可测；
//   · AI_CONFIG / readBody / elapsedSeconds / fs / path / os / MAX_FILE_SIZE /
//     isAllowedExtension / ALLOWED_EXTENSIONS 直接 import（AI_CONFIG 是 live
//     binding，与 src/ai-call.js 同一套前提）。
import fs from "fs";
import path from "path";
import os from "os";
import { spawn as spawnChild } from "child_process";
import { readBody } from "./body.js";
import { AI_CONFIG } from "./ai-config.js";
import {
  elapsedSeconds,
  isAllowedExtension,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
} from "./server-utils.js";

// 依赖全部带名注入，便于测试用假 sendJSON / 假 Blender runner 驱动四个路由。
export function createBlenderRoutes({
  sendJSON,
  sendBinaryResult,
  runBlenderAIPaint,
  runBlenderSplit,
  UPLOAD_DIR,
  GENERATED_DIR,
  BLENDER_PATH,
  execFile,
  spawn = spawnChild,
  platform = os.platform(),
}) {
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
 * 健康检查
 */
async function handleHealth(req, res) {
  try {
    const { stdout } = await execFile(BLENDER_PATH, ["--version"], { timeout: 10_000 });
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
  // platform 由工厂注入（默认 os.platform()，与原实现一致），
  // 原实现里那句 `const platform = os.platform()` 会把它遮掉，测试便无从替换
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
      const { stdout } = await execFile(BLENDER_PATH, ["--version"], { timeout: 10_000 });
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
  return {
    handleAIPaint,
    handleHealth,
    handleGeneratedList,
    launchBlenderApp,
    handleLaunchBlender,
    handleSplit,
  };
}
