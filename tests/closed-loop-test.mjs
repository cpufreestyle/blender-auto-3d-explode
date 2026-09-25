#!/usr/bin/env node
/**
 * 单元测试 — 全自动闭环（src/closed-loop.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - handleGenToBlender：image 缺失/不是 data URL → 400；data URL 不符合
 *     data:(image/*);base64,(*) → 400；deploy 只认 meshy/tripo/hyper3d，
 *     其余值（含缺省）一律按 tripo；
 *   - 生成参数原样转发给 generateImageTo3D：mode / body / imageBase64 / mime
 *     / config（AI_CONFIG live binding）/ deps（IMAGE_TO_3D_DEPS 同一对象）；
 *   - saveGeneratedModel 收到 (out.glbBuffer, "<mode>-to-blender")；
 *     modelUrl = "/" + path.relative(rootDir, savedPath)——rootDir 是仓库根，
 *     搬进 src/ 后这一项已改为注入；
 *   - waitForBlenderAddon：先探 get_addon_status(2000ms)，autoLaunch 默认真，
 *     未就绪则拉起 Blender 再每 1500ms 轮询到超时；addon 未就绪 → 502 且
 *     带上 savedPath / modelUrl；
 *   - 导入失败（返回 falsy / succeed:false / 抛错）→ 502；get_scene_info 拿不到
 *     不影响成功；
 *   - handleBlenderExport：query name 优先，其次最近一次导入的对象，再其次
 *     execute_code 探测 Blender 当前激活/首个网格对象；探测失败或空 → 400；
 *     成功按二进制回传（Content-Length、X-Object-Name 编码），文件用完即删；
 *   - lastImportedObject 只在 handleGenToBlender 与 handleBlenderExport 之间
 *     共享：本测试对同一个闭包先导入后读回来证明这一点，其余用例各自开新闭包。
 *
 * 两处时间处理（不引入 sinon，也避免用例真等几十秒）：
 *   - waitForBlenderAddon 的 1500ms 轮询间隔被压缩为 0，并用压缩记录断言间隔值；
 *   - 「轮询到超时」用例把 Date.now 换成虚拟时钟（每次调用前进 20 秒），于是
 *     30s 预算只够再探一次，用例毫秒级完成且仍证明「反复探测到超时」。
 *
 * 用法：node tests/closed-loop-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createClosedLoop } from "../src/closed-loop.js";
import { AI_CONFIG, loadAIConfig, setConfigFilePath } from "../src/ai-config.js";

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
const CLEAN_STATE = { provider: "tripo" };

let cfgDir = "";
let madeDirs = [];

function resetConfig(state = {}) {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "closed-loop-cfg-"));
  madeDirs.push(cfgDir);
  const cfgPath = path.join(cfgDir, "ai-config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ ...CLEAN_STATE, ...state }));
  setConfigFilePath(cfgPath);
  loadAIConfig();
}

// 请求体：readBody 走 for await (const chunk of req) + req.headers
function fakeReq(bodyObj) {
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf-8");
  const req = Readable.from([raw]);
  req.headers = { "content-type": "application/json" };
  return req;
}
function rawReq(buffer) {
  const req = Readable.from([buffer]);
  req.headers = { "content-type": "application/json" };
  return req;
}

function fakeRes() {
  const rec = { statusCode: null, headers: null, body: null };
  return {
    rec,
    writeHead(statusCode, headers) { rec.statusCode = statusCode; rec.headers = headers; },
    end(body) { rec.body = body === undefined ? null : body; },
  };
}

const sendJSONCalls = [];
const sendJSON = (res, statusCode, data) => {
  sendJSONCalls.push({ statusCode, data });
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const lastJSON = () => sendJSONCalls[sendJSONCalls.length - 1];

const mcpCalls = [];
let mcpImpl = async() => ({});
const callBlenderMcp = async(type, params, timeoutMs) => {
  mcpCalls.push({ type, params, timeoutMs });
  return mcpImpl(type, params, timeoutMs);
};
const mcpOf = (type) => mcpCalls.filter((c) => c.type === type);

let launchCount = 0;
const launchBlenderApp = () => { launchCount++; };

const savedModels = [];
const saveGeneratedModel = (glbBuffer, baseName) => {
  savedModels.push({ glbBuffer, baseName });
  return SAVED_PATH;
};

// repo 根（server.js 传自己的 __dirname）：模型落在这个根的 models/generated/ 下
const ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "closed-loop-root-"));
madeDirs.push(ROOT_DIR);
const SAVED_PATH = path.join(ROOT_DIR, "models", "generated", "tripo-to-blender-2026.glb");
const EXPECT_MODEL_URL = "/models/generated/tripo-to-blender-2026.glb";

// IMAGE_TO_3D_DEPS 只被原样转发，用哨兵对象断言「同一份」
const IMAGE_TO_3D_DEPS = { marker: "sentinel-deps" };

const genCalls = [];
let genImpl = async() => ({ glbBuffer: Buffer.from("GLB"), format: "glb" });
const generateImageTo3D = async(args) => {
  genCalls.push(args);
  return genImpl(args);
};

// 新闭包 = 新的 lastImportedObject + 新的 UPLOAD_DIR，等价于新起一个 server 进程
function freshLoop() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "closed-loop-upload-"));
  madeDirs.push(uploadDir);
  return {
    uploadDir,
    ...createClosedLoop({
      sendJSON,
      generateImageTo3D,
      callBlenderMcp,
      launchBlenderApp,
      saveGeneratedModel,
      IMAGE_TO_3D_DEPS,
      UPLOAD_DIR: uploadDir,
      rootDir: ROOT_DIR,
    }),
  };
}
const loop = freshLoop();

function clearState() {
  sendJSONCalls.length = 0;
  mcpCalls.length = 0;
  launchCount = 0;
  savedModels.length = 0;
  genCalls.length = 0;
  mcpImpl = async() => ({});
  genImpl = async() => ({ glbBuffer: Buffer.from("GLB"), format: "glb" });
}

// 只压缩 waitForBlenderAddon 的 1500ms 轮询间隔，其余 setTimeout 保持真实
const compressedDelays = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (typeof ms === "number" && ms >= 1500) {
    compressedDelays.push(ms);
    return realSetTimeout(fn, 0, ...args);
  }
  return realSetTimeout(fn, ms, ...args);
};
function clearCompressed() { compressedDelays.length = 0; }

const goodBody = (extra = {}) => ({
  image: "data:image/png;base64,QUJD",
  deploy: "tripo",
  ...extra,
});
const mcpReady = async(type) => {
  if (type === "get_addon_status") return { succeed: true };
  if (type === "import_glb_from_file") return { name: "imported_object" };
  if (type === "get_scene_info") return { objects: 3 };
  return {};
};

describe("handleGenToBlender 请求体校验", async() => {
  await it("image 缺失 → 400，且不发起生成", async() => {
    clearState();
    const res = fakeRes();
    await loop.handleGenToBlender(fakeReq({ deploy: "tripo" }), res);
    assert(lastJSON().statusCode === 400, "状态码 400");
    assert(lastJSON().data.error === "缺少有效的图片数据（image 字段应为 data URL）", "缺少图片文案");
    assert(genCalls.length === 0, "generateImageTo3D 未被调用");
    assert(sendJSONCalls.length === 1, "只发了一次响应");
  });

  await it("image 不是 data URL → 400", async() => {
    clearState();
    await loop.handleGenToBlender(fakeReq({ image: "http://example.com/a.png" }), fakeRes());
    assert(lastJSON().statusCode === 400, "状态码 400（http 链接不算图片数据）");
    assert(lastJSON().data.error === "缺少有效的图片数据（image 字段应为 data URL）", "文案走「缺少图片」而非常格式错误");
    assert(genCalls.length === 0, "generateImageTo3D 未被调用");
  });

  await it("data URL 缺少 ;base64, → 400 格式错误", async() => {
    clearState();
    await loop.handleGenToBlender(fakeReq({ image: "data:image/png,notbase64" }), fakeRes());
    assert(lastJSON().statusCode === 400, "状态码 400");
    assert(lastJSON().data.error === "图片 data URL 格式错误", "格式错误文案");
    assert(genCalls.length === 0, "generateImageTo3D 未被调用");
  });

  await it("超过 25MB 的请求体按超限处理（readBody 早退）", async() => {
    clearState();
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x78); // 全是 'x'，流式阶段即超限
    await loop.handleGenToBlender(rawReq(oversized), fakeRes());
    assert(lastJSON().statusCode === 500, "状态码 500（异常由 catch 兜住）");
    assert(lastJSON().data.error === "请求体太大", "超限文案证明 maxSize 为 25MB");
    assert(genCalls.length === 0, "generateImageTo3D 未被调用");
  });

  await it("deploy 只认三家，未知值回落 tripo", async() => {
    for (const [deploy, expect] of [["meshy", "meshy"], ["hyper3d", "hyper3d"], ["unknown", "tripo"]]) {
      clearState();
      mcpImpl = mcpReady;
      await loop.handleGenToBlender(fakeReq(goodBody({ deploy })), fakeRes());
      assert(genCalls.length === 1 && genCalls[0].mode === expect, `deploy=${deploy} → mode ${expect}`);
    }
    clearState();
    mcpImpl = mcpReady;
    await loop.handleGenToBlender(fakeReq({ image: "data:image/png;base64,QUJD" }), fakeRes());
    assert(genCalls.length === 1 && genCalls[0].mode === "tripo", "deploy 缺省 → mode tripo");
  });
});

describe("handleGenToBlender 生成与落盘", async() => {
  await it("生成参数原样转发给调度器", async() => {
    clearState();
    mcpImpl = mcpReady;
    const body = goodBody({ deploy: "meshy", name: "MyName" });
    await loop.handleGenToBlender(fakeReq(body), fakeRes());
    assert(genCalls.length === 1, "调度器只调一次");
    const a = genCalls[0];
    assert(a.mode === "meshy", "mode 透传");
    assert(a.body.deploy === "meshy" && a.body.name === "MyName", "body 整体透传");
    assert(a.imageBase64 === "QUJD", "imageBase64 取 base64 段");
    assert(a.mime === "image/png", "mime 取 data URL 的类型段");
    assert(a.deps === IMAGE_TO_3D_DEPS, "deps 是注入的同一对象（未重建）");
  });

  await it("config 是 AI_CONFIG 的活绑定：改配置后下一次调用看到新值", async() => {
    clearState();
    mcpImpl = mcpReady;
    resetConfig({ provider: "ollama" });
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    const first = genCalls[0].config;
    assert(first === AI_CONFIG, "首次调用传入的就是 AI_CONFIG 本体");
    assert(first.provider === "ollama", "读到 loadAIConfig 写入的 provider");

    resetConfig({ provider: "lmstudio" });
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    const second = genCalls[1].config;
    assert(second === AI_CONFIG, "第二次仍然传入当前 AI_CONFIG");
    assert(second !== first, "重新加载后是新的绑定对象");
    assert(second.provider === "lmstudio", "读到的是新配置");
  });

  await it("落盘用 <mode>-to-blender 做基名，modelUrl 按 rootDir 取相对路径", async() => {
    clearState();
    mcpImpl = mcpReady;
    await loop.handleGenToBlender(fakeReq(goodBody({ deploy: "meshy" })), fakeRes());
    assert(savedModels.length === 1, "saveGeneratedModel 调一次");
    assert(savedModels[0].baseName === "meshy-to-blender", `基名（${savedModels[0].baseName}）`);
    assert(savedModels[0].glbBuffer.toString() === "GLB", "传出的是 out.glbBuffer");
    assert(lastJSON().data.modelUrl === EXPECT_MODEL_URL, `modelUrl（${lastJSON().data.modelUrl}）`);
    assert(lastJSON().data.savedPath === SAVED_PATH, "savedPath 原样回传");
  });
});

describe("waitForBlenderAddon 就绪探测", async() => {
  await it("首次探测即就绪：不拉 Blender、不轮询", async() => {
    clearState();
    clearCompressed();
    mcpImpl = mcpReady;
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    assert(lastJSON().statusCode === 200, "状态码 200");
    assert(launchCount === 0, "launchBlenderApp 未被调用");
    assert(compressedDelays.length === 0, "没有进入 1500ms 轮询");
    const probe = mcpOf("get_addon_status");
    assert(probe.length === 1, "只探测一次");
    assert(probe[0].timeoutMs === 2000, "探测超时 2000ms");
  });

  await it("autoLaunch 缺省为真：拉起 Blender 后轮询到就绪", async() => {
    clearState();
    clearCompressed();
    let probes = 0;
    mcpImpl = async(type) => {
      if (type === "get_addon_status") {
        probes++;
        if (probes === 1) throw new Error("addon 未启动");
        return { succeed: true };
      }
      return mcpReady(type);
    };
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    assert(lastJSON().statusCode === 200, "状态码 200");
    assert(launchCount === 1, "launchBlenderApp 调一次");
    assert(probes === 2, "首探失败后再探一次即成功");
    assert(compressedDelays.length === 1 && compressedDelays[0] === 1500, "轮询间隔 1500ms");
  });

  await it("autoLaunch=false：不拉 Blender，直接判未就绪", async() => {
    clearState();
    clearCompressed();
    mcpImpl = async(type) => { if (type === "get_addon_status") throw new Error("nope"); return {}; };
    await loop.handleGenToBlender(fakeReq(goodBody({ autoLaunch: false })), fakeRes());
    assert(launchCount === 0, "launchBlenderApp 未被调用");
    assert(mcpOf("import_glb_from_file").length === 0, "未走到导入");
    assert(lastJSON().statusCode === 502, "状态码 502");
  });

  await it("一直未就绪：轮询到超时后 502，并带回 savedPath/modelUrl", async() => {
    clearState();
    clearCompressed();
    mcpImpl = async(type) => { if (type === "get_addon_status") throw new Error("nope"); return {}; };
    // 虚拟时钟：每次 Date.now() 前进 20 秒。startTime 记第 1 次，deadline 取第
    // 2 次并加 30s，第 3 次判据仍为真（20 < 30）→ 再探一次，第 4 次越界退出。
    // 于是 30s 预算内恰好再探一次，无需真等。
    const realNow = Date.now;
    const VIRTUAL_STEP = 20_000;
    let vclock = 0;
    Date.now = () => (vclock += VIRTUAL_STEP, realNow() + vclock);
    try {
      await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    } finally {
      Date.now = realNow;
    }
    const probes = mcpOf("get_addon_status").length;
    assert(launchCount === 1, "仍然尝试拉起 Blender");
    assert(probes === 2, `首探失败后又探一次才超时（${probes} 次）`);
    assert(compressedDelays.length === 1 && compressedDelays[0] === 1500, "两次探测之间等 1500ms");
    assert(lastJSON().statusCode === 502, "状态码 502");
    assert(lastJSON().data.savedPath === SAVED_PATH, "502 里带回 savedPath");
    assert(lastJSON().data.modelUrl === EXPECT_MODEL_URL, "502 里带回 modelUrl");
    assert(lastJSON().data.error.includes("Blender MCP addon 未就绪"), "未就绪文案");
    assert(lastJSON().data.error.includes("Connect to MCP server"), "提示用户去 Blender 里连接");
  });
});

describe("handleGenToBlender 导入与回传", async() => {
  await it("导入参数：filepath=落盘路径、name 缺省 <mode>_model", async() => {
    clearState();
    mcpImpl = mcpReady;
    await loop.handleGenToBlender(fakeReq(goodBody({ deploy: "meshy" })), fakeRes());
    const imp = mcpOf("import_glb_from_file");
    assert(imp.length === 1, "导入调一次");
    assert(imp[0].params.filepath === SAVED_PATH, "导入的是刚落盘的文件");
    assert(imp[0].params.name === "meshy_model", `name 缺省（${imp[0].params.name}）`);
    assert(imp[0].timeoutMs === 120_000, "导入超时 120s");
    assert(mcpOf("get_scene_info")[0].timeoutMs === 10_000, "取场景信息超时 10s");
    assert(lastJSON().data.imported.name === "imported_object", "回传 addon 的导入结果");
    assert(lastJSON().data.scene.objects === 3, "回传场景信息");
    assert(typeof lastJSON().data.elapsed === "string", "elapsed 是两位小数字符串");
    assert(/^\d+\.\d{2}$/.test(lastJSON().data.elapsed), `elapsed 形态（${lastJSON().data.elapsed}）`);
  });

  await it("body.name 优先于 <mode>_model", async() => {
    clearState();
    mcpImpl = mcpReady;
    await loop.handleGenToBlender(fakeReq(goodBody({ deploy: "tripo", name: "Custom Name" })), fakeRes());
    assert(mcpOf("import_glb_from_file")[0].params.name === "Custom Name", "使用 body.name");
  });

  await it("addon 回复 falsy / succeed:false → 502", async() => {
    for (const reply of [null, { succeed: false, error: "boom" }]) {
      clearState();
      mcpImpl = async(type) => {
        if (type === "get_addon_status") return { succeed: true };
        if (type === "import_glb_from_file") return reply;
        return {};
      };
      await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
      assert(lastJSON().statusCode === 502, `状态码 502（reply=${JSON.stringify(reply)}）`);
      assert(lastJSON().data.error === (reply && reply.error ? reply.error : "导入 Blender 失败"), "错误文案");
      assert(lastJSON().data.success === false, "success 为 false");
      assert(mcpOf("get_scene_info").length === 0, "导入失败就不取场景信息");
    }
  });

  await it("导入阶段抛错 → 走外层 catch 落 500（区别于显式 502）", async() => {
    clearState();
    mcpImpl = async(type) => {
      if (type === "get_addon_status") return { succeed: true };
      if (type === "import_glb_from_file") throw new Error("socket reset");
      return {};
    };
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    assert(lastJSON().statusCode === 500, "异常无 status 字段 → 500");
    assert(lastJSON().data.error === "socket reset", "错误文案透传");
    assert(mcpOf("get_scene_info").length === 0, "导入抛错就不取场景信息");
  });

  await it("get_scene_info 失败不影响导入成功", async() => {
    clearState();
    mcpImpl = async(type) => {
      if (type === "get_addon_status") return { succeed: true };
      if (type === "import_glb_from_file") return { name: "imported_object" };
      if (type === "get_scene_info") throw new Error("scene 不可用");
      return {};
    };
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    assert(lastJSON().statusCode === 200, "状态码仍为 200");
    assert(lastJSON().data.scene === null, "scene 为 null");
  });

  await it("生成阶段带 status 的异常按该状态码回", async() => {
    clearState();
    genImpl = async() => { const e = new Error("provider 挂了"); e.status = 429; throw e; };
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    assert(lastJSON().statusCode === 429, "使用 err.status");
    assert(lastJSON().data.error === "provider 挂了", "错误文案透传");
    assert(mcpOf("get_addon_status").length === 0, "生成失败就不去探 addon");
    assert(savedModels.length === 0, "生成失败不落盘");
  });

  await it("生成阶段无 status 的异常按 500 回", async() => {
    clearState();
    genImpl = async() => { throw new Error("plain error"); };
    await loop.handleGenToBlender(fakeReq(goodBody()), fakeRes());
    assert(lastJSON().statusCode === 500, "缺省 500");
  });
});

describe("handleBlenderExport 读回", async() => {
  const urlFor = (q = "") => new URL("http://localhost/api/blender/export" + q);

  await it("query name 直接使用，二进制回传后用即删", async() => {
    clearState();
    const { uploadDir, handleBlenderExport } = freshLoop();
    mcpImpl = async(type, params) => {
      if (type === "export_object_glb") { fs.writeFileSync(params.filepath, "GLB-BYTES"); return { succeed: true }; }
      return {};
    };
    const res = fakeRes();
    await handleBlenderExport(fakeReq({}), res, urlFor("?name=Foo%20Bar"));
    const exp = mcpOf("export_object_glb");
    assert(exp.length === 1, "导出调一次");
    assert(exp[0].params.name === "Foo Bar", "name 来自 query（已解码）");
    assert(exp[0].params.filepath.startsWith(uploadDir + path.sep), "落在注入的 UPLOAD_DIR 下");
    assert(/export-\d+\.glb$/.test(path.basename(exp[0].params.filepath)), "文件名 export-<时间戳>.glb");
    assert(exp[0].timeoutMs === 120_000, "导出超时 120s");
    assert(res.rec.statusCode === 200, "状态码 200");
    assert(res.rec.body.toString() === "GLB-BYTES", "二进制回传文件内容");
    assert(res.rec.headers["Content-Type"] === "application/octet-stream", "Content-Type");
    assert(res.rec.headers["Content-Length"] === Buffer.byteLength("GLB-BYTES"), "Content-Length 与正文一致");
    assert(res.rec.headers["X-Object-Name"] === encodeURIComponent("Foo Bar"), "对象名经 URL 编码");
    assert(res.rec.headers["Access-Control-Allow-Origin"] === "*", "带 CORS 头");
    assert(!fs.existsSync(exp[0].params.filepath), "finally 删掉了导出文件");
  });

  await it("无 name 时用最近一次导入的对象（跨 handler 共享）", async() => {
    clearState();
    // 同一个闭包：先走一次生成+导入，再不带 name 读回
    mcpImpl = mcpReady;
    await loop.handleGenToBlender(fakeReq(goodBody({ deploy: "tripo", name: "FromGen" })), fakeRes());
    clearState();
    const { handleBlenderExport } = loop;
    mcpImpl = async(type, params) => {
      if (type === "export_object_glb") { fs.writeFileSync(params.filepath, "GLB2"); return { succeed: true }; }
      return {};
    };
    const res = fakeRes();
    await handleBlenderExport(fakeReq({}), res, urlFor());
    assert(mcpOf("execute_code").length === 0, "不需要 execute_code 探测");
    assert(mcpOf("export_object_glb")[0].params.name === "imported_object", "用的是 addon 回报的对象名");
    assert(res.rec.headers["X-Object-Name"] === encodeURIComponent("imported_object"), "响应头同样编码");
  });

  await it("addon 回报的 name 覆盖 body.name 记入共享状态", async() => {
    clearState();
    const { handleGenToBlender, handleBlenderExport } = freshLoop();
    mcpImpl = async(type, params) => {
      if (type === "get_addon_status") return { succeed: true };
      if (type === "import_glb_from_file") return { name: "AddonNamed" };
      if (type === "export_object_glb") { fs.writeFileSync(params.filepath, "G"); return { succeed: true }; }
      return {};
    };
    await handleGenToBlender(fakeReq(goodBody({ name: "BodyNamed" })), fakeRes());
    clearState();
    await handleBlenderExport(fakeReq({}), fakeRes(), urlFor());
    assert(mcpOf("export_object_glb")[0].params.name === "AddonNamed", "imported.name 覆盖 body.name");
  });

  await it("新闭包没有上一次导入的对象 → 用 execute_code 探测", async() => {
    clearState();
    const { handleBlenderExport } = freshLoop();
    let seenCode = "";
    mcpImpl = async(type, params) => {
      if (type === "execute_code") { seenCode = params.code; return { result: "  Cube\n" }; }
      if (type === "export_object_glb") { fs.writeFileSync(params.filepath, "G"); return { succeed: true }; }
      return {};
    };
    await handleBlenderExport(fakeReq({}), fakeRes(), urlFor());
    assert(mcpOf("execute_code")[0].timeoutMs === 10_000, "探测超时 10s");
    assert(seenCode.includes("bpy.context.active_object"), "探测脚本读 active_object");
    assert(seenCode.includes("bpy.data.objects"), "探测脚本回退到场景网格列表");
    assert(mcpOf("export_object_glb")[0].params.name === "Cube", "探测结果去掉首尾空白后使用");
  });

  await it("探测抛错被吞掉 → 落到 400", async() => {
    clearState();
    const { handleBlenderExport } = freshLoop();
    mcpImpl = async(type) => { if (type === "execute_code") throw new Error("addon 忙"); return {}; };
    await handleBlenderExport(fakeReq({}), fakeRes(), urlFor());
    assert(lastJSON().statusCode === 400, "状态码 400");
    assert(lastJSON().data.error.includes("尚无可导出的网格对象"), "400 文案");
    assert(mcpOf("export_object_glb").length === 0, "没有名字就不导出");
  });

  await it("探测结果为空 → 400，不会用空名字导出", async() => {
    clearState();
    const { handleBlenderExport } = freshLoop();
    mcpImpl = async(type) => {
      if (type === "execute_code") return { result: "   " };
      return {};
    };
    await handleBlenderExport(fakeReq({}), fakeRes(), urlFor());
    assert(lastJSON().statusCode === 400, "状态码 400");
    assert(mcpOf("export_object_glb").length === 0, "未发起导出");
  });

  await it("addon 回复 falsy / succeed:false → 502 透传 error", async() => {
    for (const reply of [null, { succeed: false, error: "export failed" }]) {
      clearState();
      const { handleBlenderExport } = freshLoop();
      mcpImpl = async() => reply;
      await handleBlenderExport(fakeReq({}), fakeRes(), urlFor("?name=A"));
      assert(lastJSON().statusCode === 502, `状态码 502（reply=${JSON.stringify(reply)}）`);
      assert(lastJSON().data.error === (reply && reply.error ? reply.error : "从 Blender 导出失败"), "错误文案");
    }
  });

  await it("导出抛错 → 502 带 err.message", async() => {
    clearState();
    const { handleBlenderExport } = freshLoop();
    mcpImpl = async() => { throw new Error("socket closed"); };
    await handleBlenderExport(fakeReq({}), fakeRes(), urlFor("?name=A"));
    assert(lastJSON().statusCode === 502, "状态码 502");
    assert(lastJSON().data.error === "socket closed", "错误文案");
  });

  await it("addon 说成功但文件不存在 → 502", async() => {
    clearState();
    const { handleBlenderExport } = freshLoop();
    mcpImpl = async() => ({ succeed: true });
    await handleBlenderExport(fakeReq({}), fakeRes(), urlFor("?name=A"));
    assert(lastJSON().statusCode === 502, "状态码 502");
    assert(lastJSON().data.error === "导出文件不存在", "文件缺失文案");
  });
});

// ===== 运行 =====
function cleanup() {
  globalThis.setTimeout = realSetTimeout;
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
