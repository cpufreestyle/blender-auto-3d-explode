#!/usr/bin/env node
/**
 * GLB 拆解服务器（零依赖版 — 仅使用 Node.js 内置模块）
 *
 * 功能：
 *   POST /api/split  —  接收 GLB 文件，调用 Blender CLI 拆解，返回拆解后的 GLB + JSON 清单
 *   GET  /api/health —  健康检查（检测 Blender 是否可用）
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
const UPLOAD_DIR = path.join(os.tmpdir(), 'blender-split-uploads');

// 确保上传目录存在
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── 工具函数 ──────────────────────────────────────────

/**
 * 在系统中查找 Blender 可执行文件
 */
function findBlender() {
  const candidates = [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender',
    '/usr/local/bin/blender',
    '/snap/bin/blender',
    'blender', // 依赖 PATH
  ];
  for (const c of candidates) {
    try {
      if (c === 'blender') return c; // 依赖 PATH 解析
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return 'blender';
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

/**
 * 解析 multipart/form-data 请求体
 * 提取上传的文件内容
 * @param {http.IncomingMessage} req
 * @returns {Promise<{filename: string, data: Buffer, contentType: string}>}
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      reject(new Error('未找到 multipart boundary'));
      return;
    }

    const boundary = '--' + boundaryMatch[1];
    const chunks = [];

    req.on('data', (chunk) => {
      const totalSize = chunks.reduce((sum, c) => sum + c.length, 0) + chunk.length;
      if (totalSize > MAX_FILE_SIZE) {
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
 * 从 Buffer 中解析 multipart 数据
 */
function parseMultipartBuffer(buffer, boundary) {
  const boundaryBuf = Buffer.from(boundary);
  const parts = [];

  let start = 0;
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

    // 提取 part 数据
    const partData = buffer.slice(afterBoundary, nextBoundary);
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
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    if (filenameMatch && filenameMatch[1]) {
      parts.push({
        fieldname: nameMatch ? nameMatch[1] : 'file',
        filename: filenameMatch[1],
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
        data: buffer.slice(bodyStart, bodyEnd),
      });
    }

    start = nextBoundary;
  }

  return parts.length > 0 ? parts[0] : null;
}

/**
 * 发送 JSON 响应
 */
function sendJSON(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

// ── 路由处理 ──────────────────────────────────────────

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
 */
async function handleSplit(req, res) {
  const startTime = Date.now();

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
      let blenderStdout = '', blenderStderr = '';
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

      // 7. 返回结果
      sendJSON(res, 200, {
        success: true,
        parts: manifest.parts,
        total_parts: manifest.total_parts,
        model_center: manifest.model_center,
        model_size: manifest.model_size,
        elapsed_seconds: parseFloat(elapsed),
        glb_base64: outputBuffer.toString('base64'),
      });

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
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    await handleHealth(req, res);
  } else if (req.method === 'POST' && url.pathname === '/api/split') {
    await handleSplit(req, res);
  } else {
    sendJSON(res, 404, { error: 'Not Found', path: url.pathname });
  }
});

// ── 启动 ──────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('═'.repeat(50));
  console.log('  🔧 GLB 拆解服务器（零依赖版）');
  console.log(`  📡 http://localhost:${PORT}`);
  console.log(`  🎨 Blender: ${BLENDER_PATH}`);
  console.log('═'.repeat(50));
  console.log('\n  端点:');
  console.log(`    GET  /api/health  — 健康检查`);
  console.log(`    POST /api/split   — 拆解 GLB\n`);

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
