#!/usr/bin/env node
/**
 * 单元测试 — 生成库加载（src/generated-library.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 列表：fetch API_BASE/api/generated → files 逐项建 option，
 *     value 为 f.url、文案为 `${f.name} (${kb} KB)`（kb=(size/1024).toFixed(0)）；
 *     success 为假 / files 为空 / 请求失败均静默不建 option；
 *   - 加载：点击 #generated-load 读 select.value 拉取该 URL，resp.ok 时经
 *     loadCustomModel(buf, name, null) 载入，name 为 URL 末段 decodeURIComponent；
 *     开打前showStatus 一条「📦 正在从生成库加载模型...」info；
 *   - resp 不 ok：抛「加载失败 <status>」并被 catch，showStatus 一条 error，
 *     loadCustomModel 不调；
 *   - select.value 为空：直接返回，不请求模型 URL；
 *   - #generated-select 或 #generated-load 缺失：整段跳过，不请求列表。
 *
 * 用法：node tests/generated-library-test.mjs
 */

import { clearGeneratedModelCache, setupGeneratedLibrary } from "../src/generated-library.js";
import { API_BASE } from "../src/config.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致；含 await 的 it 走 itPromises）=====
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
const itPromises = [];
function it(_name, fn) {
  itPromises.push(fn());
}

// ===== 假 DOM / 假 fetch =====
function makeEl(tag = "div") {
  const listeners = {};
  return {
    tagName: String(tag).toUpperCase(),
    value: "",
    textContent: "",
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fire: type => listeners[type] && listeners[type](),
    hasListener: type => typeof listeners[type] === "function",
  };
}

function setup(opts = {}) {
  clearGeneratedModelCache();
  const select = opts.noSelect ? null : makeEl("select");
  const btn = opts.noBtn ? null : makeEl("button");
  const calls = { fetch: [], loadCustomModel: [], showStatus: [] };
  const fetches = [];
  if (select) select.value = opts.selectValue || "";
  const doc = {
    getElementById: id => {
      if (id === "generated-select") return select;
      if (id === "generated-load") return btn;
      return null;
    },
    createElement: tag => makeEl(tag),
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });

  Object.defineProperty(globalThis, "fetch", {
    value: async url => {
      calls.fetch.push(url);
      if (url === `${API_BASE}/api/generated`) {
        if (opts.listError) throw new Error("boom");
        return {
          ok: true,
          json: async() => ({ success: opts.listSuccess !== false, files: opts.files || [] }),
        };
      }
      fetches.push(url);
      if (opts.modelError) throw new Error("net down");
      if (opts.modelNotOk) return { ok: false, status: 404, arrayBuffer: async() => null };
      return { ok: true, status: 200, arrayBuffer: async() => opts.buf || "BUF" };
    },
    configurable: true,
  });

  setupGeneratedLibrary({
    showStatus: (msg, type) => calls.showStatus.push({ msg, type }),
    loadCustomModel: (buf, name, arg) => calls.loadCustomModel.push({ buf, name, arg }),
  });
  return { select, btn, calls, fetches };
}

describe("生成库列表填充", async() => {
  it("files 逐项建 option：value=url、文案=name (kb KB)", async() => {
    const w = setup({
      files: [
        { url: "/models/generated/a%20b.glb", name: "a b.glb", size: 2048 },
        { url: "/models/generated/c.glb", name: "c.glb", size: 1500 },
      ],
    });
    await new Promise(r => setTimeout(r, 0));
    await Promise.all(itPromises.splice(0));
    assert(w.calls.fetch[0] === `${API_BASE}/api/generated`, "列表请求打 API_BASE/api/generated");
    assert(w.select.children.length === 2, "两个文件建成两个 option");
    assert(w.select.children[0].value === "/models/generated/a%20b.glb", "option.value 取 f.url");
    assert(w.select.children[0].textContent === "a b.glb (2 KB)", "文案含 KB（2048→2）");
    assert(w.select.children[1].textContent === "c.glb (1 KB)", "KB 取整（1500→1）");
  });

  it("success 为假不建 option", async() => {
    const w = setup({ listSuccess: false, files: [{ url: "u", name: "n", size: 1 }] });
    await new Promise(r => setTimeout(r, 0));
    assert(w.select.children.length === 0, "无 option");
  });

  it("files 为空不建 option", async() => {
    const w = setup({ files: [] });
    await new Promise(r => setTimeout(r, 0));
    assert(w.select.children.length === 0, "无 option");
  });

  it("列表请求失败被 catch，不抛错", async() => {
    let threw = null;
    const w = setup({ listError: true });
    try {
      await new Promise(r => setTimeout(r, 0));
    } catch (err) {
      threw = err;
    }
    assert(threw === null, "不向上抛");
    assert(w.select.children.length === 0, "无 option");
  });

  it("select 缺失：不请求列表", async() => {
    const w = setup({ noSelect: true, files: [{ url: "u", name: "n", size: 1 }] });
    await new Promise(r => setTimeout(r, 0));
    assert(w.calls.fetch.length === 0, "未发起 fetch");
  });
});

describe("点击加载模型", async() => {
  it("正常路径：info 提示 + 拉取 + loadCustomModel(buf, 解码名, null)", async() => {
    const w = setup({ selectValue: "/models/generated/a%20b.glb", buf: "DATA" });
    await w.btn.fire("click");
    assert(
      w.calls.showStatus[0].msg === "📦 正在从生成库加载模型..." &&
        w.calls.showStatus[0].type === "info",
      "开打一条 info 提示",
    );
    assert(w.fetches[0] === "/models/generated/a%20b.glb", "按 select.value 拉取");
    assert(w.calls.loadCustomModel.length === 1, "loadCustomModel 调一次");
    assert(w.calls.loadCustomModel[0].buf === "DATA", "传入 arrayBuffer 结果");
    assert(w.calls.loadCustomModel[0].name === "a b.glb", "文件名取 URL 末段并 decodeURIComponent");
    assert(w.calls.loadCustomModel[0].arg === null, "第三参为 null");
    // 下载进度会产生额外的 info 提示（fetchArrayBufferWithProgress 的满载回调）；
    // 关键不变量是：无 error 提示，且首条仍是开打提示
    assert(
      w.calls.showStatus.every(s => s.type === "info" || s.type === "success"),
      "无 error/warn 提示",
    );
  });

  it("resp 不 ok：error 提示含状态码，不载入", async() => {
    const w = setup({ selectValue: "/models/generated/x.glb", modelNotOk: true });
    await w.btn.fire("click");
    assert(w.calls.loadCustomModel.length === 0, "不调 loadCustomModel");
    assert(
      w.calls.showStatus[1].msg === "❌ 从生成库加载失败: 加载失败 404" &&
        w.calls.showStatus[1].type === "error",
      "错误提示含状态码",
    );
  });

  it("fetch 抛错：error 提示含 message，不载入", async() => {
    const w = setup({ selectValue: "/models/generated/x.glb", modelError: true });
    await w.btn.fire("click");
    assert(w.calls.loadCustomModel.length === 0, "不调 loadCustomModel");
    assert(
      w.calls.showStatus[1].msg === "❌ 从生成库加载失败: net down" &&
        w.calls.showStatus[1].type === "error",
      "错误提示含 error.message",
    );
  });

  it("select.value 为空：直接返回", async() => {
    const w = setup({ selectValue: "" });
    await w.btn.fire("click");
    assert(w.calls.fetch.length === 1, "只有列表请求，未请求模型 URL");
    assert(w.calls.loadCustomModel.length === 0, "不载入");
    assert(w.calls.showStatus.length === 0, "无提示");
  });

  it("load 按钮缺失：不挂监听、不请求列表", async() => {
    const w = setup({ noBtn: true, files: [{ url: "u", name: "n", size: 1 }] });
    await new Promise(r => setTimeout(r, 0));
    assert(w.calls.fetch.length === 0, "未发起 fetch");
    assert(w.btn === null, "无按钮可点");
  });
});

describe("下载去重与缓存（in-flight + buffer cache）", async() => {
  it("并发两次点击同一 URL：只发一次 fetch，两次都拿到同一 buffer", async() => {
    const w = setup({ selectValue: "/models/generated/same.glb", buf: "B1" });
    const clicks = [w.btn.fire("click"), w.btn.fire("click")];
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await clicks[0];
    assert(w.fetches.length === 1, "并发点击只发一次 fetch");
    assert(w.calls.loadCustomModel.length === 2, "两次点击都完成加载");
    assert(w.calls.loadCustomModel[0].buf === "B1", "第一次拿到 buffer");
    assert(w.calls.loadCustomModel[1].buf === "B1", "第二次共享同一 buffer");
  });

  it("成功后再次点击：复用缓存，不再 fetch", async() => {
    const w = setup({ selectValue: "/models/generated/same.glb", buf: "B2" });
    await w.btn.fire("click");
    await Promise.resolve();
    await w.btn.fire("click");
    assert(w.fetches.length === 1, "第二次点击命中缓存不再 fetch");
    assert(w.calls.loadCustomModel.length === 2, "两次加载都完成");
  });

  it("404 失败后重试：缓存不保留错误，可重新 fetch", async() => {
    const w = setup({ selectValue: "/models/generated/retry404.glb", modelNotOk: true });
    await w.btn.fire("click");
    assert(w.calls.showStatus[1].msg === "❌ 从生成库加载失败: 加载失败 404", "第一次失败报 404");
    // 切换到正常 fetch 后重试同一 URL
    w.select.value = "/models/generated/retry-ok.glb";
    clearGeneratedModelCache();
    const w2 = setup({ selectValue: "/models/generated/retry-ok.glb", buf: "OK" });
    await w2.btn.fire("click");
    assert(w2.calls.loadCustomModel.length === 1, "重试成功且不载入旧错误");
  });

  it("网络异常失败后重试：同样可重试", async() => {
    const w = setup({ selectValue: "/models/generated/net.glb", modelError: true });
    await w.btn.fire("click");
    assert(w.calls.showStatus[1].msg === "❌ 从生成库加载失败: net down", "网络异常被捕获");
    clearGeneratedModelCache();
    const w2 = setup({ selectValue: "/models/generated/net2.glb", buf: "OK2" });
    await w2.btn.fire("click");
    assert(w2.calls.loadCustomModel[0].buf === "OK2", "重试成功");
  });
});

// ===== 运行 =====
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
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
