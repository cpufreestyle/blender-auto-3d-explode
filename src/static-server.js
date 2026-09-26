// 静态文件服务（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的「静态文件服务」段：MIME_TYPES 映射、三段式缓存策略
// （staticCacheControl）+ serveStatic 主体（路径穿越防护、ETag/Last-Modified
// 协商缓存、文本类资源 gzip、其余流式直出）。
//
// 路径接缝（与原实现等价）：server.js 原以自身 __dirname 定位仓库根，本模块
// 位于 src/ 下，故 __dirname 上提一级得 ROOT；path.join(ROOT, pathname) 配
// filePath.startsWith(ROOT) 与原 __dirname 版本语义一致（join 得到的是绝对
// 路径，".." 已在前面被显式拒绝，漏网也只是前缀不匹配而落 403）。
//
// DI / 接缝：createStaticServer({ sendJSON }) 把 server.js 的同名响应工具注入
// 闭包（403 穿越 / 404 缺失两条早退分支要用），返回的 serveStatic 与原先签名
// (req, res, url) 一致，路由处调用方式不变。
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server.js 同级的仓库根：index.html、dist/、models/ 都在这里
const ROOT = path.join(__dirname, "..");

export const MIME_TYPES = {
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
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * 静态资源缓存策略：
 *   · index.html  → no-cache（每次协商，保证入口最新）
 *   · 带 ?v= 版本号 → 强缓存 1 年 + immutable（内容变了就换版本号）
 *   · 其它        → 1 小时缓存，过期后协商（ETag/Last-Modified 兜底）
 */
export function staticCacheControl(url, pathname) {
  if (pathname === "/index.html" || pathname === "/") return "no-cache";
  if (url && /[?&]v=/.test(url.search || "")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600, must-revalidate";
}

export function createStaticServer({ sendJSON }) {
  return function serveStatic(req, res, url) {
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

    const filePath = path.join(ROOT, pathname);

    // 确保文件在 __dirname 下
    if (!filePath.startsWith(ROOT)) {
      sendJSON(res, 403, { error: "Forbidden" });
      return;
    }

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        sendJSON(res, 404, { error: "Not Found", path: pathname });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      // 用 size+mtime 生成弱 ETag：内容一变 ETag 就变，可安全用于协商缓存
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const lastModified = stat.mtime.toUTCString();
      const cacheControl = staticCacheControl(url, pathname);

      // ── 协商缓存：命中则直接 304（省掉整个响应体）──
      const inm = req.headers["if-none-match"];
      const ims = req.headers["if-modified-since"];
      const etagHit =
        !!inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*");
      const imsHit =
        !inm && ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
      if (etagHit || imsHit) {
        res.writeHead(304, {
          ETag: etag,
          "Last-Modified": lastModified,
          "Cache-Control": cacheControl,
        });
        res.end();
        return;
      }

      const headers = {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": lastModified,
      };

      // ── 文本类资源 gzip（体积通常省 60~75%）──
      const isCompressible = /^(text\/|application\/(json|javascript|wasm)|image\/svg)/.test(
        contentType,
      );
      const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      if (isCompressible && acceptsGzip && stat.size > 1024) {
        headers["Content-Encoding"] = "gzip";
        headers["Vary"] = "Accept-Encoding";
        res.writeHead(200, headers);
        const src = fs.createReadStream(filePath);
        const gz = zlib.createGzip();
        src.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
        gz.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
        src.pipe(gz).pipe(res);
        return;
      }

      // ── 直出：流式读取，避免整文件读入内存（大 GLB 也适用）──
      headers["Content-Length"] = stat.size;
      res.writeHead(200, headers);
      const stream = fs.createReadStream(filePath);
      stream.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
      stream.pipe(res);
    });
}
}
