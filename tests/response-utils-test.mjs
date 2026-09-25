#!/usr/bin/env node
/**
 * 单元测试 — 响应工具（src/response-utils.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - sendJSON：Content-Type 带 charset、混入 CORS 头、正文是 data 的 JSON；
 *   - respondError：err.status 只在 [400,600) 且为 number 时采用，否则 500；
 *     文案取 err.message，缺失回落 "Internal Server Error"；若响应头已发送
 *     则只 res.end()，不再写头写正文；
 *   - wrap：正常放行并 (req, res) 原样传给 handler；抛异常/拒绝时记一条
 *     error 日志并转为错误信封，不让连接挂起；
 *   - sendBinaryResult：X-Success/X-Total-Parts/X-Elapsed-Seconds/X-Manifest
 *     （manifest 的 base64）等头部齐全，正文是同一个 Buffer；随后把模型存盘，
 *     并按 shouldOpenInBlender() 决定是否拉起 Blender，存盘/打开失败只 warn
 *     不冒泡；
 *   - shouldOpenInBlender：OPEN_IN_BLENDER=0/1 强制覆盖，否则跟
 *     AI_CONFIG.openInBlender（live binding）；
 *   - openInBlender：darwin 用 BLENDER_PATH、其它平台用 PATH 里的 blender，
 *     都带 --python 指向导入脚本；glb 路径单独落一个临时文件避开空格；
 *     单飞语义——第二次拉起时第一次的子进程延迟 4s 收 SIGTERM、再 3s 收
 *     SIGKILL；macOS 额外 `open -a <Blender.app>` 提前台；15s 后清临时文件。
 *
 * 接缝：工厂收 spawn 与 platform 两个可选参数（默认真实实现），否则本测试会
 *   真的拉起 Blender 窗口；>=1s 的 setTimeout 同样被压缩为 0 并记录毫秒数。
 *
 * 用法：node tests/response-utils-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResponseUtils } from "../src/response-utils.js";
import { loadAIConfig, setConfigFilePath } from "../src/ai-config.js";

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

function fakeRes(overrides = {}) {
  const rec = { heads: [], body: null, ended: false };
  const res = {
    rec,
    writeHead(statusCode, headers) { rec.heads.push({ statusCode, headers }); },
    end(body) { rec.body = body === undefined ? null : body; rec.ended = true; },
    ...overrides,
  };
  rec.headersSent = res.headersSent === true;
  return res;
}

// 让出若干宏任务：>=1s 的 setTimeout 被压缩成 0ms，回调要等下一轮事件循环
async function flushTimers(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => realSetTimeout(r, 0));
}
const lastHead = (res) => res.rec.heads[res.rec.heads.length - 1];

// 假 spawn：记录调用、返回假子进程（unref + pid + kill 记账）
const spawnCalls = [];
const spawnedChildren = [];
function fakeSpawn(cmd, args, opts) {
  const child = {
    cmd,
    args,
    opts,
    pid: 1000 + spawnedChildren.length,
    unrefCalled: false,
    kills: [],
    unref() { this.unrefCalled = true; return this; },
    kill(sig) { this.kills.push(sig); return true; },
  };
  spawnCalls.push(child);
  spawnedChildren.push(child);
  return child;
}

const compressed = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (typeof ms === "number" && ms >= 1000) {
    compressed.push(ms);
    return realSetTimeout(fn, 0, ...args);
  }
  return realSetTimeout(fn, ms, ...args);
};

// 抑制被测模块里的 console.log / console.warn 噪音（assert 用自己的实现）
const realLog = console.log;
const realWarn = console.warn;
let warns = [];
function silenceConsole() {
  warns = [];
  console.log = () => {};
  console.warn = (...a) => warns.push(a.map(String).join(" "));
}
function restoreConsole() {
  console.log = realLog;
  console.warn = realWarn;
}

let GENERATED_DIR = tmp("resp-gen-");
let UPLOAD_DIR = tmp("resp-upload-");
const BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender";

function build(extra = {}) {
  return createResponseUtils({
    GENERATED_DIR,
    UPLOAD_DIR,
    BLENDER_PATH,
    spawn: fakeSpawn,
    platform: "darwin",
    ...extra,
  });
}

const { sendJSON, respondError, wrap, shouldOpenInBlender } = build();

const CORS_ORIGIN = "*";

describe("sendJSON", async() => {
  await it("写状态码 / JSON 头 / CORS 头，正文是 data 的序列化", async() => {
    const res = fakeRes();
    const data = { success: true, nested: { a: [1, 2] }, s: "中文" };
    sendJSON(res, 201, data);
    const h = lastHead(res);
    assert(h.statusCode === 201, "状态码透传");
    assert(h.headers["Content-Type"] === "application/json; charset=utf-8", "Content-Type 带 charset");
    assert(h.headers["Access-Control-Allow-Origin"] === CORS_ORIGIN, "混入 CORS 头");
    assert(res.rec.body === JSON.stringify(data), "正文是 JSON.stringify(data)");
    assert(res.rec.ended === true, "调用了 res.end");
  });
});

describe("respondError", async() => {
  await it("err.status 在 [400,600) 内时采用", async() => {
    for (const code of [400, 404, 429, 599]) {
      const res = fakeRes();
      respondError(res, Object.assign(new Error("x"), { status: code }));
      assert(lastHead(res).statusCode === code, `采用 status=${code}`);
    }
  });

  await it("越界 / 非数字 status 一律 500", async() => {
    for (const bad of [200, 302, 600, 700, "404", NaN, null]) {
      const res = fakeRes();
      respondError(res, { status: bad, message: "boom" });
      assert(lastHead(res).statusCode === 500, `status=${JSON.stringify(bad)} → 500`);
      assert(JSON.parse(res.rec.body).error === "boom", `status=${JSON.stringify(bad)} 仍带 message`);
    }
  });

  await it("文案取 err.message，缺失回落 Internal Server Error", async() => {
    const a = fakeRes();
    respondError(a, new Error("具体原因"));
    assert(JSON.parse(a.rec.body).error === "具体原因", "有 message 用 message");
    const b = fakeRes();
    respondError(b, { status: 400 });
    assert(JSON.parse(b.rec.body).error === "Internal Server Error", "无 message 回落");
    const c = fakeRes();
    respondError(c, null);
    assert(lastHead(c).statusCode === 500, "err 为 null 也兜得住");
    assert(JSON.parse(c.rec.body).error === "Internal Server Error", "err 为 null 的文案");
  });

  await it("信封统一 { success:false, error }", async() => {
    const res = fakeRes();
    respondError(res, new Error("e"));
    const body = JSON.parse(res.rec.body);
    assert(body.success === false, "success 为 false");
    assert(Object.keys(body).length === 2, "只有 success 与 error 两个字段");
  });

  await it("响应头已发送时只收尾，不再写头写正文", async() => {
    const res = fakeRes({ headersSent: true });
    respondError(res, new Error("中途出错"));
    assert(res.rec.heads.length === 0, "没有 writeHead");
    assert(res.rec.ended === true, "调用了 res.end 收尾");
  });
});

describe("wrap", async() => {
  await it("正常放行，并把 (req, res) 原样交给 handler", async() => {
    const req = { method: "GET", url: "/x" };
    const res = fakeRes();
    let seen = null;
    const handler = wrap(async(r, s) => { seen = [r, s]; });
    await handler(req, res);
    assert(seen[0] === req && seen[1] === res, "参数原样透传");
    assert(res.rec.heads.length === 0, "正常路径不写响应");
  });

  await it("同步抛出 → 转错误信封并记 error 日志", async() => {
    const req = { method: "POST", url: "/api/split" };
    const res = fakeRes();
    const logged = [];
    const { log } = await import("../src/logger.js");
    const realError = log.error;
    log.error = (...a) => logged.push(a.map(String).join(" "));
    try {
      const handler = wrap(async() => { throw new Error("handler 炸了"); });
      await handler(req, res);
    } finally {
      log.error = realError;
    }
    assert(lastHead(res).statusCode === 500, "状态码 500");
    assert(JSON.parse(res.rec.body).error === "handler 炸了", "错误信封带上原因");
    assert(logged.length === 1, "记了一条 error 日志");
    assert(logged[0].includes("POST /api/split"), `日志含方法与 URL（${logged[0]}）`);
    assert(logged[0].includes("handler 炸了"), "日志含错误信息");
  });

  await it("异步拒绝同样被兜住", async() => {
    const res = fakeRes();
    const { log } = await import("../src/logger.js");
    const realError = log.error;
    log.error = () => {};
    try {
      const boom = Object.assign(new Error("no"), { status: 502 });
      const handler = wrap(async() => { await Promise.resolve(); throw boom; });
      await handler({ method: "GET", url: "/y" }, res);
    } finally {
      log.error = realError;
    }
    assert(lastHead(res).statusCode === 502, "尊重 err.status");
    assert(JSON.parse(res.rec.body).error === "no", "信封带上原因");
  });

  await it("返回的是可用于 createServer 的函数", async() => {
    const h = wrap(async() => {});
    assert(typeof h === "function", "是函数");
    assert(h.length === 2, "签名为 (req, res)");
  });
});

describe("shouldOpenInBlender", async() => {
  await it("环境变量优先于配置", async() => {
    const prev = process.env.OPEN_IN_BLENDER;
    try {
      resetConfig({ openInBlender: true });
      process.env.OPEN_IN_BLENDER = "0";
      assert(shouldOpenInBlender() === false, "OPEN_IN_BLENDER=0 强制关（即使配置为 true）");
      process.env.OPEN_IN_BLENDER = "1";
      assert(shouldOpenInBlender() === true, "OPEN_IN_BLENDER=1 强制开");
      resetConfig({ openInBlender: false });
      assert(shouldOpenInBlender() === true, "OPEN_IN_BLENDER=1 压过关闭的配置");
      delete process.env.OPEN_IN_BLENDER;
      assert(shouldOpenInBlender() === false, "无环境变量时跟配置");
      resetConfig({ openInBlender: true });
      assert(shouldOpenInBlender() === true, "配置开启时开");
      assert(shouldOpenInBlender() === true, "返回布尔字面量");
    } finally {
      if (prev === undefined) delete process.env.OPEN_IN_BLENDER;
      else process.env.OPEN_IN_BLENDER = prev;
    }
  });

  await it("配置必须是布尔 true，真值不算", async() => {
    const prev = process.env.OPEN_IN_BLENDER;
    try {
      delete process.env.OPEN_IN_BLENDER;
      for (const truthy of [1, "yes", {}, []]) {
        resetConfig({ openInBlender: truthy });
        assert(shouldOpenInBlender() === false, `openInBlender=${JSON.stringify(truthy)} 不算开启`);
      }
      resetConfig({ openInBlender: true });
      assert(shouldOpenInBlender() === true, "只有 true 才开启");
    } finally {
      if (prev === undefined) delete process.env.OPEN_IN_BLENDER;
      else process.env.OPEN_IN_BLENDER = prev;
    }
  });

  await it("读到的是 AI_CONFIG 活绑定", async() => {
    const prev = process.env.OPEN_IN_BLENDER;
    try {
      delete process.env.OPEN_IN_BLENDER;
      resetConfig({ openInBlender: false });
      assert(shouldOpenInBlender() === false, "加载后为 false");
      resetConfig({ openInBlender: true });
      assert(shouldOpenInBlender() === true, "重新加载后为 true（未快照）");
    } finally {
      if (prev === undefined) delete process.env.OPEN_IN_BLENDER;
      else process.env.OPEN_IN_BLENDER = prev;
    }
  });
});

describe("saveGeneratedModel", async() => {
  await it("按 <baseName>-<时间戳>.glb 落盘并返回路径", async() => {
    silenceConsole();
    try {
      GENERATED_DIR = tmp("resp-gen-2-");
      const { saveGeneratedModel: save } = build();
      const buf = Buffer.from("GLBDATA");
      const p = save(buf, "split");
      assert(p.startsWith(GENERATED_DIR + path.sep), "落在注入的 GENERATED_DIR 下");
      const name = path.basename(p);
      assert(/^split-\d{4}-\d{2}-\d{2}T[\d-]+Z\.glb$/.test(name), `文件名形态（${name}）`);
      assert(fs.readFileSync(p).equals(buf), "文件内容就是传入的 Buffer");
    } finally {
      restoreConsole();
    }
  });

  await it("目录不存在时先创建", async() => {
    silenceConsole();
    try {
      const root = tmp("resp-gen-3-");
      GENERATED_DIR = path.join(root, "models", "generated");
      const { saveGeneratedModel: save } = build();
      const p = save(Buffer.from("x"), "m");
      assert(fs.existsSync(p), "递归创建目录后落盘成功");
    } finally {
      restoreConsole();
    }
  });
});

describe("sendBinaryResult", async() => {
  await it("头部齐全：manifest 走 base64，正文是同一个 Buffer", async() => {
    silenceConsole();
    try {
      GENERATED_DIR = tmp("resp-gen-4-");
      const { sendBinaryResult: send } = build();
      const glb = Buffer.from("BINARY-GLB");
      const manifest = { total_parts: 7, parts: ["a"] };
      const res = fakeRes();
      send(res, glb, manifest, "1.25", "ai-paint");
      const h = lastHead(res);
      assert(h.statusCode === 200, "状态码 200");
      assert(h.headers["Content-Type"] === "application/octet-stream", "二进制 Content-Type");
      assert(h.headers["Content-Length"] === glb.length, "Content-Length 与 Buffer 一致");
      assert(h.headers["Access-Control-Allow-Origin"] === CORS_ORIGIN, "带 CORS 头");
      assert(h.headers["X-Success"] === "true", "X-Success 为字符串 true");
      assert(h.headers["X-Total-Parts"] === "7", "X-Total-Parts 来自 manifest.total_parts");
      assert(h.headers["X-Elapsed-Seconds"] === "1.25", "X-Elapsed-Seconds 透传");
      assert(
        Buffer.from(h.headers["X-Manifest"], "base64").toString("utf-8") === JSON.stringify(manifest),
        "X-Manifest 是 manifest 的 base64",
      );
      assert(res.rec.body === glb, "正文是同一个 Buffer（未复制）");
    } finally {
      restoreConsole();
    }
  });

  await it("manifest 缺 total_parts 时 X-Total-Parts 为 0", async() => {
    silenceConsole();
    try {
      GENERATED_DIR = tmp("resp-gen-5-");
      const { sendBinaryResult: send } = build();
      const res = fakeRes();
      send(res, Buffer.from("b"), {}, "0.10", "m");
      assert(lastHead(res).headers["X-Total-Parts"] === "0", "回落 0");
    } finally {
      restoreConsole();
    }
  });

  await it("发完响应后把模型存盘（baseName 缺省 model）", async() => {
    silenceConsole();
    try {
      GENERATED_DIR = tmp("resp-gen-6-");
      const { sendBinaryResult: send } = build();
      const res = fakeRes();
      send(res, Buffer.from("b"), { total_parts: 1 }, "0.10", "");
      const files = fs.readdirSync(GENERATED_DIR);
      assert(files.length === 1, "落了一个文件");
      assert(/^model-\d{4}-.*\.glb$/.test(files[0]), `缺省基名为 model（${files[0]}）`);
    } finally {
      restoreConsole();
    }
  });

  await it("OPEN_IN_BLENDER=0 时不拉 Blender", async() => {
    silenceConsole();
    try {
      const prev = process.env.OPEN_IN_BLENDER;
      process.env.OPEN_IN_BLENDER = "0";
      GENERATED_DIR = tmp("resp-gen-7-");
      spawnCalls.length = 0;
      const { sendBinaryResult: send } = build();
      send(fakeRes(), Buffer.from("b"), { total_parts: 1 }, "0.10", "m");
      assert(spawnCalls.length === 0, "没有 spawn");
      if (prev === undefined) delete process.env.OPEN_IN_BLENDER; else process.env.OPEN_IN_BLENDER = prev;
    } finally {
      restoreConsole();
    }
  });

  await it("OPEN_IN_BLENDER=1 时存盘后自动拉起 Blender 导入该文件", async() => {
    silenceConsole();
    try {
      const prev = process.env.OPEN_IN_BLENDER;
      process.env.OPEN_IN_BLENDER = "1";
      GENERATED_DIR = tmp("resp-gen-8-");
      UPLOAD_DIR = tmp("resp-upload-8-");
      spawnCalls.length = 0;
      compressed.length = 0;
      const { sendBinaryResult: send } = build();
      const res = fakeRes();
      send(res, Buffer.from("b"), { total_parts: 1 }, "0.10", "m");
      const saved = fs.readdirSync(GENERATED_DIR)[0];
      assert(spawnCalls.length === 2, "darwin 先起 Blender 再 open -a（共两次 spawn）");
      assert(spawnCalls[0].args[1] !== saved, "导入的是落盘后的文件（脚本路径不是模型路径）");
      assert(spawnCalls[0].cmd === BLENDER_PATH, "用 BLENDER_PATH 直接启 GUI 二进制");
      assert(spawnCalls[0].args[0] === "--python" && spawnCalls[0].args.length === 2, "参数只有 --python <脚本>");
      assert(fs.existsSync(spawnCalls[0].args[1]), "导入脚本已写入");
      assert(spawnCalls[1].cmd === "open" && spawnCalls[1].args[0] === "-a", "macOS 额外提前台");
      assert(spawnCalls[1].args[1] === "/Applications/Blender.app", "从 BLENDER_PATH 抽出 .app 名");
      assert(spawnCalls.every((c) => c.opts.detached === true && c.opts.stdio === "ignore"), "detached + stdio ignore");
      assert(spawnCalls.every((c) => c.unrefCalled), "都 unref 过");
      assert(lastHead(res).statusCode === 200, "响应已先发出");
      assert(compressed.includes(15_000), "安排了 15s 清理临时文件");
      if (prev === undefined) delete process.env.OPEN_IN_BLENDER; else process.env.OPEN_IN_BLENDER = prev;
    } finally {
      restoreConsole();
    }
  });

  await it("存盘失败只 warn 不冒泡（且不拉 Blender）", async() => {
    silenceConsole();
    try {
      const root = tmp("resp-gen-9-");
      // 让 GENERATED_DIR 指向一个「文件」，mkdirSync 必失败
      const blocker = path.join(root, "blocker");
      fs.writeFileSync(blocker, "x");
      GENERATED_DIR = blocker;
      const prev = process.env.OPEN_IN_BLENDER;
      process.env.OPEN_IN_BLENDER = "1";
      spawnCalls.length = 0;
      const { sendBinaryResult: send } = build();
      const res = fakeRes();
      send(res, Buffer.from("b"), { total_parts: 1 }, "0.10", "m");
      assert(lastHead(res).statusCode === 200, "响应仍然正常（副作用失败不影响响应）");
      assert(spawnCalls.length === 0, "存盘失败就不去拉 Blender");
      assert(warns.some((w) => w.includes("模型存盘")), `有 warn（${warns[0]}）`);
      if (prev === undefined) delete process.env.OPEN_IN_BLENDER; else process.env.OPEN_IN_BLENDER = prev;
    } finally {
      restoreConsole();
    }
  });
});

describe("openInBlender", async() => {
  await it("glb 路径单独落临时文件，导入脚本含清场/导入/框选", async() => {
    silenceConsole();
    try {
      UPLOAD_DIR = tmp("resp-upload-10-");
      const glbPath = path.join(UPLOAD_DIR, "my model.glb");
      fs.writeFileSync(glbPath, "g");
      spawnCalls.length = 0;
      compressed.length = 0;
      const { openInBlender: open } = build();
      open(glbPath);
      const scriptPath = spawnCalls[0].args[1];
      const script = fs.readFileSync(scriptPath, "utf-8");
      assert(script.includes("import bpy"), "脚本首行 import bpy");
      assert(script.includes("bpy.ops.import_scene.gltf(filepath=fp)"), "走 import_scene.gltf 而非当文档打开");
      assert(script.includes("bpy.data.objects.remove(o, do_unlink=True)"), "先清场");
      assert(script.includes("bpy.ops.view3d.view_all(ctx)"), "再框选");
      assert(script.includes("VIEW_3D") && script.includes("WINDOW"), "只在有 3D 视口时框选");
      const pathFile = script.match(/pf = r'([^']+)'/)[1];
      assert(fs.readFileSync(pathFile, "utf-8") === glbPath, "路径单独写文件以避开空格/命令行解析");
      assert(pathFile.startsWith(UPLOAD_DIR + path.sep), "路径文件也在 UPLOAD_DIR 下");
      assert(scriptPath.startsWith(UPLOAD_DIR + path.sep), "导入脚本同样落在 UPLOAD_DIR");
      assert(/open_importer-\d+\.py$/.test(path.basename(scriptPath)), "脚本名 open_importer-<ts>.py");
      assert(compressed.includes(15_000), "安排了 15s 后清理两个临时文件");
      await flushTimers();
      assert(!fs.existsSync(scriptPath) && !fs.existsSync(pathFile), "压缩后临时文件已被删");
    } finally {
      restoreConsole();
    }
  });

  await it("非 darwin 用 PATH 里的 blender，且不 open -a", async() => {
    silenceConsole();
    try {
      UPLOAD_DIR = tmp("resp-upload-11-");
      spawnCalls.length = 0;
      const { openInBlender: open } = build({ platform: "linux" });
      open(path.join(UPLOAD_DIR, "a.glb"));
      assert(spawnCalls.length === 1, "只 spawn 一次");
      assert(spawnCalls[0].cmd === "blender", "非 darwin 用 blender");
      assert(spawnCalls[0].args[0] === "--python", "仍传 --python");
    } finally {
      restoreConsole();
    }
  });

  await it("BLENDER_PATH 不匹配 .app 形态时提前台用应用名 Blender", async() => {
    silenceConsole();
    try {
      UPLOAD_DIR = tmp("resp-upload-12-");
      spawnCalls.length = 0;
      const { openInBlender: open } = build({ BLENDER_PATH: "/usr/local/bin/blender" });
      open(path.join(UPLOAD_DIR, "a.glb"));
      const opener = spawnCalls.find((c) => c.cmd === "open");
      assert(!!opener, "仍然尝试提前台");
      assert(opener.args[1] === "Blender", "回落应用名 Blender");
    } finally {
      restoreConsole();
    }
  });

  await it("单飞：第二次拉起时，第一个子进程 4s 后 SIGTERM、再 3s 后 SIGKILL", async() => {
    silenceConsole();
    try {
      UPLOAD_DIR = tmp("resp-upload-13-");
      spawnCalls.length = 0;
      compressed.length = 0;
      const { openInBlender: open } = build();
      // 记下起点：每次 open 会 spawn 两个进程（Blender + open -a）
      const mark = spawnedChildren.length;
      const realKill = process.kill;
      const killed = [];
      process.kill = (pid, sig) => { killed.push({ pid, sig }); return true; };
      try {
        open(path.join(UPLOAD_DIR, "a.glb"));
        open(path.join(UPLOAD_DIR, "b.glb"));
        await flushTimers();
      } finally {
        process.kill = realKill;
      }
      const first = spawnedChildren[mark];        // 第一次打开的 Blender
      const second = spawnedChildren[mark + 2];   // 第二次打开的 Blender
      assert(spawnCalls.length === 4, "两次打开 ×（Blender + open -a）");
      assert(first.kills.length === 1 && first.kills[0] === "SIGTERM", "旧窗口先收 SIGTERM");
      assert(killed.length === 1 && killed[0].pid === first.pid && killed[0].sig === "SIGKILL", "兜底再收 SIGKILL");
      assert(compressed.includes(4000), "SIGTERM 前等 4000ms");
      assert(compressed.includes(3000), "SIGKILL 前再等 3000ms");
      assert(second.kills.length === 0, "新窗口不动");
    } finally {
      restoreConsole();
    }
  });
});

// ===== 运行 =====
let cfgDir = "";
function resetConfig(state = {}) {
  cfgDir = tmp("resp-cfg-");
  const cfgPath = path.join(cfgDir, "ai-config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: "openai", ...state }));
  setConfigFilePath(cfgPath);
  loadAIConfig();
}

function cleanup() {
  globalThis.setTimeout = realSetTimeout;
  console.log = realLog;
  console.warn = realWarn;
  delete process.env.OPEN_IN_BLENDER;
  setConfigFilePath(REAL_CONFIG);
  loadAIConfig();
  for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true });
}

(async() => {
  try {
    for (const item of describeQueue) {
      console.log(`\n── ${item.name}`);
      await item.fn();
    }
  } finally {
    cleanup();
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
