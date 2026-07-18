#!/usr/bin/env node
/**
 * 对磁盘上已有的 GLB 调用 /api/split 进行拆解。
 * 服务端拆完后会将结果存盘到 models/generated/，并按配置在 Blender 中打开。
 * 用法：node tests/split-local.mjs [模型路径]   （默认 models/red_car.glb）
 */
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(".");
const SERVER = process.env.SERVER || "http://localhost:3001";
const modelPath = process.argv[2] || path.join(ROOT, "models", "red_car.glb");

if (!fs.existsSync(modelPath)) {
  console.error("模型不存在:", modelPath);
  process.exit(2);
}

const data = fs.readFileSync(modelPath);
const boundary = "----quest3split" + Date.now();
const head =
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="file"; filename="${path.basename(modelPath)}"\r\n` +
  `Content-Type: model/gltf-binary\r\n\r\n`;
const tail = `\r\n--${boundary}--\r\n`;
const body = Buffer.concat([Buffer.from(head, "utf-8"), data, Buffer.from(tail, "utf-8")]);

const u = new URL("/api/split", SERVER);
const req = http.request(
  {
    hostname: u.hostname,
    port: u.port,
    path: u.pathname,
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
      "Connection": "close",
    },
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      if (res.statusCode !== 200) {
        console.error("拆分失败:", res.statusCode, Buffer.concat(chunks).slice(0, 500).toString());
        process.exit(1);
      }
      const manifestB64 = res.headers["x-manifest"];
      let m = null;
      if (manifestB64) {
        try {
          m = JSON.parse(Buffer.from(manifestB64, "base64").toString("utf-8"));
        } catch {}
      }
      console.log(`✅ 拆分成功: ${(Buffer.concat(chunks).length / 1024).toFixed(0)} KB, 部件数=${m ? m.total_parts : "?"}`);
      console.log("→ 服务端已把结果存盘到 models/generated/，并尝试在 Blender 中打开");
      res.destroy();
      process.exit(0);
    });
  }
);
req.on("error", (e) => {
  console.error("请求错误:", e.message);
  process.exit(1);
});
req.write(body);
req.end();
