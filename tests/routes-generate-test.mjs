#!/usr/bin/env node
/**
 * 单元测试 — AI 生成类路由（src/routes-generate.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - handleImageTo3D：image 缺失/不是 data URL → 400；data URL 不符合
 *     data:(image/*);base64,(*) → 400；maxSize 25MB；mode 取 body.deploy，
 *     缺省再看 AI_CONFIG.replicate.mode，最后回落 "local"；
 *   - 转发给调度器的参数：body 整体、纯 base64、mime、config（AI_CONFIG 本体）、
 *     deps（注入的同一对象）；
 *   - finishImageTo3D 以 baseName "img-to-3d" 走 sendBinaryResult；
 *     异常带 status 400 → 400 且只给 error，否则 500 带 success:false；
 *   - handleTextTo3D：prompt 去空白后为空 → 400；mode=local 只跑本地；
 *     mode=cloud 调 runHyper3DTextTo3D(AI_CONFIG.providers.hyper3d, prompt)；
 *     auto 有 Hyper3D Key 走云端、无 Key 走本地，云端失败 warn 后回退本地；
 *     prompt 去空白后为空 → 400，但数字 prompt 会被字符串化后照常分派；
 *     两个 handler 的请求体上限分别是 25MB / 64KB；
 *     异常带 status 400 → 400 且只给 error，其余（含被包装后的本地推理
 *     异常）→ 500；elapsed 是两位小数字符串且由真实 startTime 算出；
 *   - runLocalTextTo3D：脚本在 <rootDir>/scripts/hunyuan3d_text_infer.py；
 *     python 取 HY3D_PYTHON > <hunyuanDir>/.venv/bin/python3 > python3；
 *     HUNYUAN3D_DIR 会同时改变 venv 位置并追加 --hunyuan-dir；
 *     HY3D_DEVICE 缺省 auto；超时 30 分钟、maxBuffer 200MB；
 *     推理失败文案带 stderr 前 2000 字；GLB 缺失时给出环境准备提示，
 *     文案里 stderr 截到 800 字；
 *     manifest 缺失或非法 JSON 时用 { total_parts:0, parts:[] }；
 *     临时文件用完即删；成功以 baseName "text-to-3d" 回二进制。
 *
 * 用法：node tests/routes-generate-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGenerateRoutes } from "../src/routes-generate.js";
import { AI_CONFIG, loadAIConfig, setConfigFilePath } from "../src/ai-config.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
let passed = 0;
let failed = 0;
const failures = [];

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
const madeDirs = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(d);
  return d;
}
function resetConfig(state = {}) {
  const d = tmp("genroutes-cfg-");
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
function rawReq(buffer) {
  const req = Readable.from([buffer]);
  req.headers = { "content-type": "application/json" };
  return req;
}
function fakeRes() {
  const rec = { statusCode: null, body: null };
  return {
    rec,
    writeHead(statusCode, headers) { rec.statusCode = statusCode; rec.headers = headers; },
    end(body) { rec.body = body === undefined ? null : body; },
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

const genCalls = [];
let genImpl = async() => ({ glbBuffer: Buffer.from("GEN-GLB"), manifest: { total_parts: 2 } });
const generateImageTo3D = async(args) => {
  genCalls.push(args);
  return genImpl(args);
};

const hyperCalls = [];
let hyperImpl = async() => ({ glbBuffer: Buffer.from("HYPER-GLB"), manifest: { total_parts: 1 } });
const runHyper3DTextTo3D = async(cfg, prompt) => {
  hyperCalls.push({ cfg, prompt });
  return hyperImpl();
};

const execCalls = [];
let execImpl = async(bin, args) => {
  fs.writeFileSync(args[4], "GLB");
  fs.writeFileSync(args[6], JSON.stringify({ total_parts: 3 }));
  return { stdout: "OUT", stderr: "" };
};
const execFile = async(bin, args, opts) => {
  execCalls.push({ bin, args: args.slice(), opts });
  return execImpl(bin, args, opts);
};

const IMAGE_TO_3D_DEPS = { marker: "sentinel-deps" };
let uploadDir = tmp("genroutes-upload-");
let rootDir = tmp("genroutes-root-");
const SCRIPT = () => path.join(rootDir, "scripts", "hunyuan3d_text_infer.py");

function build(overrides = {}) {
  return createGenerateRoutes({
    sendJSON,
    sendBinaryResult,
    IMAGE_TO_3D_DEPS,
    uploadDir,
    rootDir,
    execFile,
    generateImageTo3D,
    runHyper3DTextTo3D,
    ...overrides,
  });
}
let routes = build();

function clearState() {
  jsonCalls.length = 0;
  binaryCalls.length = 0;
  genCalls.length = 0;
  hyperCalls.length = 0;
  execCalls.length = 0;
  genImpl = async() => ({ glbBuffer: Buffer.from("GEN-GLB"), manifest: { total_parts: 2 } });
  hyperImpl = async() => ({ glbBuffer: Buffer.from("HYPER-GLB"), manifest: { total_parts: 1 } });
  execImpl = async(bin, args) => {
    fs.writeFileSync(args[4], "GLB");
    fs.writeFileSync(args[6], JSON.stringify({ total_parts: 3 }));
    return { stdout: "OUT", stderr: "" };
  };
}

// 造一个可用于本地链路的 rootDir：有推理脚本
function freshRoot() {
  rootDir = tmp("genroutes-root-");
  fs.mkdirSync(path.join(rootDir, "scripts"), { recursive: true });
  fs.writeFileSync(SCRIPT(), "# fake infer script\n");
  routes = build();
  return rootDir;
}

describe("handleImageTo3D 校验", async() => {
  await it("image 缺失 / 非 data URL → 400", async() => {
    for (const body of [{}, { image: "http://x/a.png" }, { image: "" }]) {
      clearState();
      await routes.handleImageTo3D(fakeReq(body), fakeRes());
      assert(lastJSON().statusCode === 400, `状态码 400（${JSON.stringify(body)}）`);
      assert(lastJSON().data.error === "缺少有效的图片数据（image 字段应为 data URL）", "文案");
      assert(genCalls.length === 0, "未调调度器");
    }
  });

  await it("data URL 格式错误 → 400", async() => {
    clearState();
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png,raw" }), fakeRes());
    assert(lastJSON().statusCode === 400, "状态码 400");
    assert(lastJSON().data.error === "图片 data URL 格式错误", "文案");
    assert(genCalls.length === 0, "未调调度器");
  });

  await it("超过 25MB 的请求体 → 500 请求体太大", async() => {
    clearState();
    await routes.handleImageTo3D(rawReq(Buffer.alloc(25 * 1024 * 1024 + 1, 0x78)), fakeRes());
    assert(lastJSON().statusCode === 500, "状态码 500");
    assert(lastJSON().data.error === "请求体太大", "文案");
  });

  await it("24MB 的请求体仍能读完（上限在 24MB 与 25MB+1 之间）", async() => {
    clearState();
    const raw = Buffer.from(
      JSON.stringify({ image: "data:image/png;base64,QQ==", pad: "x".repeat(24 * 1024 * 1024) }),
      "utf-8",
    );
    assert(raw.length > 24 * 1024 * 1024, "请求体确实超过 24MB");
    await routes.handleImageTo3D(rawReq(raw), fakeRes());
    assert(binaryCalls.length === 1, "读完请求体并进入分派，没有被误判成超大");
  });
});

describe("handleImageTo3D 分派与响应", async() => {
  await it("转发参数：body / base64 / mime / config / deps", async() => {
    clearState();
    resetConfig();
    const body = { image: "data:image/webp;base64,QQ==", deploy: "meshy", name: "n" };
    await routes.handleImageTo3D(fakeReq(body), fakeRes());
    assert(genCalls.length === 1, "调度器调一次");
    const a = genCalls[0];
    assert(a.mode === "meshy", "body.deploy 作为 mode");
    assert(a.body === body || a.body.deploy === "meshy", "body 透传");
    assert(a.imageBase64 === "QQ==", "纯 base64（不含前缀）");
    assert(a.mime === "image/webp", "mime 取自 data URL");
    assert(a.config === AI_CONFIG, "config 是 AI_CONFIG 本体");
    assert(a.deps === IMAGE_TO_3D_DEPS, "deps 是注入的同一对象");
  });

  await it("mode 三级回落：body.deploy → AI_CONFIG.replicate.mode → local", async() => {
    clearState();
    resetConfig({ replicate: { mode: "replicate" } });
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png;base64,QQ==" }), fakeRes());
    assert(genCalls[0].mode === "replicate", "无 deploy 时取 replicate.mode");

    clearState();
    // loadAIConfig 与默认值深合并，写空串才能覆盖掉上一轮的 replicate.mode，
    // 等价于「配置里没填 mode」对 || 链的效果
    resetConfig({ replicate: { mode: "" } });
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png;base64,QQ==" }), fakeRes());
    assert(genCalls[0].mode === "local", "replicate.mode 也是假值时回落 local");

    clearState();
    resetConfig({ replicate: { mode: "replicate" } });
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png;base64,QQ==", deploy: "tripo" }), fakeRes());
    assert(genCalls[0].mode === "tripo", "有 deploy 时优先");
  });

  await it("成功走 finishImageTo3D：baseName img-to-3d", async() => {
    clearState();
    genImpl = async() => {
      await new Promise(r => setTimeout(r, 320)); // 让 elapsed 有非零值可断言
      return { glbBuffer: Buffer.from("GEN-GLB"), manifest: { total_parts: 2 } };
    };
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png;base64,QQ==" }), fakeRes());
    assert(binaryCalls.length === 1, "sendBinaryResult 调一次");
    const b = binaryCalls[0];
    assert(b.baseName === "img-to-3d", "基名 img-to-3d");
    assert(b.glbBuffer.toString() === "GEN-GLB", "传出调度器给的 GLB");
    assert(b.manifest.total_parts === 2, "manifest 透传");
    assert(/^\d+\.\d{2}$/.test(b.elapsed), `elapsed 是两位小数字符串（${b.elapsed}）`);
    assert(Number(b.elapsed) >= 0.3, `elapsed 由真实起点算出（${b.elapsed}s）`);
    assert(Number(b.elapsed) < 30, `elapsed 不是 epoch 起点（${b.elapsed}s）`);
  });

  await it("status 400 的异常 → 400 只给 error；其余 → 500", async() => {
    clearState();
    genImpl = async() => { throw Object.assign(new Error("图片太大"), { status: 400 }); };
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png;base64,QQ==" }), fakeRes());
    assert(lastJSON().statusCode === 400, "带 status 400 就用 400");
    assert(Object.keys(lastJSON().data).length === 1 && lastJSON().data.error === "图片太大", "只有 error 字段");

    clearState();
    genImpl = async() => { throw new Error("boom"); };
    await routes.handleImageTo3D(fakeReq({ image: "data:image/png;base64,QQ==" }), fakeRes());
    assert(lastJSON().statusCode === 500, "无 status 用 500");
    assert(lastJSON().data.success === false && lastJSON().data.error === "boom", "信封带 success:false");
  });
});

describe("handleTextTo3D", async() => {
  await it("prompt 去空白后为空 → 400", async() => {
    for (const p of ["", "   ", undefined, null]) {
      clearState();
      await routes.handleTextTo3D(fakeReq({ prompt: p }), fakeRes());
      assert(lastJSON().statusCode === 400, `prompt=${JSON.stringify(p)} → 400`);
      assert(lastJSON().data.error === "缺少 prompt 文本（文生3D 需要自然语言提示词）", "文案");
      assert(hyperCalls.length === 0, "未调云端");
      assert(execCalls.length === 0, "未调本地");
    }
  });

  await it("prompt 超过 64KB → 500 请求体太大", async() => {
    clearState();
    resetConfig();
    const big = Buffer.from(JSON.stringify({ prompt: "x".repeat(64 * 1024) }), "utf-8");
    await routes.handleTextTo3D(rawReq(big), fakeRes());
    assert(lastJSON().statusCode === 500, "状态码 500");
    assert(lastJSON().data.error === "请求体太大", "文案");
    assert(execCalls.length === 0 && hyperCalls.length === 0, "没进任何分派");
  });

  await it("mode=cloud 抛 status 400 → 400 且只给 error", async() => {
    clearState();
    resetConfig({ providers: { hyper3d: { apiKey: "k1" } } });
    hyperImpl = async() => { throw Object.assign(new Error("prompt 违规"), { status: 400 }); };
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "cloud" }), fakeRes());
    assert(lastJSON().statusCode === 400, "带 status 400 就用 400");
    assert(Object.keys(lastJSON().data).length === 1 && lastJSON().data.error === "prompt 违规", "只有 error 字段");
  });

  await it("数字 prompt 被字符串化，不会误判为空", async() => {
    clearState();
    freshRoot();
    await routes.handleTextTo3D(fakeReq({ prompt: 123, mode: "local" }), fakeRes());
    assert(jsonCalls.length === 0, "没有回 400");
    assert(execCalls.length === 1, "照常拉起本地推理");
    assert(execCalls[0].args[2] === "123", "prompt 转成字符串 '123'");
  });

  await it("mode=local 只跑本地", async() => {
    clearState();
    freshRoot();
    await routes.handleTextTo3D(fakeReq({ prompt: "  一架红色客机  ", mode: "local" }), fakeRes());
    assert(hyperCalls.length === 0, "不调云端");
    assert(execCalls.length === 1, "调本地推理");
    assert(execCalls[0].args.includes("一架红色客机"), "prompt 已去首尾空白");
    assert(binaryCalls.length === 1 && binaryCalls[0].baseName === "text-to-3d", "以 text-to-3d 回二进制");
  });

  await it("mode=cloud 调 Hyper3D 并用其配置", async() => {
    clearState();
    resetConfig({ providers: { hyper3d: { apiKey: "k1", mode: "MAIN_SITE" } } });
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "cloud" }), fakeRes());
    assert(execCalls.length === 0, "不跑本地");
    assert(hyperCalls.length === 1, "调云端一次");
    assert(hyperCalls[0].prompt === "p", "prompt 透传");
    assert(hyperCalls[0].cfg === AI_CONFIG.providers.hyper3d, "传 providers.hyper3d");
    assert(binaryCalls.length === 1 && binaryCalls[0].baseName === "img-to-3d", "云端结果也走 finishImageTo3D");
  });

  await it("auto：有 Key 走云端", async() => {
    clearState();
    resetConfig({ providers: { hyper3d: { apiKey: "k1" } } });
    await routes.handleTextTo3D(fakeReq({ prompt: "p" }), fakeRes());
    assert(hyperCalls.length === 1 && execCalls.length === 0, "走了云端");
  });

  await it("auto：无 Key 走本地", async() => {
    clearState();
    resetConfig({ providers: { hyper3d: { apiKey: "" } } });
    freshRoot();
    await routes.handleTextTo3D(fakeReq({ prompt: "p" }), fakeRes());
    assert(hyperCalls.length === 0, "未调云端");
    assert(execCalls.length === 1, "走了本地");
  });

  await it("auto：云端失败回退本地", async() => {
    clearState();
    resetConfig({ providers: { hyper3d: { apiKey: "k1" } } });
    hyperImpl = async() => { throw new Error("hyper 超时"); };
    freshRoot();
    await routes.handleTextTo3D(fakeReq({ prompt: "p" }), fakeRes());
    assert(hyperCalls.length === 1, "先试了云端");
    assert(execCalls.length === 1, "失败后回退本地");
    assert(binaryCalls.length === 1 && binaryCalls[0].baseName === "text-to-3d", "最终用本地结果");
  });

  await it("本地推理异常一律 500（包装成新 Error 后 status 丢失）", async() => {
    clearState();
    resetConfig({ providers: { hyper3d: { apiKey: "" } } });
    freshRoot();
    execImpl = async() => { throw Object.assign(new Error("bad prompt"), { status: 400 }); };
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
    assert(lastJSON().statusCode === 500, "execFile 抛的 status 400 不会透传");

    clearState();
    execImpl = async() => { throw new Error("别的错"); };
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
    assert(lastJSON().statusCode === 500, "其余异常也是 500");
    assert(lastJSON().data.error.startsWith("Hunyuan3D-2 推理失败: ") && lastJSON().data.error.includes("别的错"), "文案带包装前缀");
  });
});

describe("runLocalTextTo3D 本地推理", async() => {
  await it("脚本路径、参数与超时", async() => {
    clearState();
    freshRoot();
    const prevDevice = process.env.HY3D_DEVICE;
    delete process.env.HY3D_DEVICE;
    try {
      await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
      const c = execCalls[0];
      assert(c.args[0] === SCRIPT(), "第一个参数是推理脚本（仓库根下）");
      assert(c.args[1] === "--prompt" && c.args[2] === "p", "prompt");
      assert(c.args[3] === "--output", "--output 参数");
      // jobId 自带 txt3d- 前缀，拼文件名时又加了一次，故实际是 txt3d-txt3d-...
      const glbName = path.basename(c.args[4]);
      assert(/^txt3d-txt3d-\d+-[a-z0-9]+\.glb$/.test(glbName), "输出 GLB 落在 uploadDir");
      assert(c.args[5] === "--manifest" && /txt3d-.*\.json$/.test(path.basename(c.args[6])), "manifest 路径");
      assert(c.args[7] === "--device" && c.args[8] === "auto", "device 缺省 auto");
      assert(!c.args.includes("--hunyuan-dir"), "未设 HUNYUAN3D_DIR 时不带该参数");
      assert(c.opts.timeout === 1800_000, "超时 30 分钟");
      assert(c.opts.maxBuffer === 200 * 1024 * 1024, "maxBuffer 200MB");
      assert(c.bin === "python3", "默认用系统 python3");
    } finally {
      if (prevDevice !== undefined) process.env.HY3D_DEVICE = prevDevice;
    }
  });

  await it("python 选择：HY3D_PYTHON > venv > python3", async() => {
    clearState();
    freshRoot();
    const prevPy = process.env.HY3D_PYTHON;
    const prevDir = process.env.HUNYUAN3D_DIR;
    try {
      process.env.HY3D_PYTHON = "/opt/py/bin/python";
      await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
      assert(execCalls[0].bin === "/opt/py/bin/python", "HY3D_PYTHON 最优先");
      delete process.env.HY3D_PYTHON;
      assert(!fs.existsSync("/nonexistent/.venv/bin/python3"), "准备构造 venv 场景");

      clearState();
      const hunyuanDir = tmp("genroutes-hunyuan-");
      fs.mkdirSync(path.join(hunyuanDir, ".venv", "bin"), { recursive: true });
      const venvPy = path.join(hunyuanDir, ".venv", "bin", "python3");
      fs.writeFileSync(venvPy, "");
      process.env.HUNYUAN3D_DIR = hunyuanDir;
      await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
      assert(execCalls[0].bin === venvPy, "其次用 venv 里的 python3");
      assert(execCalls[0].args.includes("--hunyuan-dir") && execCalls[0].args.includes(hunyuanDir), "带 --hunyuan-dir");

      // 不设 HUNYUAN3D_DIR 时，venv 在 <rootDir>/external/Hunyuan3D-2/.venv 下
      delete process.env.HUNYUAN3D_DIR;
      clearState();
      const defaultDir = path.join(rootDir, "external", "Hunyuan3D-2");
      fs.mkdirSync(path.join(defaultDir, ".venv", "bin"), { recursive: true });
      const defaultPy = path.join(defaultDir, ".venv", "bin", "python3");
      fs.writeFileSync(defaultPy, "");
      await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
      assert(execCalls[0].bin === defaultPy, "默认 Hunyuan3D-2 克隆路径");
      assert(!execCalls[0].args.includes("--hunyuan-dir"), "默认路径不追加该参数");
    } finally {
      if (prevPy === undefined) delete process.env.HY3D_PYTHON; else process.env.HY3D_PYTHON = prevPy;
      if (prevDir === undefined) delete process.env.HUNYUAN3D_DIR; else process.env.HUNYUAN3D_DIR = prevDir;
    }
  });

  await it("HY3D_DEVICE 透传", async() => {
    clearState();
    freshRoot();
    const prev = process.env.HY3D_DEVICE;
    try {
      process.env.HY3D_DEVICE = "cuda:1";
      await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
      assert(execCalls[0].args[8] === "cuda:1", "device 取环境变量");
    } finally {
      if (prev === undefined) delete process.env.HY3D_DEVICE; else process.env.HY3D_DEVICE = prev;
    }
  });

  await it("推理脚本缺失 → 明确报错", async() => {
    clearState();
    rootDir = tmp("genroutes-root-empty-");
    routes = build();
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
    assert(execCalls.length === 0, "没有起进程");
    assert(lastJSON().statusCode === 500, "500");
    assert(lastJSON().data.error === "未找到推理脚本: " + SCRIPT(), "报错含脚本路径");
  });

  await it("推理失败文案带 stderr 前 2000 字", async() => {
    clearState();
    freshRoot();
    execImpl = async() => { const e = new Error("x"); e.stderr = "E".repeat(5000); throw e; };
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
    assert(lastJSON().data.error.startsWith("Hunyuan3D-2 推理失败: "), "前缀");
    assert(lastJSON().data.error.length === "Hunyuan3D-2 推理失败: ".length + 2000, "stderr 截到 2000 字");
  });

  await it("GLB 未生成 → 环境准备提示", async() => {
    clearState();
    freshRoot();
    execImpl = async() => ({ stdout: "", stderr: "S".repeat(5000) }); // 成功但没写出 GLB
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
    assert(lastJSON().statusCode === 500, "500");
    const tail = lastJSON().data.error.slice(-800);
    assert(/^S+$/.test(tail), "stderr 截到 800 字");
    assert(!lastJSON().data.error.endsWith("S".repeat(801)), "不多截（恰好 800 字）");
    assert(lastJSON().data.error.includes("本地文生3D 未生成 GLB"), "主文案");
    assert(lastJSON().data.error.includes("scripts/setup_hunyuan3d.sh"), "给出准备脚本");
    assert(lastJSON().data.error.includes("NVIDIA CUDA GPU"), "说明 GPU 要求");
  });

  await it("manifest 缺失或非法 JSON → 用默认 manifest", async() => {
    for (const mode of ["absent", "invalid"]) {
      clearState();
      freshRoot();
      execImpl = async(bin, args) => {
        const out = args[4];
        fs.writeFileSync(out, "GLB");
        if (mode === "invalid") fs.writeFileSync(path.join(rootDir, "not-used.json"), "x");
        return { stdout: "", stderr: "" };
      };
      // 只写 GLB 不写 manifest：即 manifest 缺失
      await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
      assert(binaryCalls.length === 1, `manifest ${mode}：仍成功`);
      assert(binaryCalls[0].manifest.total_parts === 0 && Array.isArray(binaryCalls[0].manifest.parts), "默认 manifest");
      assert(binaryCalls[0].glbBuffer.toString() === "GLB", "GLB 内容来自落盘文件");
    }

    // 非法 JSON 的情况：execImpl 写出一个坏 manifest
    clearState();
    freshRoot();
    execImpl = async(bin, args) => {
      fs.writeFileSync(args[4], "GLB2");
      fs.writeFileSync(args[6], "{ not json");
      return { stdout: "", stderr: "" };
    };
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), fakeRes());
    assert(binaryCalls.length === 1, "manifest 非法仍成功");
    assert(binaryCalls[0].manifest.total_parts === 0, "回落默认 manifest");
  });

  await it("成功：临时文件用完即删", async() => {
    clearState();
    freshRoot();
    let outPath = "";
    execImpl = async(bin, args) => {
      await new Promise(r => setTimeout(r, 320));
      outPath = args[4];
      const mfPath = args[6];
      fs.writeFileSync(outPath, "GLB3");
      fs.writeFileSync(mfPath, JSON.stringify({ total_parts: 4 }));
      return { stdout: "", stderr: "" };
    };
    const res = fakeRes();
    await routes.handleTextTo3D(fakeReq({ prompt: "p", mode: "local" }), res);
    assert(binaryCalls[0].manifest.total_parts === 4, "读到写出的 manifest");
    const el = binaryCalls[0].elapsed;
    assert(/^\d+\.\d{2}$/.test(el) && Number(el) >= 0.3, `text-to-3d 的 elapsed 由真实起点算出（${el}s）`);
    assert(Number(el) < 30, `elapsed 不是 epoch 起点（${el}s）`);
    assert(!fs.existsSync(outPath), "输出 GLB 已删");
    assert(res.rec.statusCode === 200, "二进制响应 200");
  });
});

// ===== 运行 =====
function cleanup() {
  setConfigFilePath(REAL_CONFIG);
  loadAIConfig();
  for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true });
}

(async() => {
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
