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
    // 优先用小写 blender 启动器：macOS 上大写 Blender 是裸 Mach-O 二进制，
    // 经 child_process.execFile 调用时可能把它自身误当成 .blend 文件解析而报
    // 「文件格式不支持」。小写 blender 是独立启动器，能正确传递参数。
    candidates.push(
      "/Applications/Blender.app/Contents/MacOS/blender",
      "/Applications/Blender.app/Contents/MacOS/Blender",
      pathJoin(homeDir, "Applications/Blender.app/Contents/MacOS/blender"),
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
      // 本机实际安装路径（官方安装版，装在 D 盘）：Blender 5.2 LTS
      "D:/Program Files/Blender Foundation/Blender 5.2/blender.exe",
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

// ── 子进程等待守卫 ────────────────────────────────────

/**
 * 等待子进程退出；超时则先杀死子进程再拒绝，避免调用方无限挂起。
 * resolve 值为退出码（含非零码），由调用方结合 stderr 构造错误信息。
 * @param {import('child_process').ChildProcess} child - 已启动的子进程
 * @param {number} timeoutMs - 超时上限，0 表示不设上限
 * @param {string} label - 超时错误信息中的进程描述
 * @returns {Promise<number>} 子进程退出码
 */
export function waitForChildExit(child, timeoutMs = 0, label = "子进程") {
  return new Promise((resolve, reject) => {
    let timer = null;
    const settle = (fn, arg) => {
      if (timer) clearTimeout(timer);
      timer = null;
      fn(arg);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        const secs = Math.max(1, Math.round(timeoutMs / 1000));
        settle(reject, new Error(`${label} 超时（超过 ${secs} 秒未退出）`));
      }, timeoutMs);
    }
    child.on("close", (code) => settle(resolve, code));
    child.on("error", (err) => settle(reject, err));
  });
}

// ── 计时格式化 ────────────────────────────────────────

/**
 * 把起始时间戳换算为两位小数的秒数字符串（用于 X-Elapsed-Seconds 头与完成日志）。
 * @param {number} startTime - 由 Date.now() 取得的起始时间戳
 * @param {number} [now] - 结束时间戳，默认当前时间（便于测试注入）
 * @returns {string} 秒数，如 "5.50"
 */
export function elapsedSeconds(startTime, now = Date.now()) {
  return ((now - startTime) / 1000).toFixed(2);
}

// ── VLM 图片转3D 临时文件路径 ────────────────────────

/**
 * 为一次 VLM 图片转3D 生成一组互不冲突的临时文件路径。
 *
 * 固定文件名（vlm_in.png / vlm_img_to_3d.glb / _vlm_generated_blender.py）在并发
 * 请求下会互相覆盖：后到的请求会读到前一个请求写入的图片，或者读到对方的产物 GLB。
 * 随机后缀让同一时刻并发的多个请求各自独立。
 *
 * @param {string} tmpDir - 临时目录，通常传 os.tmpdir()
 * @param {object} path - path 模块（注入以便测试）
 * @param {string} [jobId] - 唯一标识，默认取 pid + 时间戳 + 随机串
 * @returns {{jobId: string, image: string, glb: string, code: string}}
 */
export function createVlmJobPaths(tmpDir, path, jobId = defaultVlmJobId()) {
  return {
    jobId,
    image: path.join(tmpDir, `vlm-in-${jobId}.png`),
    glb: path.join(tmpDir, `vlm-img3d-${jobId}.glb`),
    code: path.join(tmpDir, `vlm-code-${jobId}.py`),
  };
}

function defaultVlmJobId() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
