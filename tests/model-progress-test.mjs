#!/usr/bin/env node
/**
 * 单元测试 — 模型加载统一进度（src/model-progress.js）
 *
 * 机制来源：three.js GLTFLoader onProgress + model-viewer progress event。
 * 锁定的不变量：
 *   - computePercent 边界：负值/NaN/Infinity/total<=0 → null（分块回退文案）；
 *   - formatProgressText：MB 级显示 MB 单位、KB 级显示 KB、无 total 显示已接收、
 *     全非法回退 fallback；
 *   - createProgressReporter：节流窗口内只发首帧、同值去重、complete 直通；
 *   - fetchArrayBufferWithProgress：流式读取按 chunk 上报、total 从
 *     Content-Length 解析、无流式 body 时回退 arrayBuffer() 不丢功能。
 */

import {
  computePercent,
  createProgressReporter,
  fetchArrayBufferWithProgress,
  formatProgressText,
} from "../src/model-progress.js";

let passed = 0;
let failed = 0;
const failures = [];
function assert(condition, message) {
  if (condition) { console.log("  ✅ " + message); passed++; }
  else { console.error("  ❌ FAIL " + message); failed++; failures.push(message); }
}
const describeQueue = [];
function describe(name, fn) { describeQueue.push({ name, fn }); }
function it(_name, fn) { return fn(); }

describe("computePercent", () => {
  it("正常百分比与 clamp", () => {
    assert(computePercent(50, 200) === 25, "50/200 = 25%");
    assert(computePercent(200, 200) === 100, "满载 = 100%");
    assert(computePercent(300, 200) === 100, "超载 clamp 到 100");
    assert(computePercent(0, 200) === 0, "0 字节 = 0%");
  });
  it("非法输入返回 null", () => {
    assert(computePercent(-1, 200) === null, "loaded 负值 → null");
    assert(computePercent(NaN, 200) === null, "NaN → null");
    assert(computePercent(Infinity, 200) === null, "Infinity → null");
    assert(computePercent(100, 0) === null, "total=0（分块）→ null");
    assert(computePercent(100, -1) === null, "total 负值 → null");
    assert(computePercent(100, NaN) === null, "total NaN → null");
  });
});

describe("formatProgressText", () => {
  it("MB 级显示 MB 单位", () => {
    const t = formatProgressText({ loaded: 1048576, total: 2097152 });
    assert(t === "50%（1.0 / 2.0 MB）", `MB 文案（实得 ${t}）`);
  });
  it("KB 级显示 KB 单位", () => {
    const t = formatProgressText({ loaded: 512, total: 2048 });
    assert(t === "25%（1 / 2 KB）", `KB 文案（实得 ${t}）`);
  });
  it("无 total 显示已接收 MB", () => {
    const t = formatProgressText({ loaded: 1572864, total: null });
    assert(t === "已接收 1.5 MB", `分块回退文案（实得 ${t}）`);
  });
  it("全非法回退 fallback", () => {
    assert(formatProgressText({ loaded: NaN, total: 0, fallback: "等待中" }) === "等待中", "回退文案");
    assert(formatProgressText({ loaded: NaN, total: 0 }) === "", "默认空串");
  });
});

describe("createProgressReporter", () => {
  it("节流窗口内只发第一次，窗口后恢复", () => {
    const events = [];
    const r = createProgressReporter(p => events.push(p), { minIntervalMs: 100000 });
    r.report({ loaded: 10, total: 100 });
    r.report({ loaded: 20, total: 100 });
    r.report({ loaded: 30, total: 100 });
    assert(events.length === 1, `节流后只发 1 次（实得 ${events.length}）`);
    assert(events[0].loaded === 10, "首帧立即发");
  });

  it("相同值去重", () => {
    const events = [];
    const r = createProgressReporter(p => events.push(p), { minIntervalMs: 0 });
    r.report({ loaded: 10, total: 100 });
    r.report({ loaded: 10, total: 100 });
    assert(events.length === 1, "同值只发一次");
    r.report({ loaded: 20, total: 100 });
    assert(events.length === 2, "值变化后恢复发送");
  });

  it("complete 直通并重置状态", () => {
    const events = [];
    const r = createProgressReporter(p => events.push(p), { minIntervalMs: 100000 });
    r.report({ loaded: 50, total: 100 });
    r.complete();
    assert(events.length === 2, "complete 不受节流限制");
    assert(events[1].done === true, "complete 事件带 done");
    r.report({ loaded: 60, total: 100 });
    assert(events.length === 3, "complete 后 reporter 可复用");
  });

  it("onProgress 非函数时安全跳过", () => {
    const r = createProgressReporter(null);
    r.report({ loaded: 1, total: 2 });
    r.complete();
    assert(true, "不抛错");
  });
});

describe("fetchArrayBufferWithProgress", () => {
  it("流式读取：按 chunk 上报、total 来自 Content-Length、字节完整拼回", async() => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const fakeFetch = async() => ({
      ok: true,
      headers: { get: name => (name === "Content-Length" ? "5" : null) },
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async() => {
              if (i === 0) { i++; return { done: false, value: chunk1 }; }
              if (i === 1) { i++; return { done: false, value: chunk2 }; }
              return { done: true };
            },
          };
        },
      },
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const events = [];
      const buf = await fetchArrayBufferWithProgress("http://x/y.glb", {
        onProgress: p => events.push({ ...p }),
      });
      assert(buf instanceof ArrayBuffer && buf.byteLength === 5, "buffer 5 字节");
      assert(new Uint8Array(buf).join(",") === "1,2,3,4,5", "chunk 拼接顺序正确");
      assert(events.length === 2, "两个 chunk 两次回调");
      assert(events[0].loaded === 3 && events[0].total === 5, "首 chunk 进度");
      assert(events[1].loaded === 5 && events[1].total === 5, "末 chunk 进度");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("无流式 body：回退 arrayBuffer 且发一次满载进度", async() => {
    const fakeFetch = async() => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async() => new Uint8Array([9, 8, 7]).buffer,
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const events = [];
      const buf = await fetchArrayBufferWithProgress("http://x", { onProgress: p => events.push(p) });
      assert(buf.byteLength === 3, "buffer 3 字节");
      assert(events.length === 1 && events[0].loaded === 3, "回退路径发一次满载进度");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("resp.ok 为假时抛状态码错误", async() => {
    const fakeFetch = async() => ({ ok: false, status: 404 });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      let err = null;
      await fetchArrayBufferWithProgress("http://x").catch(e => { err = e; });
      assert(err?.message === "加载失败 404", "状态码错误透传");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

(async() => {
  for (const item of describeQueue) {
    console.log("\n──── " + item.name);
    await item.fn();
  }
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();

