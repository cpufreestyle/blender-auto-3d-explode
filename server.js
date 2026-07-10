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
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import {
  getCORSHeaders,
  parseMultipartBuffer,
  cleanupOldTempFiles,
  MAX_FILE_SIZE,
  MAX_BOUNDARY_LENGTH,
} from "./src/server-utils.js";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

// ── 配置 ──────────────────────────────────────────────
const BLENDER_PATH = process.env.BLENDER_PATH || findBlender();
const UPLOAD_DIR = path.join(os.tmpdir(), "blender-split-uploads");

// 确保上传目录存在
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) {
      reject(new Error("未找到 multipart boundary"));
      return;
    }

    const boundaryStr = boundaryMatch[1];

    // 校验 boundary 长度，防止恶意构造
    if (boundaryStr.length > MAX_BOUNDARY_LENGTH) {
      reject(new Error("boundary 过长"));
      req.destroy();
      return;
    }

    const boundary = "--" + boundaryStr;
    const chunks = [];
    let totalReceived = 0;

    req.on("data", chunk => {
      totalReceived += chunk.length;
      if (totalReceived > MAX_FILE_SIZE) {
        reject(new Error("文件太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const result = parseMultipartBuffer(buffer, boundary);
        if (!result) {
          reject(new Error("未能从请求中提取文件"));
        } else {
          resolve(result);
        }
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

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
 * 发送二进制 GLB + manifest 头
 * 改进：GLB 以二进制流返回，manifest 通过自定义头传递
 * 节省 33% 带宽（不再 base64 编码）
 */
function sendBinaryResult(res, glbBuffer, manifest, elapsed) {
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
    const body = await readJSONBody(req);
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
      sendBinaryResult(res, outputBuffer, manifest, elapsed);
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
 * AI 配置存储
 */
let AI_CONFIG = {
  provider: 'openai',
  openai: { key: '', model: 'gpt-3.5-turbo' },
  anthropic: { key: '', model: 'claude-3-sonnet-20240229' },
  ollama: { url: 'http://localhost:11434', model: 'codellama' },
  lmstudio: { url: 'http://localhost:1234/v1', model: '' },
  stepfun: { key: '', model: 'step-3.5-flash' },
  nvidia: { key: '', model: 'z-ai/glm-5.2', base_url: 'https://integrate.api.nvidia.com/v1' }
};

// 加载保存的配置
const CONFIG_FILE = path.join(__dirname, 'ai-config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    AI_CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
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
    provider: AI_CONFIG.provider,
    openai: { ...AI_CONFIG.openai, key: AI_CONFIG.openai.key ? '***' : '' },
    anthropic: { ...AI_CONFIG.anthropic, key: AI_CONFIG.anthropic.key ? '***' : '' },
    ollama: AI_CONFIG.ollama,
    lmstudio: AI_CONFIG.lmstudio,
    stepfun: { ...AI_CONFIG.stepfun, key: AI_CONFIG.stepfun.key ? '***' : '' },
    nvidia: { ...AI_CONFIG.nvidia, key: AI_CONFIG.nvidia.key ? '***' : '' }
  };
  sendJSON(res, 200, safeConfig);
}

/**
 * 保存 AI 配置
 */
function handleAIConfigPost(req, res) {
  readJSONBody(req)
    .then(config => {
      // 保留现有的 API Key（如果新值为空）
      if (config.openai && !config.openai.key) {
        config.openai.key = AI_CONFIG.openai.key;
      }
      if (config.anthropic && !config.anthropic.key) {
        config.anthropic.key = AI_CONFIG.anthropic.key;
      }
      if (config.stepfun && !config.stepfun.key) {
        config.stepfun.key = AI_CONFIG.stepfun.key;
      }
      if (config.nvidia && !config.nvidia.key) {
        config.nvidia.key = AI_CONFIG.nvidia.key;
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
    const body = await readJSONBody(req);
    const prompt = body.prompt || 'Hello';
    
    // 根据配置调用相应的 AI
    const result = await callAI(prompt);
    
    sendJSON(res, 200, { success: true, result });
  } catch (err) {
    sendJSON(res, 500, { success: false, error: err.message });
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
      model: model || 'claude-3-sonnet-20240229',
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
    body: JSON.stringify({ model: model || 'codellama', prompt, stream: false }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ollama 错误');
  return data.response;
}

/**
 * 读取 JSON 请求体
 */
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalReceived = 0;
    const MAX_JSON_SIZE = 10 * 1024; // 10 KB

    req.on("data", chunk => {
      totalReceived += chunk.length;
      if (totalReceived > MAX_JSON_SIZE) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const json = JSON.parse(buffer.toString("utf-8"));
        resolve(json);
      } catch (err) {
        reject(new Error("JSON 解析失败: " + err.message));
      }
    });

    req.on("error", reject);
  });
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
    const file = await parseMultipart(req);
    if (!file) {
      sendJSON(res, 400, { error: "未收到文件" });
      return;
    }

    const fileName = file.filename;
    const ext = path.extname(fileName).toLowerCase();
    if (![".glb", ".gltf", ".stl"].includes(ext)) {
      sendJSON(res, 400, { error: `不支持的格式: ${ext}，支持 .glb / .gltf / .stl` });
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
      sendBinaryResult(res, outputBuffer, manifest, elapsed);
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

// ── 创建 HTTP 服务器 ──────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, getCORSHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    await handleHealth(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/split") {
    await handleSplit(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-paint") {
    await handleAIPaint(req, res);
  } else if (req.method === "GET" && url.pathname === "/api/ai-config") {
    handleAIConfigGet(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-config") {
    handleAIConfigPost(req, res);
  } else if (req.method === "POST" && url.pathname === "/api/ai-test") {
    await handleAITest(req, res);
  } else if (req.method === "GET") {
    serveStatic(req, res, url);
  } else {
    sendJSON(res, 404, { error: "Not Found", path: url.pathname });
  }
});

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
  console.log("    POST /api/split    — 拆解 GLB（二进制响应）");
  console.log("    POST /api/ai-paint — AI 绘画（生成3D模型）\n");

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
