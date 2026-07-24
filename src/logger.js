// 结构化日志器 — 统一 server.js 中的 console.* 输出。
//
// 设计：
//   - 输出格式：`ISO时间戳 LEVEL  message`（LEVEL 固定 5 位宽度便于对齐）。
//   - 级别由环境变量 LOG_LEVEL 控制（debug < info < warn < error），默认 info。
//   - 统一写入 stderr，避免与 stdout 的业务数据（如静态文件/二进制流）混流。
//   - 不依赖 console，直接写流，避免重定向后产生递归。
//
// 集成方式：在 server.js 顶部 import 后，将 console.log/info/warn/error/debug
// 重定向到本 logger，即可让全部既有 console.* 调用获得结构化输出，无需逐处改写。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const THRESHOLD = LEVELS[LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function formatArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (a === undefined) return "undefined";
  if (a === null) return "null";
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function emit(level, args) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < THRESHOLD) return;
  const message = Array.prototype.map.call(args, formatArg).join(" ");
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
  process.stderr.write(line);
}

export const log = {
  debug: (...args) => emit("debug", args),
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args),
};

export default log;
