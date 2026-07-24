// 统一请求体解析：按 Content-Type 分发
// - application/json → 解析为对象（受 maxSize 限制）
// - multipart/form-data → 复用 server-utils 的 parseMultipartBuffer 提取首个文件 part
// 替代原 server.js 中三套重复的 parseMultipart / readJSONBodyMax / readJSONBody。
import { parseMultipartBuffer, MAX_FILE_SIZE, MAX_BOUNDARY_LENGTH } from "./server-utils.js";

export async function readBody(req, { maxSize = MAX_FILE_SIZE } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxSize) {
      throw new Error("请求体太大");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  // 注意：仅对“是否为 multipart”做大小写不敏感判断；
  // multipart boundary 值按 RFC 2046 是大小写敏感的，绝不能随 header 一起 toLowerCase，
  // 否则含大写字母的 boundary（如浏览器/脚本生成的 ----xxxOBJxxx）会匹配失败导致提取不到文件。
  const rawCt = req.headers["content-type"] || "";
  const ct = rawCt.toLowerCase();

  if (ct.includes("multipart/form-data")) {
    const m = rawCt.match(/boundary=("?)([^";]+)\1?/);
    const boundary = m ? "--" + m[2] : null;
    if (!boundary) throw new Error("未找到 multipart boundary");
    if (boundary.length - 2 > MAX_BOUNDARY_LENGTH) throw new Error("boundary 过长");
    const result = parseMultipartBuffer(raw, boundary);
    if (!result) throw new Error("未能从请求中提取文件");
    return result;
  }

  // 默认按 JSON 解析
  return JSON.parse(raw.toString("utf-8"));
}
