#!/usr/bin/env node
/**
 * 单元测试 — 图片转3D 统一调度器（src/image-to-3d-router.js）
 *
 * 用假 deps（假 fs / execFile / spawn）驱动完整调度逻辑：不发真实网络请求、
 * 不起真实 Blender / VLM 进程。覆盖：
 *   - local 成功路径与「Blender 非零退出但产物已写出」的历史容错行为
 *   - 本地失败 → 有 Replicate Token 才回退云端；无 Token 原错误上抛
 *   - 回退时不把 body.model（本地生成方式）当作 Replicate 模型名
 *   - body.real + TripoSR 就绪时走 venv 真重建
 *   - meshy / tripo / hyper3d / 未知 deploy 的分派
 *   - VLM：唯一临时路径 + --code-out + 退出码非零仍清理
 *   - 临时文件生命周期（成功与失败都清理 img/glb/manifest）
 *
 * 用法：node tests/image-to-3d-router-test.mjs
 */

import path from "path";
import os from "os";
import { generateImageTo3D, readLocalJobResult, IMAGE_TO_3D_TIMEOUTS } from "../src/image-to-3d-router.js";

// ===== 测试框架（与 unit-test.mjs / provider-test.mjs 一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
    failures.push(message);
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${message}: ${actual}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
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

// ===== 假进程世界 =====
const GLB_BYTES = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
const BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender";
const TRIPOSR_DIR = "/repo/external/TripoSR";
const VENV_PYTHON = path.join(TRIPOSR_DIR, ".venv", "bin", "python3");
const INFER_SCRIPT = "/repo/scripts/triposr_infer.py";
const RELIEF_SCRIPT = "/repo/blender_image_to_3d.py";
const VLM_SCRIPT = "/repo/scripts/vlm_img_to_blender.py";

function writeOutputs(args, files) {
  const outIdx = args.indexOf("--output");
  const manIdx = args.indexOf("--manifest");
  if (outIdx >= 0) files.set(args[outIdx + 1], GLB_BYTES);
  if (manIdx >= 0) {
    files.set(args[manIdx + 1], Buffer.from(JSON.stringify({ total_parts: 9, parts: [] }), "utf-8"));
  }
}

function makeDeps(overrides = {}) {
  const files = new Map();
  const removed = [];
  const execCalls = [];
  const spawnCalls = [];

  const fsStub = {
    existsSync: p => files.has(p) || (overrides.exists || []).includes(p),
    promises: {
      writeFile: async(p, data) => {
        files.set(p, data);
      },
      readFile: async p => {
        if (!files.has(p)) throw new Error("ENOENT: " + p);
        return files.get(p);
      },
      unlink: async p => {
        removed.push(p);
        files.delete(p);
      },
    },
    readFileSync: p => files.get(p),
    writeFileSync: (p, d) => files.set(p, d),
    rmSync: p => {
      removed.push(p);
      files.delete(p);
    },
  };

  const deps = {
    fs: fsStub,
    path,
    os,
    spawn: (...args) => {
      spawnCalls.push(args);
      return makeFakeChild(overrides.childExitCode ?? 0);
    },
    execFile: async(cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      if (overrides.execFileImpl) return overrides.execFileImpl(cmd, args, files);
      if (overrides.execFileError) throw overrides.execFileError;
      writeOutputs(args, files);
      return { stdout: "OK", stderr: "" };
    },
    blenderPath: overrides.blenderPath === undefined ? BLENDER_PATH : overrides.blenderPath,
    uploadDir: "/tmp/fake-uploads",
    rootDir: "/repo",
  };
  return { deps, files, removed, execCalls, spawnCalls };
}

function makeFakeChild(exitCode) {
  const handlers = {};
  const child = {
    stdout: { on: (ev, fn) => void (handlers["out:" + ev] ||= []).push(fn) },
    stderr: { on: (ev, fn) => void (handlers["err:" + ev] ||= []).push(fn) },
    on: (ev, fn) => void (handlers[ev] ||= []).push(fn),
    kill: () => {},
  };
  setTimeout(() => (handlers.close || []).forEach(fn => fn(exitCode)));
  return child;
}

// ===== fetch mock（云端路线）=====
const originalFetch = globalThis.fetch;

function fakeResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async() => obj,
    text: async() => "",
  };
}
let fetchUrls = [];

function replicateResponder(url) {
  if (url === "https://api.replicate.com/v1/files") {
    return fakeResponse(201, { urls: { get: "https://replicate/files/abc" } });
  }
  if (url.startsWith("https://api.replicate.com/v1/models/")) {
    return { ok: true, status: 200, json: async() => ({ latest_version: { id: "ver-1" } }), text: async() => "" };
  }
  if (url === "https://api.replicate.com/v1/predictions") {
    return fakeResponse(201, {
      id: "pred-1",
      status: "succeeded",
      output: "https://cdn/glb.replicate",
    });
  }
  if (url.startsWith("https://cdn/")) {
    return { ok: true, status: 200, arrayBuffer: async() => new Uint8Array(GLB_BYTES).buffer, json: async() => ({}) };
  }
  return { ok: false, status: 500, json: async() => ({}), text: async() => "unexpected url: " + url };
}

function installFetch(responder) {
  fetchUrls = [];
  globalThis.fetch = async(url, opts) => {
    fetchUrls.push(String(url));
    return responder(String(url), opts || {});
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function cloudResponder(url) {
  if (url === "https://api.meshy.ai/openapi/v1/image-to-3d") {
    return { ok: true, status: 200, json: async() => ({ result: "task-1" }), text: async() => "" };
  }
  if (url === "https://api.meshy.ai/openapi/v1/image-to-3d/task-1") {
    return fakeResponse(200, {
      status: "SUCCEEDED",
      model_urls: { glb: "https://cdn/glb.meshy" },
    });
  }
  if (url === "https://openapi.tripo3d.ai/v3/files") {
    return { ok: true, status: 200, json: async() => ({ data: { file_token: "ft-1" } }), text: async() => "" };
  }
  if (url === "https://openapi.tripo3d.ai/v3/generation/image-to-model") {
    return { ok: true, status: 200, json: async() => ({ data: { task_id: "tid-1" } }), text: async() => "" };
  }
  if (url === "https://openapi.tripo3d.ai/v3/tasks/tid-1") {
    return fakeResponse(200, {
      data: { status: "success", output: { model_url: "https://cdn/glb.tripo" } },
    });
  }
  if (url === "https://hyperhuman.deemos.com/api/v2/rodin") {
    return { ok: true, status: 200, json: async() => ({ uuid: "u-1", subscription_key: "sk-1" }), text: async() => "" };
  }
  if (url === "https://hyperhuman.deemos.com/api/v2/status") {
    return { ok: true, status: 200, json: async() => ({ jobs: [{ status: "Done" }] }), text: async() => "" };
  }
  if (url === "https://hyperhuman.deemos.com/api/v2/download") {
    return fakeResponse(200, {
      list: [{ name: "model.glb", url: "https://cdn/glb.h3d" }],
    });
  }
  if (url.startsWith("https://cdn/")) {
    return { ok: true, status: 200, arrayBuffer: async() => new Uint8Array(GLB_BYTES).buffer, json: async() => ({}) };
  }
  return { ok: false, status: 500, json: async() => ({}), text: async() => "unexpected url: " + url };
}

const SAMPLE_B64 = Buffer.from("fake-image-bytes").toString("base64");
const LOCAL_CONFIG = { replicate: {} };
const WITH_TOKEN = { replicate: { token: "r8-test" } };

// ===== 用例 =====

describe("本地路线（零依赖 Blender 可拆解重建）", async() => {
  await it("默认走 blender_image_to_3d.py 并返回 { glbBuffer, manifest }", async() => {
    const { deps, execCalls, removed } = makeDeps({ exists: [RELIEF_SCRIPT] });
    const out = await generateImageTo3D({
      mode: "local", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: LOCAL_CONFIG, deps,
    });
    assert(Buffer.isBuffer(out.glbBuffer), "返回 glbBuffer");
    assertEqual(out.manifest.total_parts, 9, "manifest 从 --manifest 文件读入");
    assertEqual(execCalls.length, 1, "只起一次进程");
    assertEqual(execCalls[0].cmd, BLENDER_PATH, "用注入的 Blender 路径");
    assertEqual(execCalls[0].args[0], "--background", "Blender 后台模式");
    assertEqual(execCalls[0].args[2], RELIEF_SCRIPT, "跑 blender_image_to_3d.py");
    assertEqual(execCalls[0].opts.timeout, IMAGE_TO_3D_TIMEOUTS.blenderRelief, "超时用集中常量");
    assert(execCalls[0].args.includes("--mode"), "透传 --mode");
    assertEqual(removed.length, 3, "成功路径清理 img/glb/manifest 三个临时文件");
  });

  await it("depth 模式追加 --thickness", async() => {
    const { deps, execCalls } = makeDeps({ exists: [RELIEF_SCRIPT] });
    await generateImageTo3D({
      mode: "local",
      body: { mode: "depth", thickness: 0.12 },
      imageBase64: SAMPLE_B64,
      mime: "image/png",
      config: LOCAL_CONFIG,
      deps,
    });
    const args = execCalls[0].args;
    const i = args.indexOf("--thickness");
    assert(i >= 0 && args[i + 1] === "0.12", "--thickness 0.12 被透传");
  });

  await it("Blender 非零退出但 GLB 已写出时仍算成功（历史容错行为）", async() => {
    const err = new Error("Command failed");
    err.stderr = "addon unload warning";
    const { deps } = makeDeps({
      exists: [RELIEF_SCRIPT],
      execFileImpl: (cmd, args, files) => {
        writeOutputs(args, files); // 先写产物，再以非零码退出
        throw err;
      },
    });
    const out = await generateImageTo3D({
      mode: "local", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: LOCAL_CONFIG, deps,
    });
    assert(Buffer.isBuffer(out.glbBuffer), "非零退出码不掩盖已产出的 GLB");
  });

  await it("未找到 Blender 可执行文件时直接报错", async() => {
    const { deps, execCalls } = makeDeps({ blenderPath: "" });
    let message = "";
    try {
      await generateImageTo3D({
        mode: "local", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: LOCAL_CONFIG, deps,
      });
    } catch (e) {
      message = e.message;
    }
    assert(message.includes("未找到 Blender 可执行文件"), "错误信息指明缺 Blender");
    assertEqual(execCalls.length, 0, "不起进程");
  });

  await it("不支持的本地 mode 在调用 Blender 前就被拒绝", async() => {
    const { deps, execCalls } = makeDeps({ exists: [RELIEF_SCRIPT] });
    let message = "";
    try {
      await generateImageTo3D({
        mode: "local", body: { mode: "wisdrl" }, imageBase64: SAMPLE_B64, mime: "image/png", config: LOCAL_CONFIG, deps,
      });
    } catch (e) {
      message = e.message;
    }
    assert(message.includes("不支持的本地重建 mode"), "白名单校验生效");
    assertEqual(execCalls.length, 0, "不起进程");
  });

  await it("body.real 且 TripoSR 就绪时走 venv 真重建", async() => {
    const { deps, execCalls, removed } = makeDeps({ exists: [VENV_PYTHON, INFER_SCRIPT] });
    const out = await generateImageTo3D({
      mode: "local",
      body: { real: true, mcResolution: 128 },
      imageBase64: SAMPLE_B64,
      mime: "image/png",
      config: LOCAL_CONFIG,
      deps,
    });
    assertEqual(execCalls[0].cmd, VENV_PYTHON, "用 TripoSR venv 的 python");
    assertEqual(execCalls[0].args[0], INFER_SCRIPT, "跑 triposr_infer.py");
    assert(execCalls[0].args.includes("--mc-resolution") && execCalls[0].args.includes("128"), "透传 mc-resolution");
    assertEqual(out.manifest.total_parts, 9, "读 manifest");
    assertEqual(removed.length, 3, "清理三个临时文件");
  });
});

describe("本地失败 → Replicate 回退", async() => {
  await it("配置了 Token 才回退，且原错误信息先打警告", async() => {
    installFetch(replicateResponder);
    try {
      const { deps, execCalls } = makeDeps({
        exists: [RELIEF_SCRIPT],
        execFileError: Object.assign(new Error("boom"), { stderr: "boom: blender 挂了" }),
      });
      const out = await generateImageTo3D({
        mode: "local", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: WITH_TOKEN, deps,
      });
      assert(Buffer.isBuffer(out.glbBuffer), "回退云端后拿到 GLB");
      assertEqual(execCalls.length, 1, "只试过一次本地");
      assert(fetchUrls.some(u => u.endsWith("/v1/files")), "回退走到 Replicate 上传");
    } finally {
      restoreFetch();
    }
  });

  await it("没有 Token 时原错误上抛（不静默回退）", async() => {
    const { deps } = makeDeps({
      exists: [RELIEF_SCRIPT],
      execFileError: Object.assign(new Error("boom"), { stderr: "boom: blender 挂了" }),
    });
    let message = "";
    try {
      await generateImageTo3D({
        mode: "local", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: LOCAL_CONFIG, deps,
      });
    } catch (e) {
      message = e.message;
    }
    assert(message.includes("boom"), "原始错误向上传播");
  });

  await it("回退时不把 body.model（本地生成方式）当作 Replicate 模型名", async() => {
    installFetch(replicateResponder);
    try {
      const { deps } = makeDeps({ execFileError: new Error("boom") });
      await generateImageTo3D({
        mode: "local", body: { model: "depth" }, imageBase64: SAMPLE_B64, mime: "image/png", config: WITH_TOKEN, deps,
      });
      const modelUrl = fetchUrls.find(u => u.includes("/v1/models/"));
      assertEqual(modelUrl, "https://api.replicate.com/v1/models/tencent/hunyuan3d-2", "用默认 owner/name");
    } finally {
      restoreFetch();
    }
  });

  await it("显式 replicate 时才使用 body.model", async() => {
    installFetch(replicateResponder);
    try {
      const { deps } = makeDeps();
      await generateImageTo3D({
        mode: "replicate",
        body: { model: "custom/owner-model" },
        imageBase64: SAMPLE_B64,
        mime: "image/png",
        config: WITH_TOKEN,
        deps,
      });
      const modelUrl = fetchUrls.find(u => u.includes("/v1/models/"));
      assertEqual(modelUrl, "https://api.replicate.com/v1/models/custom/owner-model", "尊重 body.model");
    } finally {
      restoreFetch();
    }
  });

  await it("未配置 Token 的云端请求返回 status=400", async() => {
    const { deps } = makeDeps();
    let err = null;
    try {
      await generateImageTo3D({
        mode: "replicate", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: LOCAL_CONFIG, deps,
      });
    } catch (e) {
      err = e;
    }
    assert(err !== null && err.status === 400, "错误带 status=400");
    assert(err.message.includes("未配置 Replicate Token"), "错误信息可操作");
  });

  await it("未知 deploy 值按 Replicate 云端处理（历史兜底）", async() => {
    installFetch(replicateResponder);
    try {
      const { deps } = makeDeps();
      const out = await generateImageTo3D({
        mode: "some-future-provider", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: WITH_TOKEN, deps,
      });
      assert(Buffer.isBuffer(out.glbBuffer) && fetchUrls.some(u => u.endsWith("/v1/files")), "未知值仍走云端");
    } finally {
      restoreFetch();
    }
  });
});

describe("云端提供商分派", async() => {
  for (const [mode, url] of [
    ["meshy", "https://api.meshy.ai/openapi/v1/image-to-3d"],
    ["tripo", "https://openapi.tripo3d.ai/v3/files"],
    ["hyper3d", "https://hyperhuman.deemos.com/api/v2/rodin"],
  ]) {
    await it(`${mode} 命中对应 provider`, async() => {
      installFetch(cloudResponder);
      try {
        const { deps } = makeDeps();
        const out = await generateImageTo3D({
          mode,
          body: {},
          imageBase64: SAMPLE_B64,
          mime: "image/png",
          config: { providers: { meshy: { apiKey: "k" }, tripo: { apiKey: "k" }, hyper3d: { apiKey: "k" } } },
          deps,
        });
        assert(Buffer.isBuffer(out.glbBuffer), `${mode} 返回 GLB`);
        assert(fetchUrls.some(u => u === url), `命中 ${url}`);
      } finally {
        restoreFetch();
      }
    });
  }
});

describe("VLM 路线", async() => {
  await it("唯一临时路径 + --code-out，成功后清理三个文件", async() => {
    const { deps, spawnCalls, removed } = makeDeps();
    // 产物由 python 脚本写出：路径带随机 jobId，就在 spawn 那一刻按 --out 落盘
    const realSpawn = deps.spawn;
    deps.spawn = (...args) => {
      const outIdx = args[1].indexOf("--out");
      deps.fs.writeFileSync(args[1][outIdx + 1], GLB_BYTES);
      return realSpawn(...args);
    };

    const out = await generateImageTo3D({
      mode: "vlm", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: { vlm: { provider: "stepfun" } }, deps,
    });
    assert(Buffer.isBuffer(out.glbBuffer), "返回 GLB");
    assertEqual(spawnCalls.length, 1, "起一次 python 进程");
    const [, spawnArgs, spawnOpts] = spawnCalls[0];
    assertEqual(spawnArgs[0], VLM_SCRIPT, "跑 vlm_img_to_blender.py");
    assertEqual(spawnArgs[1], "--provider", "透传 provider");
    assert(spawnArgs.includes("--code-out"), "传 --code-out（唯一路径）");
    assertEqual(spawnOpts.cwd, "/repo", "cwd 为仓库根");
    assertEqual(removed.length, 3, "img/glb/code 三个临时文件都被清理");
  });

  await it("退出码非零时报错且仍执行清理", async() => {
    const { deps, spawnCalls, removed } = makeDeps({ childExitCode: 2 });
    let message = "";
    try {
      await generateImageTo3D({
        mode: "vlm", body: {}, imageBase64: SAMPLE_B64, mime: "image/png", config: { vlm: {} }, deps,
      });
    } catch (e) {
      message = e.message;
    }
    assert(message.includes("VLM 脚本退出 2"), "退出码进入错误信息");
    assertEqual(spawnCalls.length, 1, "起了进程");
    assertEqual(removed.length, 3, "失败也清理三个临时文件");
  });
});

describe("readLocalJobResult — 本地产物回读（TripoSR / Blender 两条本地路线共用）", async() => {
  const JOB = {
    image: "/tmp/fake-uploads/img3d-x.png",
    output: "/tmp/fake-uploads/img3d-x.glb",
    manifest: "/tmp/fake-uploads/img3d-x.json",
  };

  await it("GLB 原样返回，不做任何缓冲复制", async() => {
    const { deps, removed } = makeDeps();
    deps.fs.writeFileSync(JOB.output, GLB_BYTES);
    const out = await readLocalJobResult(deps, JOB);
    assert(out.glbBuffer === GLB_BYTES, "同一个 Buffer 实例原样返回");
    assertEqual(removed.length, 3, "三个临时文件都被清理");
  });

  await it("manifest 合法时按 UTF-8 JSON 解析（含中文）", async() => {
    const { deps } = makeDeps();
    deps.fs.writeFileSync(JOB.output, GLB_BYTES);
    deps.fs.writeFileSync(JOB.manifest, JSON.stringify({ total_parts: 7, parts: [{ 名称: "机壳" }] }));
    // 夹具的假 fs 不区分编码，所以额外记录 readFile 实际收到的编码参数：
    // 少了这一条，把 "utf-8" 改成 "base64" 的变异在夹具里完全观测不到。
    const encodings = [];
    const realRead = deps.fs.promises.readFile;
    deps.fs.promises.readFile = async(p, enc) => {
      encodings.push([p, enc]);
      return realRead(p, enc);
    };
    const { manifest } = await readLocalJobResult(deps, JOB);
    assertEqual(manifest.total_parts, 7, "total_parts 解析出来");
    assertEqual(manifest.parts[0].名称, "机壳", "中文键名按 UTF-8 正确解出");
    assertEqual(encodings[1][1], "utf-8", "manifest 必须以 utf-8 读取（否则中文会乱码）");
    assertEqual(encodings[0][1], undefined, "GLB 走二进制读取，不传编码");
  });

  await it("manifest 不存在时回落默认值", async() => {
    const { deps } = makeDeps();
    deps.fs.writeFileSync(JOB.output, GLB_BYTES);
    const { manifest } = await readLocalJobResult(deps, JOB);
    assertEqual(manifest.total_parts, 0, "total_parts 回落 0");
    assertEqual(manifest.parts.length, 0, "parts 回落空数组");
  });

  await it("manifest 内容非法 JSON 时回落默认值而不抛", async() => {
    const { deps, removed } = makeDeps();
    deps.fs.writeFileSync(JOB.output, GLB_BYTES);
    deps.fs.writeFileSync(JOB.manifest, "{ 这不是 JSON");
    const { manifest } = await readLocalJobResult(deps, JOB);
    assertEqual(manifest.total_parts, 0, "非法 JSON 不炸，回落默认值");
    assertEqual(removed.length, 3, "manifest 坏了也照样清理");
  });

  await it("manifest 是空文件时同样回落默认值", async() => {
    const { deps } = makeDeps();
    deps.fs.writeFileSync(JOB.output, GLB_BYTES);
    deps.fs.writeFileSync(JOB.manifest, "");
    const { manifest } = await readLocalJobResult(deps, JOB);
    assertEqual(manifest.total_parts, 0, "空 manifest 回落 0");
  });

  await it("GLB 不存在时错误上抛（调用方已用 existsSync 预检，此路径实际不可达）", async() => {
    const { deps } = makeDeps();
    let threw = null;
    try {
      await readLocalJobResult(deps, JOB);
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, "GLB 缺失时抛错");
    assert(String(threw.message).includes("ENOENT"), `错误带上路径: ${threw && threw.message}`);
  });

  await it("manifest 解出来是个标量时原样透传（不做形状校验）", async() => {
    const { deps } = makeDeps();
    deps.fs.writeFileSync(JOB.output, GLB_BYTES);
    deps.fs.writeFileSync(JOB.manifest, "\"just-a-string\"");
    const { manifest } = await readLocalJobResult(deps, JOB);
    assertEqual(manifest, "just-a-string", "JSON 合法但不是对象时也照原样返回");
  });
});


// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
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
