#!/usr/bin/env node
/**
 * 一次性端到端验证：本地 TripoSR 真重建图片转 3D
 * 自启 server.js（独立测试端口），POST 一张测试 PNG 到 /api/image-to-3d，
 * 校验返回的是合法 GLB（magic = 'glTF'），随后自动关停服务器。
 * 前提：已运行 `bash scripts/setup_triposr.sh` 准备本地真重建环境（否则测试会优雅跳过）。
 */
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const PORT = 3099;
const TEST_IMG = path.join(ROOT, "meta-quest-3", "textures", "Image_1_1@channels=B.png");

function log(...a) { console.log("[test]", ...a); }

function waitHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: "localhost", port: PORT, path: "/api/health", timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error("server health timeout"));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function postImageTo3D(dataUrl) {
  const body = JSON.stringify({ deploy: "local", mcResolution: 256, image: dataUrl });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: PORT, path: "/api/image-to-3d", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 900000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buf });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("POST timeout")); });
    req.write(body);
    req.end();
  });
}

function isGLB(buf) {
  return buf.length >= 4 && buf.toString("ascii", 0, 4) === "glTF";
}

const GENERATED_DIR = path.join(ROOT, "models", "generated");
function countGeneratedGlbs() {
  try {
    return fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith(".glb")).length;
  } catch {
    return 0;
  }
}

async function main() {
  // 本地真重建需要 TripoSR 环境；未准备则优雅跳过（不算失败）
  const venvPython = path.join(ROOT, "external", "TripoSR", ".venv", "bin", "python3");
  if (!fs.existsSync(venvPython)) {
    log("⚠️ 跳过：本地真重建环境未就绪（缺 " + venvPython + "）");
    log("   请先运行：bash scripts/setup_triposr.sh");
    process.exit(0);
  }
  if (!fs.existsSync(TEST_IMG)) throw new Error("测试图不存在: " + TEST_IMG);

  log("启动 server.js (PORT=" + PORT + ") ...");
  const srv = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), OPEN_IN_BLENDER: "0" },
  });
  srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  srv.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

  let exitCode = 1;
  try {
    await waitHealth();
    log("服务器已就绪");

    const b64 = fs.readFileSync(TEST_IMG).toString("base64");
    const dataUrl = "data:image/png;base64," + b64;
    log(`POST /api/image-to-3d (图 ${(b64.length / 1024 / 4 * 3).toFixed(0)} KB, mode=relief)`);

    const before = countGeneratedGlbs();
    const t0 = Date.now();
    const { status, headers, buf } = await postImageTo3D(dataUrl);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (status !== 200) {
      log("❌ 非 200 响应:", status);
      log("body:", buf.slice(0, 2000).toString("utf-8"));
      throw new Error("HTTP " + status);
    }

    const ok = isGLB(buf);
    const manifestB64 = headers["x-manifest"];
    let manifest = null;
    if (manifestB64) {
      try { manifest = JSON.parse(Buffer.from(manifestB64, "base64").toString("utf-8")); } catch {}
    }
    log(`响应: ${buf.length} bytes, elapsed=${headers["x-elapsed-seconds"]}s, 校验耗时=${secs}s`);
    log("manifest:", JSON.stringify(manifest));

    if (!ok) {
      log("❌ 返回内容不是合法 GLB（magic 应为 glTF）");
      log("前 64 字节:", buf.slice(0, 64).toString("hex"));
      throw new Error("invalid GLB");
    }
    log("✅ 端到端验证通过：本地 Blender 脚本成功生成合法 GLB");
    const after = countGeneratedGlbs();
    if (after > before) log(`✅ 模型已存盘 models/generated（新增 ${after - before} 个，共 ${after}）`);
    else log("⚠️ 模型未存盘到 models/generated");
    exitCode = 0;
  } catch (e) {
    log("❌ 验证失败:", e.message);
  } finally {
    srv.kill("SIGTERM");
    setTimeout(() => { try { srv.kill("SIGKILL"); } catch {} process.exit(exitCode); }, 500);
  }
}

main();
