#!/usr/bin/env node
/**
 * 单元测试 — Blender 后台任务运行时（src/blender-runner.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - runBlenderAIPaint：命令行恒为
 *     --factory-startup --background --python <仓库根>/blender_ai_paint.py
 *     -- --prompt <p> --output <o> --manifest <m>，给了图片特征文件时追加
 *     --image-features；超时 120s、maxBuffer 50MB；
 *   - runBlenderSplit：同样四件套换成 --input/--output/--manifest/
 *     --original-filename；超时 600s；
 *     · 无 vlm 时 env 就是 process.env 本身；
 *     · vlm.provider 恒传 --vlm-provider，vlm.model 只在真值时追加；
 *     · vlm.key 通过 env 的 VLM_API_KEY 传递（绝不出现在命令行，避免 ps 泄露），
 *       且不污染 process.env；
 *   - 两个函数共用同一条串行链：任意时刻只有一个 execFile 在飞；先后顺序保持；
 *     前一个任务失败不会把队列卡死（下一个照跑）。
 *
 * 接缝：工厂收 execFile（promisify 后的实现），测试用可操控的假实现断言参数与
 *   串行语义，不必真跑 Blender。
 *
 * 用法：node tests/blender-runner-test.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlenderRunner } from "../src/blender-runner.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
let passed = 0;
let failed = 0;
const failures = [];

// 断言走原始 console：本文件会把被测模块的 console.log 静音，
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
const BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender";
const realSetTimeout = globalThis.setTimeout;

// 每个用例一条新的队列（等价于新起一个 server 进程）
const calls = [];
const pending = [];
function fakeExec(cmd, args, opts) {
  const rec = { cmd, args: args.slice(), opts, settled: false };
  calls.push(rec);
  return new Promise((resolve, reject) => pending.push({
    rec,
    resolve: (v) => { rec.settled = true; resolve(v); },
    reject: (e) => { rec.settled = true; reject(e); },
  }));
}

function build() {
  return createBlenderRunner({ blenderPath: BLENDER_PATH, rootDir: ROOT, execFile: fakeExec });
}

function reset() {
  calls.length = 0;
  pending.length = 0;
}

// 让出事件循环：任务经 chain.then(task, task) 入队，execFile 调用在微任务里
async function tick(times = 3) {
  for (let i = 0; i < times; i++) await new Promise((r) => realSetTimeout(r, 0));
}
async function settleAll() {
  // 先让出一次：任务经 chain.then(task, task) 入队，execFile 只在微任务里被
  // 调用，若不同步先 yield，进入循环时 pending 还是空的，会把整个队列放过。
  await tick();
  while (pending.length) {
    const p = pending.shift();
    p.resolve({ stdout: "done", stderr: "" });
    await tick();
  }
}

const AI_SCRIPT = path.join(ROOT, "blender_ai_paint.py");
const SPLIT_SCRIPT = path.join(ROOT, "blender_split_glb.py");

describe("runBlenderAIPaint", async() => {
  await it("命令行四件套 + 可选 --image-features", async() => {
    reset();
    const { runBlenderAIPaint } = build();
    const p = runBlenderAIPaint("a red car", "/out/m.glb", "/out/mf.json", null);
    await tick();
    assert(calls.length === 1, "调了一次 execFile");
    assert(calls[0].cmd === BLENDER_PATH, "用 BLENDER_PATH（GUI 二进制）");
    assert(
      JSON.stringify(calls[0].args) === JSON.stringify([
        "--factory-startup", "--background", "--python", AI_SCRIPT,
        "--", "--prompt", "a red car", "--output", "/out/m.glb", "--manifest", "/out/mf.json",
      ]),
      `AI 绘画参数（${calls[0].args.join(" ")}）`,
    );
    assert(calls[0].opts.timeout === 120_000, "超时 120s");
    assert(calls[0].opts.maxBuffer === 50 * 1024 * 1024, "maxBuffer 50MB");
    assert(!calls[0].args.includes("--image-features"), "没给特征文件时不带该参数");
    await settleAll();
    await p;
  });

  await it("给了图片特征文件时追加 --image-features", async() => {
    reset();
    const { runBlenderAIPaint } = build();
    const p = runBlenderAIPaint("p", "/o.glb", "/m.json", "/feat.json");
    await tick();
    assert(calls[0].args.slice(-2).join(" ") === "--image-features /feat.json", "追加在末尾");
    assert(calls[0].args[5] === "--prompt", "前半段仍是四件套");
    await settleAll();
    await p;
  });

  await it("把 execFile 的结果原样返回", async() => {
    reset();
    const { runBlenderAIPaint } = build();
    const p = runBlenderAIPaint("p", "o", "m");
    await tick();
    pending.shift().resolve({ stdout: "STDOUT", stderr: "" });
    const r = await p;
    assert(r.stdout === "STDOUT", "返回值透传");
  });
});

describe("runBlenderSplit", async() => {
  await it("基本命令行与 600s 超时", async() => {
    reset();
    const { runBlenderSplit } = build();
    const p = runBlenderSplit("/in.glb", "/out.glb", "/mf.json", "我的模型.glb");
    await tick();
    assert(calls[0].cmd === BLENDER_PATH, "用 BLENDER_PATH");
    assert(
      JSON.stringify(calls[0].args) === JSON.stringify([
        "--factory-startup", "--background", "--python", SPLIT_SCRIPT,
        "--", "--input", "/in.glb", "--output", "/out.glb",
        "--manifest", "/mf.json", "--original-filename", "我的模型.glb",
      ]),
      `拆解参数（${calls[0].args.join(" ")}）`,
    );
    assert(calls[0].opts.timeout === 600_000, "超时 600s");
    assert(calls[0].opts.env === process.env, "无 vlm 时 env 就是 process.env 本身");
    await settleAll();
    await p;
  });

  await it("vlm.provider 恒传，model 只在真值时追加", async() => {
    for (const [vlm, expectModelFlag] of [
      [{ provider: "nvidia" }, false],
      [{ provider: "nvidia", model: "qwen" }, true],
      [{ provider: "nvidia", model: null }, false],
      [{ provider: "nvidia", model: "" }, false],
    ]) {
      reset();
      const { runBlenderSplit } = build();
      const p = runBlenderSplit("/in.glb", "/out.glb", "/mf.json", "f.glb", vlm);
      await tick();
      const args = calls[0].args;
      const at = args.indexOf("--vlm-provider");
      assert(at >= 0 && args[at + 1] === "nvidia", "带 provider");
      assert(args.includes("--vlm-model") === expectModelFlag, `model=${JSON.stringify(vlm.model)} → 追加与否`);
      await settleAll();
      await p;
    }
  });

  await it("API Key 只走 env.VLM_API_KEY，不进命令行，也不污染 process.env", async() => {
    reset();
    const prev = process.env.VLM_API_KEY;
    delete process.env.VLM_API_KEY;
    try {
      const { runBlenderSplit } = build();
      const vlm = { provider: "stepfun", model: "s", key: "sk-secret" };
      const p = runBlenderSplit("/in.glb", "/out.glb", "/mf.json", "f.glb", vlm);
      await tick();
      assert(!calls[0].args.includes("sk-secret"), "命令行不含 key");
      assert(!JSON.stringify(calls[0].args).includes("sk-secret"), "参数序列化后不含 key");
      assert(calls[0].opts.env.VLM_API_KEY === "sk-secret", "env.VLM_API_KEY 带上 key");
      assert(calls[0].opts.env !== process.env, "env 是副本而非本体");
      assert(process.env.VLM_API_KEY === undefined, "process.env 未被改写");
      await settleAll();
      await p;
    } finally {
      if (prev === undefined) delete process.env.VLM_API_KEY;
      else process.env.VLM_API_KEY = prev;
    }
  });

  await it("只给 key 不给 provider 时不加任何 vlm 参数，env 保持本体", async() => {
    reset();
    const { runBlenderSplit } = build();
    const p = runBlenderSplit("/in.glb", "/out.glb", "/mf.json", "f.glb", { key: "sk-x" });
    await tick();
    assert(!calls[0].args.some((a) => a.startsWith("--vlm")), "没有 vlm 参数");
    assert(calls[0].opts.env === process.env, "env 仍是 process.env（key 未使用）");
    await settleAll();
    await p;
  });
});

describe("串行队列", async() => {
  await it("两个任务先后发起：第二个的 execFile 等第一个落定才调用", async() => {
    reset();
    const { runBlenderAIPaint, runBlenderSplit } = build();
    const first = runBlenderAIPaint("p1", "o1", "m1");
    const second = runBlenderSplit("i2", "o2", "m2", "f2");
    await tick();
    assert(calls.length === 1, "只发出了第一个命令");
    assert(calls[0].args.includes("--prompt"), "第一个是 AI 绘画");
    pending.shift().resolve({ stdout: "1", stderr: "" });
    await tick();
    assert(calls.length === 2, "第一个落定后才发第二个");
    assert(calls[1].args.includes("--input"), "第二个是拆解");
    assert(calls[1].cmd === BLENDER_PATH, "第二次仍用同一 blenderPath");
    await settleAll();
    await Promise.all([first, second]);
  });

  await it("三次调用严格保持发起顺序", async() => {
    reset();
    const { runBlenderAIPaint, runBlenderSplit } = build();
    const ps = [
      runBlenderSplit("i1", "o", "m", "f"),
      runBlenderAIPaint("p", "o", "m"),
      runBlenderSplit("i2", "o", "m", "f"),
    ];
    await settleAll();
    await Promise.all(ps);
    assert(calls.length === 3, "三个都跑了");
    assert(calls[0].args[5] === "--input" && calls[0].args[6] === "i1", "第 1 个是第一次拆解");
    assert(calls[1].args.includes("--prompt"), "第 2 个是 AI 绘画");
    assert(calls[2].args[5] === "--input" && calls[2].args[6] === "i2", "第 3 个是第二次拆解");
  });

  await it("前一个任务失败不会卡死队列", async() => {
    reset();
    const { runBlenderAIPaint, runBlenderSplit } = build();
    // 立刻给失败那个任务挂上处理器：reject 之后还隔着宏任务，不挂会被 Node
    // 判成 unhandledRejection 直接把进程带走
    const bad = runBlenderAIPaint("p", "o", "m").then(() => null, (e) => e);
    const good = runBlenderSplit("i", "o", "m", "f");
    await tick();
    assert(calls.length === 1, "先只发出第一个命令");
    pending.shift().reject(new Error("blender 崩了"));
    await tick();
    assert(calls.length === 2, "第二个照样发出");
    await settleAll();
    const err = await bad;
    assert(err instanceof Error && err.message === "blender 崩了", "失败原样冒泡给调用方");
    const r = await good;
    assert(r.stdout === "done", "后续任务正常返回");
  });

  await it("同一实例的两次 build 队列互不影响", async() => {
    reset();
    const a = build();
    const b = build();
    const pa = a.runBlenderAIPaint("pa", "o", "m");
    const pb = b.runBlenderAIPaint("pb", "o", "m");
    await tick();
    assert(calls.length === 2, "两个实例各自独立发令（两条队列）");
    await settleAll();
    await Promise.all([pa, pb]);
  });
});

// ===== 运行 =====
function cleanup() {
  console.log = realLog;
}

(async() => {
  console.log = () => {};   // 只压掉被测模块的命令行日志
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
