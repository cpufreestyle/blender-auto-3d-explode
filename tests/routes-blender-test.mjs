#!/usr/bin/env node
/**
 * 单元测试 — Blender 类路由（src/routes-blender.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - handleAIPaint：prompt 缺省 "球体"；非字符串或超 500 字 → 400；请求体
 *     上限 10KB；给了 imageFeatures 就写一份临时 JSON 并把路径作为第四个参数
 *     传给 runBlenderAIPaint，没给则传 null；Blender 抛错时 stdout/stderr 分别取
 *     berr.stdout 与 (berr.stderr || berr.message)；GLB 缺失与 manifest 缺失各有
 *     报错文案；Blender 崩掉且没给 stderr 时 blenderStderr 回落到 berr.message，
 *     blender_output 优先取 stdout；成功后以 baseName "ai-paint" 回二进制；
 *     finally 只删 output 与
 *     manifest 两个临时文件，imageFeatures 那份不删（钉住这个不对称）；
 *     失败时 500 信封带 blender_output；
 *   - handleHealth：200 + 版本号解析（正则失配回落 "unknown"）；execFile 抛错
 *     走 503；超时 10s；
 *   - handleGeneratedList：只收 .glb/.gltf/.stl（大小写不敏感）且只收文件，
 *     按 mtime 倒序，url 做 encodeURIComponent；readdir 抛错 → 500；
 *   - launchBlenderApp：darwin 走 open -a Blender；win32 优先用 BLENDER_PATH
 *     （值为 "blender" 时回退 PATH）；其它平台直接 blender 无参数；spawn 带
 *     detached + stdio ignore 并 unref，返回 true；
 *   - handleLaunchBlender：先启动再探活，200 带 { launched, health }；与
 *     handleHealth 共用同一套版本解析，失配同样回落 "unknown"；探活失败时
 *     health 只留 status:error；启动本身抛错 → 500 launched:false；
 *   - handleSplit：没收到文件 → 400；扩展名不在白名单 → 400 且文案列出全部
 *     允许格式；maxSize 取 MAX_FILE_SIZE；VLM 标注三级门槛（semanticLabel +
 *     vlm.provider + 对应 provider 的 key 都在才启用，缺 key 只 warn 不启用）；
 *     GLB/manifest 缺失各有报错；成功后 baseName "split"，input/output/manifest
 *     三个临时文件全删；失败 500 带 blender_output。
 *
 * 接缝：createBlenderRoutes 带名注入 sendJSON / sendBinaryResult /
 *   runBlenderAIPaint / runBlenderSplit / UPLOAD_DIR / GENERATED_DIR /
 *   BLENDER_PATH / execFile / spawn / platform，测试用全套假实现驱动六个路由。
 *
 * 用法：node tests/routes-blender-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createBlenderRoutes } from "../src/routes-blender.js";
import { AI_CONFIG, loadAIConfig, setConfigFilePath } from "../src/ai-config.js";
import { ALLOWED_EXTENSIONS } from "../src/server-utils.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
let passed = 0;
let failed = 0;
const failures = [];

// 断言走原始 console：本文件会把被测模块的 console.* 静音，
// 若断言也用 console.log，失败信息会一起消失。
const realLog = console.log;
const realErr = console.error;

function assert(condition, message) {
  if (condition) {
    realLog(`  OK ${message}`);
    passed++;
  } else {
    realErr(`  FAIL ${message}`);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
async function it(_name, fn) {
  await fn();
}

// ===== 夹具 =====
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_CONFIG = path.join(ROOT, "ai-config.json");
const BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/blender";
const madeDirs = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(d);
  return d;
}
function resetConfig(state = {}) {
  const d = tmp("blenroutes-cfg-");
  const p = path.join(d, "ai-config.json");
  fs.writeFileSync(p, JSON.stringify({ provider: "openai", ...state }));
  setConfigFilePath(p);
  loadAIConfig();
}

function fakeReq(bodyObj) {
  const req = Readable.from([Buffer.from(JSON.stringify(bodyObj), "utf-8")]);
  req.headers = { "content-type": "application/json" };
  return req;
}
// multipart 上传：parseMultipartBuffer 只认 Content-Disposition 带 filename 的 part
function multipartReq(filename, data) {
  const boundary = "----blenroutes" + Math.random().toString(36).slice(2);
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n";
  const body = Buffer.concat([Buffer.from(head, "utf-8"), data, Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8")]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  return req;
}
function fakeRes() {
  const rec = { statusCode: null, body: null, headersSent: false };
  return {
    rec,
    headersSent: false,
    writeHead(statusCode, headers) {
      rec.statusCode = statusCode;
      rec.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      rec.body = body === undefined ? null : body;
    },
  };
}

const jsonCalls = [];
const sendJSON = (res, statusCode, data) => {
  jsonCalls.push({ statusCode, data });
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const lastJSON = () => jsonCalls[jsonCalls.length - 1];

const binaryCalls = [];
const sendBinaryResult = (res, glbBuffer, manifest, elapsed, baseName) => {
  binaryCalls.push({ glbBuffer, manifest, elapsed, baseName });
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  res.end(glbBuffer);
};

// ---- Blender runner 假实现 ----
const paintCalls = [];
let paintImpl = async() => ({ stdout: "P", stderr: "" });
const runBlenderAIPaint = async(...args) => {
  paintCalls.push(args);
  return paintImpl(...args);
};
const splitCalls = [];
let splitImpl = async() => ({ stdout: "S", stderr: "" });
const runBlenderSplit = async(...args) => {
  splitCalls.push(args);
  return splitImpl(...args);
};

// ---- execFile / spawn 假实现 ----
const execCalls = [];
let execImpl = async() => ({ stdout: "Blender 5.1.2", stderr: "" });
const execFile = async(bin, args, opts) => {
  execCalls.push({ bin, args: args.slice(), opts });
  return execImpl(bin, args, opts);
};

const spawnCalls = [];
let spawnImpl = () => ({ unref() {} });
const spawn = (cmd, args, opts) => {
  spawnCalls.push({ cmd, args: (args || []).slice(), opts });
  return spawnImpl(cmd, args, opts);
};

let uploadDir = tmp("blenroutes-upload-");
let generatedDir = tmp("blenroutes-generated-");
let platform = "linux";

function build() {
  return createBlenderRoutes({
    sendJSON,
    sendBinaryResult,
    runBlenderAIPaint,
    runBlenderSplit,
    UPLOAD_DIR: uploadDir,
    GENERATED_DIR: generatedDir,
    BLENDER_PATH,
    execFile,
    spawn,
    platform,
  });
}
let routes = build();

function clearState() {
  jsonCalls.length = 0;
  binaryCalls.length = 0;
  paintCalls.length = 0;
  splitCalls.length = 0;
  execCalls.length = 0;
  spawnCalls.length = 0;
  paintImpl = async() => ({ stdout: "P", stderr: "" });
  splitImpl = async() => ({ stdout: "S", stderr: "" });
  execImpl = async() => ({ stdout: "Blender 5.1.2", stderr: "" });
  spawnImpl = () => ({ unref() {} });
}

// 造一个「Blender 真的产出了文件」的环境：runBlenderAIPaint 落盘 GLB + manifest
function plantAiOutput() {
  paintImpl = async(prompt, outputPath, manifestPath) => {
    fs.writeFileSync(outputPath, "AI-GLB");
    fs.writeFileSync(manifestPath, JSON.stringify({ total_parts: 3 }));
    return { stdout: "painted", stderr: "" };
  };
}
function plantSplitOutput() {
  splitImpl = async(inputPath, outputPath, manifestPath) => {
    fs.writeFileSync(outputPath, "SPLIT-GLB");
    fs.writeFileSync(manifestPath, JSON.stringify({ total_parts: 7 }));
    return { stdout: "split ok", stderr: "" };
  };
}

// ── handleAIPaint ──────────────────────────────────────
describe("handleAIPaint", async() => {
  await it("prompt 缺省为「球体」", async() => {
    clearState();
    plantAiOutput();
    await routes.handleAIPaint(fakeReq({}), fakeRes());
    assert(paintCalls.length === 1, "调了一次 Blender");
    assert(paintCalls[0][0] === "球体", "没给 prompt 时用默认值");
    assert(paintCalls[0][3] === null, "没给图片特征时第四参为 null");
    assert(binaryCalls.length === 1 && binaryCalls[0].baseName === "ai-paint", "以 ai-paint 回二进制");
    assert(binaryCalls[0].manifest.total_parts === 3, "manifest 透传");
    assert(binaryCalls[0].glbBuffer.toString() === "AI-GLB", "GLB 来自落盘文件");
    assert(/^\d+\.\d{2}$/.test(binaryCalls[0].elapsed), `elapsed 两位小数（${binaryCalls[0].elapsed}）`);
    assert(Number(binaryCalls[0].elapsed) >= 0 && Number(binaryCalls[0].elapsed) < 30,
      `elapsed 不是 epoch 起点（${binaryCalls[0].elapsed}s）`);
  });

  await it("prompt 非字符串或超 500 字 → 400", async() => {
    for (const p of [123, { a: 1 }, "x".repeat(501)]) {
      clearState();
      await routes.handleAIPaint(fakeReq({ prompt: p }), fakeRes());
      assert(lastJSON().statusCode === 400, `${JSON.stringify(p).slice(0, 20)} → 400`);
      assert(lastJSON().data.error === "提示词无效或过长（最多500字符）", "文案");
      assert(paintCalls.length === 0, "没有起 Blender");
    }
    clearState();
    plantAiOutput();
    await routes.handleAIPaint(fakeReq({ prompt: "x".repeat(500) }), fakeRes());
    assert(binaryCalls.length === 1, "恰好 500 字放行");
  });

  await it("给了 imageFeatures → 写临时 JSON 并作为第四参传入", async() => {
    clearState();
    plantAiOutput();
    const feats = { mood: "warm", dominantColors: ["#f00", "#0f0"] };
    await routes.handleAIPaint(fakeReq({ prompt: "p", imageFeatures: feats }), fakeRes());
    assert(paintCalls[0][0] === "p", "prompt 透传");
    const featPath = paintCalls[0][3];
    assert(typeof featPath === "string" && path.basename(featPath).startsWith("ai-imgfeat-"), "第四参是临时 JSON 路径");
    assert(JSON.parse(fs.readFileSync(featPath, "utf-8")).mood === "warm", "内容为图片特征");
    assert(fs.existsSync(featPath), "该临时文件用完不删（随段既有行为）");
  });

  await it("Blender 抛错：stdout 与 stderr 分别取自 berr.stdout / berr.stderr", async() => {
    clearState();
    const berr = Object.assign(new Error("崩了"), { stdout: "OUT1", stderr: "ERR1" });
    paintImpl = async() => { throw berr; };
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.blender_output === "OUT1", "blender_output 优先取 stdout");

    clearState();
    paintImpl = async() => { throw Object.assign(new Error("崩了"), { stdout: "OUT2" }); };
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    assert(lastJSON().data.blender_output === "OUT2", "没有 stdout 时才回落 stderr");
  });

  await it("Blender 崩掉且没给 stderr 时回落 berr.message", async() => {
    clearState();
    paintImpl = async() => { throw new Error("进程被 SIGKILL"); };
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.blender_output === "进程被 SIGKILL", "blenderStderr 回落到 message");
    assert(lastJSON().data.error.endsWith("进程被 SIGKILL"), "报错文案也带上它");
  });

  await it("GLB 缺失 / manifest 缺失各有报错文案", async() => {
    clearState();
    paintImpl = async() => ({ stdout: "o", stderr: "e-detail" }); // 什么都不落盘
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.error.startsWith("Blender 未生成 GLB 文件。日志:"), "GLB 文案");
    assert(lastJSON().data.error.endsWith("e-detail"), "带 stderr 前 3000 字");

    clearState();
    paintImpl = async(prompt, outputPath) => {
      fs.writeFileSync(outputPath, "G");
      return { stdout: "", stderr: "no-manifest" };
    };
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    assert(lastJSON().data.error.startsWith("Blender 未生成 manifest。日志:"), "manifest 文案");
  });

  await it("elapsed 由真实 startTime 算出", async() => {
    clearState();
    paintImpl = async(prompt, outputPath, manifestPath) => {
      await new Promise(r => setTimeout(r, 320));
      fs.writeFileSync(outputPath, "G");
      fs.writeFileSync(manifestPath, "{}");
      return { stdout: "", stderr: "" };
    };
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    const el = binaryCalls[0].elapsed;
    assert(Number(el) >= 0.3, `elapsed 反映真实耗时（${el}s）`);
    assert(Number(el) < 30, `elapsed 不是 epoch 起点（${el}s）`);
  });

  await it("成功后 output / manifest 临时文件被删", async() => {
    clearState();
    plantAiOutput();
    let out = "", man = "";
    paintImpl = async(prompt, outputPath, manifestPath) => {
      out = outputPath; man = manifestPath;
      fs.writeFileSync(outputPath, "G");
      fs.writeFileSync(manifestPath, "{}");
      return { stdout: "", stderr: "" };
    };
    await routes.handleAIPaint(fakeReq({ prompt: "p" }), fakeRes());
    assert(!fs.existsSync(out), "GLB 已删");
    assert(!fs.existsSync(man), "manifest 已删");
  });

  await it("请求体上限 10KB", async() => {
    clearState();
    const big = Buffer.from(JSON.stringify({ prompt: "x".repeat(20 * 1024) }), "utf-8");
    const req = Readable.from([big]);
    req.headers = { "content-type": "application/json" };
    await routes.handleAIPaint(req, fakeRes());
    assert(lastJSON().statusCode === 500, "超限走 500");
    assert(lastJSON().data.error === "请求体太大", "文案");
    assert(paintCalls.length === 0, "没有起 Blender");
  });
});

// ── handleHealth ──────────────────────────────────────
describe("handleHealth", async() => {
  await it("200 + 版本号解析", async() => {
    clearState();
    execImpl = async() => ({ stdout: "Blender 5.1.2 (sub 0)\nBuild: x", stderr: "" });
    await routes.handleHealth(fakeReq({}), fakeRes());
    const d = lastJSON().data;
    assert(lastJSON().statusCode === 200, "200");
    assert(d.status === "ok" && d.version === "5.1.2", "版本取自 stdout 正则");
    assert(d.blender === BLENDER_PATH, "回传 BLENDER_PATH");
    assert(d.message === "Blender 5.1.2 可用", "message 文案");
    assert(execCalls[0].bin === BLENDER_PATH, "探测 BLENDER_PATH");
    assert(execCalls[0].args[0] === "--version", "--version");
    assert(execCalls[0].opts.timeout === 10_000, "超时 10s");
  });

  await it("版本号正则失配 → unknown", async() => {
    clearState();
    execImpl = async() => ({ stdout: "no version here", stderr: "" });
    await routes.handleHealth(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 200, "仍是 200");
    assert(lastJSON().data.version === "unknown", "回落 unknown");
    assert(lastJSON().data.message === "Blender unknown 可用", "message 跟着回落");
  });

  await it("execFile 抛错 → 503", async() => {
    clearState();
    execImpl = async() => { throw new Error("spawn ENOENT"); };
    await routes.handleHealth(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 503, "503");
    assert(lastJSON().data.status === "error", "status error");
    assert(lastJSON().data.message === "Blender 不可用: spawn ENOENT", "message 含错误原因");
    assert(lastJSON().data.blender === BLENDER_PATH, "仍回传路径");
  });
});

// ── handleGeneratedList ─────────────────────────────────
describe("handleGeneratedList", async() => {
  await it("过滤扩展名与目录项、按 mtime 倒序、url 编码", async() => {
    clearState();
    generatedDir = tmp("blenroutes-gen-");
    routes = build();
    fs.writeFileSync(path.join(generatedDir, "old.glb"), "a");
    fs.writeFileSync(path.join(generatedDir, "new.GLTF"), "bb");
    fs.writeFileSync(path.join(generatedDir, "mid.stl"), "ccc");
    fs.writeFileSync(path.join(generatedDir, "note.txt"), "x");
    fs.mkdirSync(path.join(generatedDir, "sub.glb")); // 目录：同扩展名也要被滤掉
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(generatedDir, "old.glb"), now - 300, now - 300);
    fs.utimesSync(path.join(generatedDir, "new.GLTF"), now - 10, now - 10);
    fs.utimesSync(path.join(generatedDir, "mid.stl"), now - 100, now - 100);

    await routes.handleGeneratedList(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 200, "200");
    const files = lastJSON().data.files;
    assert(lastJSON().data.success === true, "success:true");
    assert(files.map(f => f.name).join(",") === "new.GLTF,mid.stl,old.glb", "按 mtime 倒序");
    assert(files.every(f => ALLOWED_EXTENSIONS.includes(path.extname(f.name).toLowerCase())), "只收白名单扩展名");
    assert(files[0].size === 2 && files[2].size === 1, "size 来自 stat");
    assert(files[0].url === "/models/generated/new.GLTF", "url 中文名不编码");

    // 文件名带空格与中文时 encodeURIComponent 生效
    clearState();
    const spaced = path.join(generatedDir, "my model v1.glb");
    fs.writeFileSync(spaced, "z");
    await routes.handleGeneratedList(fakeReq({}), fakeRes());
    const hit = lastJSON().data.files.find(f => f.name === "my model v1.glb");
    assert(hit.url === "/models/generated/my%20model%20v1.glb", "空格被编码");
  });

  await it("readdir 抛错 → 500", async() => {
    clearState();
    const d = tmp("blenroutes-missing-");
    generatedDir = path.join(d, "nope");
    routes = build();
    await routes.handleGeneratedList(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.success === false, "success:false");
    assert(typeof lastJSON().data.error === "string" && lastJSON().data.error.length > 0, "带错误文案");
  });
});

// ── launchBlenderApp / handleLaunchBlender ──────────────
describe("launchBlenderApp 与一键启动", async() => {
  await it("darwin：open -a Blender", async() => {
    clearState();
    platform = "darwin";
    routes = build();
    assert(routes.launchBlenderApp() === true, "返回 true");
    assert(spawnCalls[0].cmd === "open", "cmd = open");
    assert(spawnCalls[0].args.join(" ") === "-a Blender", "args = -a Blender");
    assert(spawnCalls[0].opts.detached === true && spawnCalls[0].opts.stdio === "ignore", "detached + stdio ignore");
  });

  await it("win32：优先 BLENDER_PATH，值为 blender 时回退 PATH", async() => {
    clearState();
    platform = "win32";
    routes = build();
    routes.launchBlenderApp();
    assert(spawnCalls[0].cmd === "cmd", "cmd = cmd");
    assert(spawnCalls[0].args[3] === BLENDER_PATH, "用探测到的绝对路径");
    assert(spawnCalls[0].args[0] === "/c" && spawnCalls[0].args[1] === "start", "/c start");
    assert(spawnCalls[0].args[2] === "", "第三个参数是空标题");

    clearState();
    const bare = createBlenderRoutes({
      sendJSON, sendBinaryResult, runBlenderAIPaint, runBlenderSplit,
      UPLOAD_DIR: uploadDir, GENERATED_DIR: generatedDir,
      BLENDER_PATH: "blender", execFile, spawn, platform: "win32",
    });
    bare.launchBlenderApp();
    assert(spawnCalls[0].args[3] === "blender", "BLENDER_PATH 为 blender 时回退 PATH");
  });

  await it("其它平台：直接 blender，无参数", async() => {
    clearState();
    platform = "linux";
    routes = build();
    routes.launchBlenderApp();
    assert(spawnCalls[0].cmd === "blender", "cmd = blender");
    assert(spawnCalls[0].args.length === 0, "无参数");
  });

  await it("spawn 出的子进程被 unref", async() => {
    clearState();
    let unrefd = false;
    spawnImpl = () => ({ unref() { unrefd = true; } });
    platform = "darwin";
    routes = build();
    routes.launchBlenderApp();
    assert(unrefd, "调了 unref");
  });

  await it("handleLaunchBlender：先启动再探活，200 带 health", async() => {
    clearState();
    platform = "darwin";
    execImpl = async() => ({ stdout: "Blender 5.1.2", stderr: "" });
    routes = build();
    await routes.handleLaunchBlender(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 200, "200");
    assert(lastJSON().data.launched === true, "launched:true");
    assert(lastJSON().data.health.status === "ok" && lastJSON().data.health.version === "5.1.2", "health ok");
    assert(lastJSON().data.health.blender === BLENDER_PATH, "health 带路径");
    assert(spawnCalls.length === 1, "真的启动了应用");
  });

  await it("版本号正则失配时 health.version 回落 unknown", async() => {
    clearState();
    platform = "darwin";
    execImpl = async() => ({ stdout: "no version here", stderr: "" });
    routes = build();
    await routes.handleLaunchBlender(fakeReq({}), fakeRes());
    assert(lastJSON().data.launched === true, "启动仍算成功");
    assert(lastJSON().data.health.status === "ok", "探活仍算成功");
    assert(lastJSON().data.health.version === "unknown", "版本回落 unknown");
  });

  await it("探活失败时 health 只留 status:error", async() => {
    clearState();
    platform = "darwin";
    execImpl = async() => { throw new Error("nope"); };
    routes = build();
    await routes.handleLaunchBlender(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 200, "仍是 200");
    assert(lastJSON().data.launched === true, "launched 仍为 true");
    assert(lastJSON().data.health.status === "error", "health status error");
    assert(lastJSON().data.health.blender === BLENDER_PATH, "health 仍带路径");
    assert(lastJSON().data.health.version === undefined, "不带 version");
  });

  await it("启动本身抛错 → 500 launched:false", async() => {
    clearState();
    platform = "darwin";
    spawnImpl = () => { throw new Error("open 失败"); };
    routes = build();
    await routes.handleLaunchBlender(fakeReq({}), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.launched === false, "launched:false");
    assert(lastJSON().data.error === "open 失败", "带错误文案");
  });
});

// ── handleSplit ──────────────────────────────────────
describe("handleSplit", async() => {
  await it("readBody 解析出空结果 → 400 未收到文件", async() => {
    clearState();
    // multipart 里没有带 filename 的 part 时 readBody 会直接抛（见下一个用例），
    // 能走到 handleSplit 的 !file 分支的是 readBody 返回假值的场景：
    await routes.handleSplit(fakeReq(null), fakeRes());
    assert(lastJSON().statusCode === 400, "400");
    assert(lastJSON().data.error === "未收到文件", "文案");
    assert(splitCalls.length === 0, "没有起 Blender");
  });

  await it("multipart 里没有文件 part → 500 提取失败", async() => {
    clearState();
    const b = "----blenroutes-nofile";
    const raw =
      `--${b}\r\nContent-Disposition: form-data; name="file"\r\n\r\n` +
      `nodata\r\n--${b}--\r\n`;
    const req = Readable.from([Buffer.from(raw, "utf-8")]);
    req.headers = { "content-type": `multipart/form-data; boundary=${b}` };
    await routes.handleSplit(req, fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.error === "未能从请求中提取文件", "文案来自 readBody");
    assert(splitCalls.length === 0, "没有起 Blender");
  });

  await it("扩展名不在白名单 → 400 且列出全部允许格式", async() => {
    clearState();
    await routes.handleSplit(multipartReq("evil.exe", Buffer.from("MZ")), fakeRes());
    assert(lastJSON().statusCode === 400, "400");
    assert(lastJSON().data.error === `不支持的格式: .exe，支持 ${ALLOWED_EXTENSIONS.join(" / ")}`, "文案含白名单");
    assert(splitCalls.length === 0, "没有起 Blender");
  });

  await it("上限用共享的 MAX_FILE_SIZE，而不是更小的自定义值", async() => {
    clearState();
    // MAX_FILE_SIZE 是 150MB，拿它做真边界要把 150MB 读进内存，单元测试付不起；
    // 退一步钉住「没有被人换成更小的上限」：一个几百 KB 的 GLB 必须原样进到
    // runBlenderSplit，途中不被 readBody 当成超大请求体掐掉。
    const big = Buffer.alloc(400 * 1024, 0x47);
    plantSplitOutput();
    await routes.handleSplit(multipartReq("big.glb", big), fakeRes());
    assert(splitCalls.length === 1, "几百 KB 的模型没被误判成超大");
    assert(splitCalls[0][0] && fs.existsSync(splitCalls[0][0]) === false, "input 已消费并清掉");
    assert(jsonCalls.length === 0, "没有报请求体太大");
  });

  await it("大写扩展名同样放行", async() => {
    clearState();
    plantSplitOutput();
    await routes.handleSplit(multipartReq("MODEL.GLB", Buffer.from("x")), fakeRes());
    assert(jsonCalls.length === 0, "没有报格式不支持");
    assert(splitCalls.length === 1, "进了 Blender");
    assert(/^input-\d+-[a-z0-9]+\.glb$/.test(path.basename(splitCalls[0][0])), "扩展名已转小写落盘");
  });

  await it("runBlenderSplit 参数：input/output/manifest/文件名", async() => {
    clearState();
    plantSplitOutput();
    await routes.handleSplit(multipartReq("My Model.glb", Buffer.from("GLB!")), fakeRes());
    const c = splitCalls[0];
    assert(c.length === 5, "五个参数");
    assert(/^input-\d+-[a-z0-9]+\.glb$/.test(path.basename(c[0])), "input 落在 UPLOAD_DIR 且保留扩展名");
    assert(/^output-\d+-[a-z0-9]+\.glb$/.test(path.basename(c[1])), "output 路径");
    assert(/^manifest-\d+-[a-z0-9]+\.json$/.test(path.basename(c[2])), "manifest 路径");
    assert(c[3] === "My Model.glb", "原始文件名透传");
    assert(c[4] === null, "未开语义标注时 vlm 为 null");
    assert(binaryCalls.length === 1 && binaryCalls[0].baseName === "split", "以 split 回二进制");
    assert(binaryCalls[0].manifest.total_parts === 7, "manifest 透传");
    assert(binaryCalls[0].glbBuffer.toString() === "SPLIT-GLB", "GLB 来自落盘文件");
  });

  await it("Blender 抛错：stdout/stderr 取自 berr", async() => {
    clearState();
    splitImpl = async() => { throw Object.assign(new Error("崩"), { stdout: "SO", stderr: "SE" }); };
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.blender_output === "SO", "blender_output 优先取 stdout");

    clearState();
    splitImpl = async() => { throw Object.assign(new Error("崩"), { stdout: "SO2" }); };
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(lastJSON().data.blender_output === "SO2", "没有 stdout 时才回落 stderr");
  });

  await it("Blender 崩掉且没给 stderr 时回落 berr.message", async() => {
    clearState();
    splitImpl = async() => { throw new Error("拆解进程超时"); };
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.blender_output === "拆解进程超时", "blenderStderr 回落到 message");
    assert(lastJSON().data.error.endsWith("拆解进程超时"), "报错文案也带上它");
  });

  await it("GLB 缺失 / manifest 缺失各有报错文案", async() => {
    clearState();
    splitImpl = async() => ({ stdout: "o", stderr: "boom-detail" });
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(lastJSON().data.error.startsWith("Blender 未生成输出文件。Blender 日志:"), "GLB 文案");
    assert(lastJSON().data.error.endsWith("boom-detail"), "带 stderr 前 3000 字");

    clearState();
    splitImpl = async(inputPath, outputPath) => {
      fs.writeFileSync(outputPath, "G");
      return { stdout: "", stderr: "no-man" };
    };
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(lastJSON().data.error.startsWith("Blender 未生成清单文件。Blender 日志:"), "manifest 文案");
  });

  await it("VLM 标注三级门槛", async() => {
    // 全配齐 → 启用
    clearState();
    resetConfig({ semanticLabel: true, vlm: { provider: "openai", model: "gpt-x" }, openai: { key: "k1" } });
    plantSplitOutput();
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    const vlm = splitCalls[0][4];
    assert(vlm && vlm.provider === "openai" && vlm.model === "gpt-x" && vlm.key === "k1", "provider/model/key 都来自配置");
    assert(AI_CONFIG.semanticLabel === true, "配置已生效");

    // 没开 semanticLabel → 不启用
    clearState();
    resetConfig({ semanticLabel: false, vlm: { provider: "openai", model: "gpt-x" }, openai: { key: "k1" } });
    plantSplitOutput();
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(splitCalls[0][4] === null, "未开启则不启用");

    // 开了但缺 key → 只 warn，不启用
    clearState();
    resetConfig({ semanticLabel: true, vlm: { provider: "openai", model: "gpt-x" }, openai: { key: "" } });
    plantSplitOutput();
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(splitCalls[0][4] === null, "缺 Key 时不启用");

    // 没给 vlm.model → 回落空串
    clearState();
    resetConfig({ semanticLabel: true, vlm: { provider: "openai" }, openai: { key: "k1" } });
    plantSplitOutput();
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(splitCalls[0][4] && splitCalls[0][4].model === "", "缺 model 时传空串而不是 undefined");

    // 开了但没配 provider → 不启用
    clearState();
    // loadAIConfig 顶层 spread 会保留上一轮的 vlm，显式给空对象才是「没配 provider」
    resetConfig({ semanticLabel: true, vlm: {}, openai: { key: "k1" } });
    plantSplitOutput();
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), fakeRes());
    assert(splitCalls[0][4] === null, "没配 vlm.provider 时不启用");
  });

  await it("成功后 input / output / manifest 三个临时文件全删", async() => {
    clearState();
    plantSplitOutput();
    let inP = "", outP = "", manP = "";
    splitImpl = async(inputPath, outputPath, manifestPath) => {
      inP = inputPath; outP = outputPath; manP = manifestPath;
      fs.writeFileSync(outputPath, "G");
      fs.writeFileSync(manifestPath, "{}");
      return { stdout: "", stderr: "" };
    };
    splitImpl = async(inputPath, outputPath, manifestPath) => {
      await new Promise(r => setTimeout(r, 320));
      inP = inputPath; outP = outputPath; manP = manifestPath;
      fs.writeFileSync(outputPath, "G");
      fs.writeFileSync(manifestPath, "{}");
      return { stdout: "", stderr: "" };
    };
    const res = fakeRes();
    await routes.handleSplit(multipartReq("m.glb", Buffer.from("x")), res);
    assert(fs.existsSync(inP) === false, "input 已删");
    assert(!fs.existsSync(outP), "output 已删");
    assert(!fs.existsSync(manP), "manifest 已删");
    assert(res.rec.statusCode === 200, "二进制响应 200");
    const el = binaryCalls[0].elapsed;
    assert(Number(el) >= 0.3, `split 的 elapsed 反映真实耗时（${el}s）`);
    assert(Number(el) < 30, `elapsed 不是 epoch 起点（${el}s）`);
  });
});

// ===== 运行 =====
function cleanup() {
  console.log = realLog;
  console.warn = console.warn;
  console.error = realErr;
  setConfigFilePath(REAL_CONFIG);
  loadAIConfig();
  for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true });
}

(async() => {
  console.log = () => {};   // 只压掉被测模块的命令行日志，断言仍走 realLog/realErr
  console.warn = () => {};
  console.error = () => {};
  try {
    for (const item of describeQueue) {
      realLog(`\n── ${item.name}`);
      await item.fn();
    }
  } finally {
    cleanup();
  }
  realLog("\n════════════════════════════════════════════════════════════════");
  realLog(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    realLog("  失败的用例:");
    for (const f of failures) realLog("    - " + f);
    process.exit(1);
  }
  realLog("  ✅ 全部测试通过！");
})();
