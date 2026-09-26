#!/usr/bin/env node
/**
 * 单元测试 — GLTFLoader 惰性加载（src/gltf-loader.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 首次调用才动态 import "three/examples/jsm/loaders/GLTFLoader.js"，
 *     之后复用同一份类引用（缓存语义）；
 *   - 返回值是可构造的 GLTFLoader 类（用于 new LoaderClass().load(...)）；
 *   - 并发调用共享同一次加载结果（同一 provider 实例上 Promise 之后的结果
 *     为同一引用）。
 *
 * 用法：node tests/gltf-loader-test.mjs
 */

import { createGLTFLoaderProvider } from "../src/gltf-loader.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
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
// it 回调可能是 async（含 await 的用例），runner 必须 awaiting 它们，
// 否则摘要会抢在断言前打印（本文件初版就踩过：显示 0 通过）
const itPromises = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
function it(_name, fn) {
  itPromises.push(fn());
}

describe("gltf-loader：惰性加载与缓存", async() => {
  it("首次调用解析出 GLTFLoader 类", async() => {
    const { loadGLTFLoader } = createGLTFLoaderProvider();
    const LoaderClass = await loadGLTFLoader();
    assert(typeof LoaderClass === "function", "返回的是可调用构造器");
    assert(LoaderClass.name === "GLTFLoader", `类名 GLTFLoader（实际 ${LoaderClass.name}）`);
  });

  it("二次调用复用同一引用（缓存生效）", async() => {
    const { loadGLTFLoader } = createGLTFLoaderProvider();
    const first = await loadGLTFLoader();
    const second = await loadGLTFLoader();
    assert(first === second, "两次调用返回同一类引用");
  });

  it("provider 实例之间缓存隔离", async() => {
    const a = createGLTFLoaderProvider();
    const b = createGLTFLoaderProvider();
    const la = await a.loadGLTFLoader();
    const lb = await b.loadGLTFLoader();
    assert(typeof la === "function" && typeof lb === "function", "两个实例各自可加载");
    assert(la === lb, "底层动态 import 的模块相同，类引用一致");
  });

  it("返回的类可构造出 loader 实例", async() => {
    const { loadGLTFLoader } = createGLTFLoaderProvider();
    const LoaderClass = await loadGLTFLoader();
    let threw = null;
    let loader = null;
    try {
      loader = new LoaderClass();
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `构造不抛错${threw ? `（${threw.message}）` : ""}`);
    assert(loader !== null && typeof loader.load === "function", "实例具备 load 方法");
  });

  it("并发调用共享同一结果", async() => {
    const { loadGLTFLoader } = createGLTFLoaderProvider();
    const [a, b] = await Promise.all([loadGLTFLoader(), loadGLTFLoader()]);
    assert(a === b, "并发两次解析到同一引用");
  });
});

// ===== 顺序执行（与仓库既有测试一致）=====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
    await Promise.all(itPromises.splice(0));
  }
  await Promise.all(itPromises.splice(0));
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.error("❌ 存在失败用例:");
    failures.forEach(f => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
