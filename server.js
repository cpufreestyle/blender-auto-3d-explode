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

import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

// ── 配置 ──────────────────────────────────────────────
const BLENDER_PATH = process.env.BLENDER_PATH || findBlender();
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_PARTS = 10; // multipart 最大 part 数量
const MAX_BOUNDARY_LENGTH = 200; // boundary 最大长度
const MAX_HEADER_SIZE = 8192; // 单个 multipart part header 最大大小
const TEMP_FILE_TTL_MS = 60 * 60 * 1000; // 临时文件存活时间：1 小时
const UPLOAD_DIR = path.join(os.tmpdir(), 'blender-split-uploads');

// 确保上传目录存在
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── 临时文件清理 ──────────────────────────────────────

/**
 * 清理上传目录中超过 TTL 的残留临时文件
 * 在服务器启动时调用
 */
function cleanupOldTempFiles() {
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      const filePath = path.join(UPLOAD_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        const ageMs = now - stats.mtimeMs;
        if (ageMs > TEMP_FILE_TTL_MS) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // 文件可能已被删除，忽略
      }
    }

    if (cleaned > 0) {
      console.log(`  🧹 清理 ${cleaned} 个残留临时文件`);
    }
  } catch (err) {
    console.warn(`  ⚠️ 临时文件清理失败: ${err.message}`);
  }
}

// 启动时清理
cleanupOldTempFiles();

// ── 工具函数 ──────────────────────────────────────────

/**
 * 在系统中查找 Blender 可执行文件（跨平台支持）
 * 检测顺序：环境变量 > macOS > Linux > Windows > PATH
 */
function findBlender() {
  const platform = os.platform();
  const candidates = [];

  if (platform === 'darwin') {
    // macOS — /Applications, ~/Applications, Homebrew
    candidates.push(
      '/Applications/Blender.app/Contents/MacOS/Blender',
      '/Applications/Blender.app/Contents/MacOS/blender',
      path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'),
      '/opt/homebrew/bin/blender',
      '/usr/local/bin/blender',
    );
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/bin/blender',
      '/usr/local/bin/blender',
      '/snap/bin/blender',
      '/opt/blender/blender',
      path.join(os.homedir(), '.local/bin/blender'),
    );
  } else if (platform === 'win32') {
    // Windows — Program Files, scoop, chocolatey
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(programFiles, 'Blender Foundation', 'Blender', 'blender.exe'),
      path.join(programFilesX86, 'Blender Foundation', 'Blender', 'blender.exe'),
      path.join(os.homedir(), 'scoop', 'apps', 'blender', 'current', 'blender.exe'),
      path.join('C:\\', 'ProgramData', 'chocolatey', 'bin', 'blender.exe'),
    );
  }

  // 最后回退到 PATH 中的 blender
  candidates.push('blender');

  for (const c of candidates) {
    try {
      if (c === 'blender') return c; // 依赖 PATH 解析
      if (fs.existsSync(c)) {
        console.log(`  🔍 检测到 Blender: ${c}`);
        return c;
      }
    } catch { /* ignore */ }
  }
  console.log('  ⚠️  未找到 Blender 可执行文件，将使用 PATH 中的 blender');
  return 'blender';
}

/**
 * 调用 Blender CLI 进行 AI 绘画（生成模型）
 */
async function runBlenderAIPaint(prompt, outputPath, manifestPath, imageFeaturesPath) {
  const scriptPath = path.join(__dirname, 'blender_ai_paint.py');
  const args = [
    '--background',
    '--python', scriptPath,
    '--',
    '--prompt', prompt,
    '--output', outputPath,
    '--manifest', manifestPath,
  ];

  // 如果有图片特征文件，传递给 Blender
  if (imageFeaturesPath) {
    args.push('--image-features', imageFeaturesPath);
  }

  console.log(`  🎨 AI 绘画: ${BLENDER_PATH} ${args.join(' ')}`);

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
  const scriptPath = path.join(__dirname, 'blender_split_glb.py');
  const args = [
    '--background',
    '--python', scriptPath,
    '--',
    '--input', inputPath,
    '--output', outputPath,
    '--manifest', manifestPath,
    '--original-filename', originalFileName,
  ];

  console.log(`  🔧 调用 Blender: ${BLENDER_PATH} ${args.join(' ')}`);

  const { stdout, stderr } = await execFileAsync(BLENDER_PATH, args, {
    timeout: 600_000, // 10 分钟超时（大模型需要更久）
    maxBuffer: 50 * 1024 * 1024,
  });

  return { stdout, stderr };
}

// ── 安全的 multipart 解析器 ────────────────────────────

/**
 * 消毒文件名：移除路径分隔符、控制字符等危险字符
 */
function sanitizeFilename(name) {
  // 移除路径分隔符和 ..
  const cleaned = name.replace(/[/\\]/g, '').replace(/\.\./g, '');
  // 移除控制字符
  return cleaned.replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * 解析 multipart/form-data 请求体
 * 提取上传的文件内容（增加输入校验）
 * @param {http.IncomingMessage} req
 * @returns {Promise<{filename: string, data: Buffer, contentType: string}>}
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) {
      reject(new Error('未找到 multipart boundary'));
      return;
    }

    const boundaryStr = boundaryMatch[1];

    // 校验 boundary 长度，防止恶意构造
    if (boundaryStr.length > MAX_BOUNDARY_LENGTH) {
      reject(new Error('boundary 过长'));
      req.destroy();
      return;
    }

    const boundary = '--' + boundaryStr;
    const chunks = [];
    let totalReceived = 0;

    req.on('data', (chunk) => {
      totalReceived += chunk.length;
      if (totalReceived > MAX_FILE_SIZE) {
        reject(new Error('文件太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const result = parseMultipartBuffer(buffer, boundary);
        if (!result) {
          reject(new Error('未能从请求中提取文件'));
        } else {
          resolve(result);
        }
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

/**
 * 从 Buffer 中解析 multipart 数据（增加安全校验）
 */
function parseMultipartBuffer(buffer, boundary) {
  const boundaryBuf = Buffer.from(boundary);
  const parts = [];
  let start = 0;
  let partCount = 0;

  while (true) {
    const bStart = buffer.indexOf(boundaryBuf, start);
    if (bStart === -1) break;

    // 跳过 boundary 行
    const afterBoundary = bStart + boundaryBuf.length;
    // 检查是否结束
    if (buffer.slice(afterBoundary, afterBoundary + 2).toString() === '--') break;

    // 找下一个 boundary
    const nextBoundary = buffer.indexOf(boundaryBuf, afterBoundary);
    if (nextBoundary === -1) break;

    // 限制 part 数量，防止 DoS
    partCount++;
    if (partCount > MAX_PARTS) {
      throw new Error(`multipart part 数量超过限制 (${MAX_PARTS})`);
    }

    // 提取 part 数据
    const partData = buffer.slice(afterBoundary, nextBoundary);

    // 校验 part header 大小
    if (partData.length > MAX_HEADER_SIZE && partData.indexOf(Buffer.from('\r\n\r\n')) === -1) {
      throw new Error('multipart part header 过大');
    }

    // 去掉前后的 \r\n
    const partStr = partData.toString('latin1');

    // 解析 headers
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerStr = partStr.substring(0, headerEnd);
    const bodyStart = afterBoundary + headerEnd + 4;
    const bodyEnd = nextBoundary - 2; // 去掉 \r\n

    // 提取文件名
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]*)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    if (filenameMatch) {
      const rawFilename = filenameMatch[1];
      // 跳过空文件名
      if (!rawFilename) continue;

      const safeFilename = sanitizeFilename(rawFilename);
      if (!safeFilename) continue;

      parts.push({
        fieldname: nameMatch ? nameMatch[1] : 'file',
        filename: safeFilename,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
        data: buffer.slice(bodyStart, bodyEnd),
      });
    }

    start = nextBoundary;
  }

  return parts.length > 0 ? parts[0] : null;
}

// ── 响应工具 ──────────────────────────────────────────

/**
 * 发送 JSON 响应
 */
function sendJSON(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Manifest',
    'Access-Control-Expose-Headers': 'X-Manifest, X-Total-Parts, X-Elapsed-Seconds, X-Success',
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
  const manifestBase64 = Buffer.from(manifestJson, 'utf-8').toString('base64');

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': glbBuffer.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Manifest',
    'Access-Control-Expose-Headers': 'X-Manifest, X-Total-Parts, X-Elapsed-Seconds, X-Success',
    'X-Success': 'true',
    'X-Total-Parts': String(manifest.total_parts || 0),
    'X-Elapsed-Seconds': elapsed,
    'X-Manifest': manifestBase64,
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
  let blenderStdout = '';
  let blenderStderr = '';

  try {
    // 1. 读取 JSON body
    const body = await readJSONBody(req);
    const prompt = body.prompt || '球体';

    if (typeof prompt !== 'string' || prompt.length > 500) {
      sendJSON(res, 400, { error: '提示词无效或过长（最多500字符）' });
      return;
    }

    const imageFeatures = body.imageFeatures || null;
    console.log(`\n🎨 AI 绘画请求: "${prompt}"${imageFeatures ? ` + 图片特征(${imageFeatures.mood}色调, ${imageFeatures.dominantColors?.length || 0}主色)` : ''}`);

    // 2. 临时文件路径
    const jobId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputPath = path.join(UPLOAD_DIR, `ai-output-${jobId}.glb`);
    const manifestPath = path.join(UPLOAD_DIR, `ai-manifest-${jobId}.json`);

    // 如果有图片特征，写入临时 JSON 文件供 Blender 读取
    let imageFeaturesPath = null;
    if (imageFeatures) {
      imageFeaturesPath = path.join(UPLOAD_DIR, `ai-imgfeat-${jobId}.json`);
      fs.writeFileSync(imageFeaturesPath, JSON.stringify(imageFeatures, null, 2), 'utf-8');
      console.log(`  🖼️ 图片特征已写入: ${imageFeaturesPath}`);
    }

    try {
      // 3. 调用 Blender 生成模型
      try {
        const result = await runBlenderAIPaint(prompt, outputPath, manifestPath, imageFeaturesPath);
        blenderStdout = result.stdout || '';
        blenderStderr = result.stderr || '';
      } catch (berr) {
        blenderStdout = berr.stdout || '';
        blenderStderr = berr.stderr || berr.message || '';
      }

      if (blenderStdout) console.log(`  📤 Blender stdout:\n${blenderStdout.slice(0, 3000)}`);
      if (blenderStderr) console.log(`  📤 Blender stderr:\n${blenderStderr.slice(0, 3000)}`);

      // 4. 检查输出
      if (!fs.existsSync(outputPath)) {
        const detail = (blenderStderr || blenderStdout || '').slice(0, 3000);
        throw new Error(`Blender 未生成 GLB 文件。日志:\n${detail}`);
      }
      if (!fs.existsSync(manifestPath)) {
        const detail = (blenderStderr || blenderStdout || '').slice(0, 3000);
        throw new Error(`Blender 未生成 manifest。日志:\n${detail}`);
      }

      // 5. 读取结果
      const outputBuffer = fs.readFileSync(outputPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`  ✅ AI 绘画完成: ${manifest.total_parts} 个部件 (${elapsed}s, ${(outputBuffer.length / 1024).toFixed(1)} KB)`);

      // 6. 返回二进制 GLB + manifest 头
      sendBinaryResult(res, outputBuffer, manifest, elapsed);

    } finally {
      // 清理临时文件
      [outputPath, manifestPath].forEach(f => {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      });
    }

  } catch (err) {
    console.error(`  ❌ AI 绘画失败: ${err.message}`);
    sendJSON(res, 500, {
      success: false,
      error: err.message,
      blender_output: blenderStdout || blenderStderr || '',
    });
  }
}

/**
 * 读取 JSON 请求体
 */
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalReceived = 0;
    const MAX_JSON_SIZE = 10 * 1024; // 10 KB

    req.on('data', (chunk) => {
      totalReceived += chunk.length;
      if (totalReceived > MAX_JSON_SIZE) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const json = JSON.parse(buffer.toString('utf-8'));
        resolve(json);
      } catch (err) {
        reject(new Error('JSON 解析失败: ' + err.message));
      }
    });

    req.on('error', reject);
  });
}

/**
 * 健康检查
 */
async function handleHealth(req, res) {
  try {
    const { stdout } = await execFileAsync(BLENDER_PATH, ['--version'], { timeout: 10_000 });
    const version = stdout.match(/Blender ([\d.]+)/)?.[1] || 'unknown';
    sendJSON(res, 200, {
      status: 'ok',
      blender: BLENDER_PATH,
      version: version,
      message: `Blender ${version} 可用`,
    });
  } catch (err) {
    sendJSON(res, 503, {
      status: 'error',
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
  let blenderStdout = '';
  let blenderStderr = '';

  try {
    // 1. 解析上传的文件
    const file = await parseMultipart(req);
    if (!file) {
      sendJSON(res, 400, { error: '未收到文件' });
      return;
    }

    const fileName = file.filename;
    const ext = path.extname(fileName).toLowerCase();
    if (!['.glb', '.gltf', '.stl'].includes(ext)) {
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
        blenderStdout = result.stdout || '';
        blenderStderr = result.stderr || '';
      } catch (berr) {
        // Blender 进程本身出错（崩溃/超时）
        blenderStdout = berr.stdout || '';
        blenderStderr = berr.stderr || berr.message || '';
      }

      // 打印 Blender 输出到服务器日志
      if (blenderStdout) console.log(`  📤 Blender stdout:\n${blenderStdout.slice(0, 2000)}`);
      if (blenderStderr) console.log(`  📤 Blender stderr:\n${blenderStderr.slice(0, 2000)}`);

      // 5. 检查输出
      if (!fs.existsSync(outputPath)) {
        const detail = (blenderStderr || blenderStdout || '').slice(0, 3000);
        throw new Error(`Blender 未生成输出文件。Blender 日志:\n${detail}`);
      }
      if (!fs.existsSync(manifestPath)) {
        const detail = (blenderStderr || blenderStdout || '').slice(0, 3000);
        throw new Error(`Blender 未生成清单文件。Blender 日志:\n${detail}`);
      }

      // 6. 读取结果
      const outputBuffer = fs.readFileSync(outputPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`  ✅ 拆解完成: ${manifest.total_parts} 个部件 (${elapsed}s)`);

      // 7. 返回二进制 GLB + manifest 头（不再 base64 编码）
      sendBinaryResult(res, outputBuffer, manifest, elapsed);

    } finally {
      // 清理临时文件
      [inputPath, outputPath, manifestPath].forEach(f => {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      });
    }

  } catch (err) {
    console.error(`  ❌ 拆解失败: ${err.message}`);
    sendJSON(res, 500, {
      success: false,
      error: err.message,
      blender_output: blenderStdout || blenderStderr || '',
    });
  }
}

// ── 创建 HTTP 服务器 ──────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Manifest',
      'Access-Control-Expose-Headers': 'X-Manifest, X-Total-Parts, X-Elapsed-Seconds, X-Success',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    await handleHealth(req, res);
  } else if (req.method === 'POST' && url.pathname === '/api/split') {
    await handleSplit(req, res);
  } else if (req.method === 'POST' && url.pathname === '/api/ai-paint') {
    await handleAIPaint(req, res);
  } else {
    sendJSON(res, 404, { error: 'Not Found', path: url.pathname });
  }
});

// ── 启动 ──────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('═'.repeat(50));
  console.log('  🔧 GLB 拆解服务器（零依赖版 v2）');
  console.log(`  📡 http://localhost:${PORT}`);
  console.log(`  🎨 Blender: ${BLENDER_PATH}`);
  console.log('═'.repeat(50));
  console.log('\n  端点:');
  console.log(`    GET  /api/health   — 健康检查`);
  console.log(`    POST /api/split    — 拆解 GLB（二进制响应）`);
  console.log(`    POST /api/ai-paint — AI 绘画（生成3D模型）\n`);

  // 启动时检测 Blender
  execFileAsync(BLENDER_PATH, ['--version'], { timeout: 10_000 })
    .then(({ stdout }) => {
      const version = stdout.match(/Blender ([\d.]+)/)?.[1] || 'unknown';
      console.log(`  ✅ Blender ${version} 已就绪\n`);
    })
    .catch(() => {
      console.log(`  ⚠️  Blender 不可用，服务器仍会运行（前端将回退到 JS 拆解）\n`);
    });
});
