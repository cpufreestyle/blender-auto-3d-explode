#!/usr/bin/env node
/**
 * 单元测试 — 静态文件服务（src/static-server.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - MIME_TYPES：文本类带 charset，二进制/模型/字体/wasm 各就各位，键统一带点；
 *   - staticCacheControl 三段式：/ 与 /index.html → no-cache；带 ?v= → 1 年
 *     immutable；其余 → 1 小时 must-revalidate（no-cache 优先级最高）；
 *   - serveStatic：默认 / → index.html；".." 与 join 后前缀不符 → 403；缺失或
 *     非普通文件 → 404 JSON 信封；Content-Type 未登记扩展回落 octet-stream；
 *   - ETag 形如 W/"<size-hex>-<mtime-hex>"（与 stat 现场计算一致），命中
 *     If-None-Match（含 "*"）或 If-Modified-Since → 304 且不回 body；
 *   - gzip 仅在三条件同时成立时开：可压缩类型 + 客户端 accept-encoding 带
 *     gzip + size > 1024；否则走 Content-Length 直出；
 *   - sendJSON 经工厂注入，403/404 两条早退分支确实调它。
 *
 * 说明：生产链路里 server.js 用 new URL(req.url, base) 解析，WHATWG URL 会把
 * %2e%2e 归一化成 ".." 再折叠掉，穿越在解析器层面就被消化掉了（副作用是
 * /%2e%2e/x 会收敛成 /x，故 ROOT 下任意文件都能被 GET，含 server.js /
 * package.json——这是既有行为，本次只做等价搬迁，不动它）；但 "..%2f" 不在
 * 折叠范围内，pathname 原样透出，由 decodeURIComponent 还原成 ".." 后交给
 * 本模块拦——这条才是真实可达的 403，连同「裸 url 对象含 ..」一并测。
 *
 * 用法：node tests/static-server-test.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  createStaticServer,
  MIME_TYPES,
  staticCacheControl,
} from "../src/static-server.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}`);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
function it(_name, fn) {
  return fn();
}

// ===== 夹具：仓库根下的临时资源目录 + 临时 HTTP 服务 =====
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, ".static-fixtures.tmp");

const BIG = "x".repeat(4096); // > 1024 → 可触发 gzip
const SMALL = "hello world"; // <= 1024 → 不触发 gzip
const PNG = Buffer.alloc(3200, 0x50); // 不可压缩类型，且 > 1024

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const serveStatic = createStaticServer({ sendJSON });

function setupFixtures() {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, "big.txt"), BIG);
  fs.writeFileSync(path.join(FIX, "small.txt"), SMALL);
  fs.writeFileSync(path.join(FIX, "img.png"), PNG);
  fs.writeFileSync(path.join(FIX, "weird.xyz"), "payload");
  fs.writeFileSync(path.join(FIX, "main.js"), "// js\n".repeat(300));
  fs.mkdirSync(path.join(FIX, "adir"), { recursive: true });
}

const server = http.createServer((req, res) => {
  serveStatic(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`));
});

function listen() {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function get(target, headers = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: target, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// 直接以「裸 url 对象」调用，绕过 new URL 的归一化，覆盖 serveStatic 自身契约。
// 仅用于 fs.stat 之前的同步早退分支（".." 拦截）；后续分支依赖回调，走真实 HTTP。
function getRaw(pathname, reqHeaders = {}, search = "") {
  const chunks = [];
  const rec = {
    statusCode: null,
    headers: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload) {
      if (payload !== undefined) chunks.push(Buffer.from(payload));
      this.ended = true;
    },
  };
  serveStatic({ headers: reqHeaders }, rec, { pathname, search });
  return { status: rec.statusCode, headers: rec.headers, body: Buffer.concat(chunks) };
}

// 与实现同式的 ETag，供协商缓存用例复用
function etagOf(filePath) {
  const s = fs.statSync(filePath);
  return `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
}

function olderThan(ms) {
  return new Date(ms - 2000).toUTCString();
}

describe("staticCacheControl 三段式缓存策略", async() => {
  await it("no-cache", () => {
    assert(staticCacheControl({ search: "" }, "/") === "no-cache", "\"/\" → no-cache");
    assert(
      staticCacheControl({ search: "" }, "/index.html") === "no-cache",
      "\"/index.html\" → no-cache",
    );
    assert(
      staticCacheControl(null, "/index.html") === "no-cache",
      "url 为 null 时入口文件仍 no-cache",
    );
    assert(
      staticCacheControl(null, "/dist/main.js") === "public, max-age=3600, must-revalidate",
      "url 为 null 时普通资源回落默认档（不抛错）",
    );
  });

  await it("immutable", () => {
    assert(
      staticCacheControl({ search: "?v=1" }, "/dist/main.js") === "public, max-age=31536000, immutable",
      "\"?v=1\" → 1 年 immutable",
    );
    assert(
      staticCacheControl({ search: "?a=1&v=2" }, "/dist/main.js") === "public, max-age=31536000, immutable",
      "\"&v=\" 也能命中 immutable",
    );
  });

  await it("must-revalidate", () => {
    assert(
      staticCacheControl({ search: "" }, "/dist/main.js") === "public, max-age=3600, must-revalidate",
      "普通资源 → 1 小时协商缓存",
    );
    assert(
      staticCacheControl({ search: "?a=1" }, "/dist/main.js") === "public, max-age=3600, must-revalidate",
      "带其它 query 但不带 v= → 仍 1 小时",
    );
  });

  await it("v= 前的分隔符必须是 ? 或 &", () => {
    // "?uv=2"（UV 通道查询串）里确实含 "v=" 子串，但前面跟的是 u，不是查询分隔符
    assert(
      staticCacheControl({ search: "?uv=2" }, "/dist/model.glb") === "public, max-age=3600, must-revalidate",
      "\"?uv=2\" 不算版本号，仍 1 小时",
    );
    assert(
      staticCacheControl({ search: "?a=1&uv=2" }, "/dist/model.glb") === "public, max-age=3600, must-revalidate",
      "\"&uv=2\" 同样不算",
    );
  });

  await it("优先级", () => {
    assert(
      staticCacheControl({ search: "?v=9" }, "/index.html") === "no-cache",
      "入口文件带版本号也优先 no-cache",
    );
  });
});

describe("MIME_TYPES 映射", async() => {
  await it("文本类带 charset", () => {
    assert(MIME_TYPES[".html"] === "text/html; charset=utf-8", ".html");
    assert(MIME_TYPES[".js"] === "text/javascript; charset=utf-8", ".js");
    assert(MIME_TYPES[".mjs"] === "text/javascript; charset=utf-8", ".mjs 与 .js 同类型");
    assert(MIME_TYPES[".css"] === "text/css; charset=utf-8", ".css");
    assert(MIME_TYPES[".json"] === "application/json; charset=utf-8", ".json");
    assert(MIME_TYPES[".txt"] === "text/plain; charset=utf-8", ".txt");
    assert(MIME_TYPES[".map"] === "application/json; charset=utf-8", ".map 视作 json");
    assert(MIME_TYPES[".webmanifest"] === "application/manifest+json", ".webmanifest");
  });

  await it("二进制/模型/字体", () => {
    assert(MIME_TYPES[".png"] === "image/png", ".png");
    assert(MIME_TYPES[".jpg"] === "image/jpeg", ".jpg 与 .jpeg 同值");
    assert(MIME_TYPES[".jpeg"] === "image/jpeg", ".jpeg");
    assert(MIME_TYPES[".gif"] === "image/gif", ".gif");
    assert(MIME_TYPES[".svg"] === "image/svg+xml", ".svg");
    assert(MIME_TYPES[".ico"] === "image/x-icon", ".ico");
    assert(MIME_TYPES[".glb"] === "model/gltf-binary", ".glb（拆解产物）");
    assert(MIME_TYPES[".gltf"] === "model/gltf+json", ".gltf");
    assert(MIME_TYPES[".woff"] === "font/woff", ".woff");
    assert(MIME_TYPES[".woff2"] === "font/woff2", ".woff2");
    assert(MIME_TYPES[".ttf"] === "font/ttf", ".ttf");
    assert(MIME_TYPES[".wasm"] === "application/wasm", ".wasm");
  });

  await it("键统一以点开头", () => {
    const bad = Object.keys(MIME_TYPES).filter((k) => !k.startsWith("."));
    assert(bad.length === 0, `无裸扩展名键（异常: ${bad.join(",")}）`);
  });
});

describe("serveStatic 基本响应", async() => {
  await it("GET / → index.html", async() => {
    const r = await get("/");
    assert(r.status === 200, "状态 200");
    assert(r.headers["content-type"] === "text/html; charset=utf-8", "Content-Type 为 html");
    assert(r.headers["cache-control"] === "no-cache", "入口 no-cache");
    const disk = fs.readFileSync(path.join(ROOT, "index.html"));
    assert(r.body.equals(disk), "返回内容 == 磁盘 index.html");
  });

  await it("小文本直出，不 gzip", async() => {
    const r = await get("/.static-fixtures.tmp/small.txt", { "accept-encoding": "gzip" });
    assert(r.status === 200, "状态 200");
    assert(r.body.toString() === SMALL, "body 原文");
    assert(r.headers["content-length"] === String(SMALL.length), "Content-Length == 文件大小");
    assert(r.headers["content-encoding"] === undefined, "小于 1KB 不启用 gzip");
    assert(r.headers["cache-control"] === "public, max-age=3600, must-revalidate", "默认 1 小时缓存");
  });

  await it("gzip 命中", async() => {
    const r = await get("/.static-fixtures.tmp/big.txt", { "accept-encoding": "gzip" });
    assert(r.status === 200, "状态 200");
    assert(r.headers["content-encoding"] === "gzip", "Content-Encoding: gzip");
    assert(r.headers["vary"] === "Accept-Encoding", "带 Vary: Accept-Encoding");
    assert(r.headers["content-length"] === undefined, "流式响应不伪造 Content-Length");
    assert(r.body.length < BIG.length, "压缩后确实变小");
    assert(zlib.gunzipSync(r.body).toString() === BIG, "解压回来与原文一致");
  });

  await it("客户端不接受 gzip 时直出", async() => {
    const r = await get("/.static-fixtures.tmp/big.txt", { "accept-encoding": "identity" });
    assert(r.status === 200, "状态 200");
    assert(r.headers["content-encoding"] === undefined, "不带 gzip 则不压缩");
    assert(r.body.toString() === BIG, "body 原文");
    assert(r.headers["content-length"] === String(BIG.length), "Content-Length == 文件大小");
  });

  await it("不可压缩类型即使接受 gzip 也直出", async() => {
    const r = await get("/.static-fixtures.tmp/img.png", { "accept-encoding": "gzip" });
    assert(r.status === 200, "状态 200");
    assert(r.headers["content-type"] === "image/png", "Content-Type: image/png");
    assert(r.headers["content-encoding"] === undefined, "image/png 不在可压缩白名单");
  });

  await it("未登记扩展回落 octet-stream", async() => {
    const r = await get("/.static-fixtures.tmp/weird.xyz");
    assert(r.status === 200, "状态 200");
    assert(r.headers["content-type"] === "application/octet-stream", "回落 application/octet-stream");
    assert(r.body.toString() === "payload", "body 原文");
  });

  await it("大小写无关的扩展名", async() => {
    fs.writeFileSync(path.join(FIX, "UP.TXT"), "upper");
    const r = await get("/.static-fixtures.tmp/UP.TXT");
    assert(r.status === 200, "状态 200");
    assert(r.headers["content-type"] === "text/plain; charset=utf-8", ".TXT 也能映射到 text/plain");
    fs.rmSync(path.join(FIX, "UP.TXT"));
  });
});

describe("serveStatic 安全与 404", async() => {
  await it("..%2f 编码的穿越被 decodeURIComponent 还原后拦下", async() => {
    // %2e%2e 会被 new URL 折叠，用 "..%2f" 才能原样到达 serveStatic
    const r = await get("/..%2fserver.js");
    assert(r.status === 403, "状态 403");
    assert(r.headers["content-type"].startsWith("application/json"), "经 sendJSON 回 JSON");
    assert(JSON.parse(r.body.toString()).error === "Forbidden", "error: Forbidden");
  });

  await it(".. 检查独立生效（不被前缀校验代劳）", async() => {
    // 解码后含 ".."，但 join 归一化后仍落在 ROOT 内：只有 ".." 检查本身能给出 403。
    // 少了这一条，".." 检查会被前缀校验掩盖成等价变异而存活。
    const r = getRaw("/a/../.static-fixtures.tmp/small.txt");
    assert(r.status === 403, "状态 403");
    assert(JSON.parse(r.body.toString()).error === "Forbidden", "error: Forbidden");
  });

  await it("百分号编码的点被 decodeURIComponent 还原后才拦下", async() => {
    // 经 new URL 的 %2e%2e 会被折叠，故用裸 url 对象喂原始 pathname：
    // 没有 decodeURIComponent，字面量里看不到 ".."，就会漏到 404 而不是 403
    const r = getRaw("/%2e%2e/server.js");
    assert(r.status === 403, "状态 403");
    assert(JSON.parse(r.body.toString()).error === "Forbidden", "error: Forbidden");
  });

  await it("裸 pathname 含 .. 同样 403（不信任调用方）", async() => {
    const r = getRaw("/../server.js");
    assert(r.status === 403, "状态 403");
    assert(JSON.parse(r.body.toString()).error === "Forbidden", "error: Forbidden");
  });

  await it("ROOT 之内正常放行（前缀校验不误伤）", async() => {
    const r = await get("/.static-fixtures.tmp/small.txt");
    assert(r.status === 200, "状态 200");
    assert(r.body.toString() === SMALL, "body 原文");
  });

  await it("%2e%2e 被 new URL 折叠，不产生 403（既有行为记录）", async() => {
    const r = await get("/%2e%2e/.static-fixtures.tmp/small.txt");
    assert(r.status === 200, "折叠后落到 /..=/.static-fixtures.tmp/small.txt → 200");
    assert(r.body.toString() === SMALL, "body 原文");
  });

  await it("文件缺失 → 404", async() => {
    const r = await get("/.static-fixtures.tmp/nope.txt");
    assert(r.status === 404, "状态 404");
    const j = JSON.parse(r.body.toString());
    assert(j.error === "Not Found", "error: Not Found");
    assert(j.path === "/.static-fixtures.tmp/nope.txt", "回显 pathname");
  });

  await it("目录 → 404（isFile() 为假）", async() => {
    const r = await get("/.static-fixtures.tmp/adir");
    assert(r.status === 404, "状态 404");
    assert(JSON.parse(r.body.toString()).error === "Not Found", "error: Not Found");
  });
});

describe("serveStatic 协商缓存", async() => {
  await it("ETag 形如 W/\"<size-hex>-<mtime-hex>\"", async() => {
    const r = await get("/.static-fixtures.tmp/small.txt");
    const s = fs.statSync(path.join(FIX, "small.txt"));
    const expected = `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
    assert(r.headers.etag === expected, `ETag == ${expected}`);
    assert(r.headers["last-modified"] === s.mtime.toUTCString(), "Last-Modified == mtime.toUTCString()");
  });

  await it("If-None-Match 精确命中 → 304 无 body", async() => {
    const etag = etagOf(path.join(FIX, "big.txt"));
    const r = await get("/.static-fixtures.tmp/big.txt", { "if-none-match": etag });
    assert(r.status === 304, "状态 304");
    assert(r.body.length === 0, "304 不回 body");
    assert(r.headers.etag === etag, "304 仍带 ETag");
    assert(r.headers["last-modified"] !== undefined, "304 仍带 Last-Modified");
    assert(r.headers["cache-control"] === "public, max-age=3600, must-revalidate", "304 仍带 Cache-Control");
  });

  await it("If-None-Match 通配 * → 304", async() => {
    const r = await get("/.static-fixtures.tmp/big.txt", { "if-none-match": "*" });
    assert(r.status === 304, "状态 304");
  });

  await it("If-None-Match 多值与陈旧值", async() => {
    const etag = etagOf(path.join(FIX, "big.txt"));
    const multi = await get("/.static-fixtures.tmp/big.txt", {
      "if-none-match": `"stale-a", ${etag}`,
    });
    assert(multi.status === 304, "逗号分隔多值中命中即 304");
    const stale = await get("/.static-fixtures.tmp/big.txt", { "if-none-match": "\"stale-a\", \"stale-b\"" });
    assert(stale.status === 200, "全不命中 → 200 全量");
    assert(stale.body.toString() === BIG, "200 时 body 完整");
  });

  await it("If-Modified-Since 命中 → 304", async() => {
    const s = fs.statSync(path.join(FIX, "big.txt"));
    const r = await get("/.static-fixtures.tmp/big.txt", { "if-modified-since": s.mtime.toUTCString() });
    assert(r.status === 304, "IMS == mtime（秒级相等）→ 304");
    assert(r.body.length === 0, "304 无 body");
  });

  await it("If-Modified-Since 过期 → 200", async() => {
    const s = fs.statSync(path.join(FIX, "big.txt"));
    const r = await get("/.static-fixtures.tmp/big.txt", {
      "if-modified-since": olderThan(s.mtimeMs),
    });
    assert(r.status === 200, "IMS 早于 mtime → 200");
    assert(r.body.toString() === BIG, "200 时 body 完整");
  });

  await it("有 If-None-Match 时忽略 If-Modified-Since 不匹配项", async() => {
    // imsHit 的前提是 !inm：INM 已存在但未命中时，不能用旧的 IMS 兜成 304
    const s = fs.statSync(path.join(FIX, "big.txt"));
    const r = await get("/.static-fixtures.tmp/big.txt", {
      "if-none-match": "\"nope\"",
      "if-modified-since": s.mtime.toUTCString(),
    });
    assert(r.status === 200, "INM 未命中 + IMS 命中 → 仍 200（不重复计分）");
    assert(r.body.toString() === BIG, "200 时 body 完整");
  });
});

describe("serveStatic 版本号查询串", async() => {
  await it("?v= 走 immutable", async() => {
    const r = await get("/.static-fixtures.tmp/main.js?v=29472473478e4dba1cee");
    assert(r.headers["cache-control"] === "public, max-age=31536000, immutable", "带版本号 → immutable");
  });

  await it("其它 query 仍 1 小时", async() => {
    const r = await get("/.static-fixtures.tmp/main.js?t=123");
    assert(r.headers["cache-control"] === "public, max-age=3600, must-revalidate", "非 v= 查询 → 1 小时");
  });
});

// ===== 运行 =====
(async() => {
  setupFixtures();
  await listen();
  try {
    for (const item of describeQueue) {
      console.log(`\n── ${item.name}`);
      await item.fn();
    }
  } finally {
    server.close();
    fs.rmSync(FIX, { recursive: true, force: true });
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
