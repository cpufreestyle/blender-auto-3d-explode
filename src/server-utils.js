/**
 * 服务器端工具函数模块
 * 从 server.js 中提取的可独立测试的函数
 */

// ── 安全配置 ──────────────────────────────────────────
export const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150 MB
export const MAX_PARTS = 10; // multipart 最大 part 数量
export const MAX_BOUNDARY_LENGTH = 200; // boundary 最大长度
export const MAX_HEADER_SIZE = 8192; // 单个 multipart part header 最大大小
export const TEMP_FILE_TTL_MS = 60 * 60 * 1000; // 临时文件存活时间：1 小时

// 支持拆解的文件扩展名
export const ALLOWED_EXTENSIONS = [".glb", ".gltf", ".stl", ".obj"];

// ── CORS 头设置 ──────────────────────────────────────

/**
 * 获取标准 CORS 响应头
 * 所有 API 端点共享同一套 CORS 配置
 * @returns {Object} CORS 头对象
 */
export function getCORSHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Manifest",
    "Access-Control-Expose-Headers": "X-Manifest, X-Total-Parts, X-Elapsed-Seconds, X-Success",
  };
}

// ── 文件名消毒 ──────────────────────────────────────

/**
 * 消毒文件名：移除路径分隔符、控制字符等危险字符
 * @param {string} name - 原始文件名
 * @returns {string} 安全的文件名
 */
export function sanitizeFilename(name) {
  // 移除路径分隔符和 ..
  const cleaned = name.replace(/[/\\]/g, "").replace(/\.\./g, "");
  // 移除控制字符
  return cleaned.replace(/[\x00-\x1f\x7f]/g, "");
}

// ── multipart 解析 ────────────────────────────────────

/**
 * 从 Buffer 中解析 multipart 数据（增加安全校验）
 * @param {Buffer} buffer - 请求体
 * @param {string} boundary - multipart boundary（含 --）
 * @returns {Object|null} 解析结果 {fieldname, filename, contentType, data}
 */
export function parseMultipartBuffer(buffer, boundary) {
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
    if (buffer.slice(afterBoundary, afterBoundary + 2).toString() === "--") break;

    // 找下一个 boundary
    const nextBoundary = buffer.indexOf(boundaryBuf, afterBoundary);
    if (nextBoundary === -1) break;

    // 限制 part 数量，防止 DoS
    partCount++;
    if (partCount > MAX_PARTS) {
      throw new Error(`multipart part 数量超过限制 (${MAX_PARTS})`);
    }

    // 关键修复：先更新 start，避免 continue 跳过导致死循环
    start = nextBoundary;

    // 提取 part 数据
    const partData = buffer.slice(afterBoundary, nextBoundary);

    // 校验 part header 大小
    if (partData.length > MAX_HEADER_SIZE && partData.indexOf(Buffer.from("\r\n\r\n")) === -1) {
      throw new Error("multipart part header 过大");
    }

    // 去掉前后的 \r\n
    const partStr = partData.toString("latin1");

    // 解析 headers
    const headerEnd = partStr.indexOf("\r\n\r\n");
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
        fieldname: nameMatch ? nameMatch[1] : "file",
        filename: safeFilename,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
        data: buffer.slice(bodyStart, bodyEnd),
      });
    }
  }

  return parts.length > 0 ? parts[0] : null;
}

// ── 文件扩展名校验 ────────────────────────────────────

/**
 * 检查文件扩展名是否在允许拆解的白名单中
 * @param {string} ext - 扩展名（含 .，如 ".glb"）
 * @returns {boolean}
 */
export function isAllowedExtension(ext) {
  return ALLOWED_EXTENSIONS.includes((ext || "").toLowerCase());
}

// ── Blender 路径候选 ──────────────────────────────────

/**
 * 根据平台返回 Blender 候选路径列表（纯函数，不含 fs 检测）
 * @param {string} platform - os.platform() 返回值
 * @param {string} homeDir - os.homedir() 返回值
 * @param {object} [env] - process.env（Windows 用）
 * @returns {string[]} 候选路径，最后一个是回退值 "blender"
 */
export function findBlenderCandidates(platform, homeDir, env = {}) {
  const candidates = [];
  const pathJoin = (...parts) => parts.join("/").replace(/\/+/g, "/");

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Blender.app/Contents/MacOS/Blender",
      "/Applications/Blender.app/Contents/MacOS/blender",
      pathJoin(homeDir, "Applications/Blender.app/Contents/MacOS/Blender"),
      "/opt/homebrew/bin/blender",
      "/usr/local/bin/blender",
    );
  } else if (platform === "linux") {
    candidates.push(
      "/usr/bin/blender",
      "/usr/local/bin/blender",
      "/snap/bin/blender",
      "/opt/blender/blender",
      pathJoin(homeDir, ".local/bin/blender"),
    );
  } else if (platform === "win32") {
    const programFiles = env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidates.push(
      pathJoin(programFiles, "Blender Foundation", "Blender", "blender.exe"),
      pathJoin(programFilesX86, "Blender Foundation", "Blender", "blender.exe"),
      pathJoin(homeDir, "scoop", "apps", "blender", "current", "blender.exe"),
      "C:/ProgramData/chocolatey/bin/blender.exe",
    );
  }
  candidates.push("blender");
  return candidates;
}

// ── Blender 单飞守卫（纯逻辑）──────────────────────────

/**
 * 创建后台任务串行队列（纯函数工厂，不依赖外部状态）
 * @returns {{ enqueue: (task: () => Promise) => Promise }}
 */
export function createBlenderJobQueue() {
  let chain = Promise.resolve();
  return {
    enqueue(task) {
      const run = chain.then(task, task);
      chain = run.catch(() => {}); // 吞掉异常，避免队列断裂
      return run;
    },
  };
}

// ── 临时文件清理 ──────────────────────────────────────

/**
 * 清理上传目录中超过 TTL 的残留临时文件
 * @param {string} uploadDir - 上传目录路径
 * @param {import('fs')} fs - fs 模块
 * @param {import('path')} path - path 模块
 * @param {number} ttlMs - 文件存活时间（毫秒）
 * @returns {number} 清理的文件数
 */
export function cleanupOldTempFiles(uploadDir, fs, path, ttlMs = TEMP_FILE_TTL_MS) {
  try {
    const files = fs.readdirSync(uploadDir);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      try {
        const stats = fs.statSync(filePath);
        const ageMs = now - stats.mtimeMs;
        if (ageMs > ttlMs) {
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
    return cleaned;
  } catch (err) {
    console.warn(`  ⚠️ 临时文件清理失败: ${err.message}`);
    return 0;
  }
}
