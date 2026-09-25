#!/usr/bin/env node
/**
 * 单元测试 — API_BASE 单一数据源（src/config.js）
 *
 * 背景：服务器地址曾经有三份解析——src/config.js（读 window.APP_CONFIG，
 * 而 APP_CONFIG 全仓从未被赋值，等于永远是默认值）、index.html 与
 * ai-config.html 两个内联脚本各读一次 <meta name="api-base">。改 meta
 * 标签只会影响那两个内联脚本，主应用模块仍走默认值，页面与应用指向不同
 * 后端且不报错。本次由 src/config.js 收口整条解析链，两个静态页改为
 * import 同一个模块。
 *
 * 本测试钉两件事：
 *   1. 解析顺序行为：window.APP_CONFIG > <meta> > 默认值；meta 为空串 /
 *      不存在时正确回落；无 document 的服务端环境不抛 ReferenceError；
 *   2. 单一数据源不变量：meta 查询在全仓只剩 src/config.js 一处；两个
 *      静态页确实改成 import，且 ai-config.html 的 onclick 入口显式挂回
 *      window（module 顶层声明不外泄）；webpack CopyPlugin 把两个模块
 *      拷进 dist，否则绝对路径 import 在生产构建里 404。
 *
 * 用法：node tests/config-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SRC = fs.readFileSync(path.join(ROOT, "src/config.js"), "utf8");

// 与 src/config.js 里的选择器写法保持一致（CSS 属性值单引号，JS 串双引号）
const META_SELECTOR = "meta[name='api-base']";

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
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
function it(_name, fn) {
  return fn();
}

// 每个用例把源码写一份独立临时副本再 import：绕过 ESM 模块缓存，才能在同一
// 进程里反复求值不同全局环境下的 API_BASE
let tempSeq = 0;
async function resolveApiBase({ meta, appConfig, hasDocument = true }) {
  const file = path.join(os.tmpdir(), `quest3-config-${process.pid}-${tempSeq++}.mjs`);
  fs.writeFileSync(file, CONFIG_SRC);
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  try {
    if (appConfig === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = { APP_CONFIG: appConfig };
    }
    if (!hasDocument) {
      delete globalThis.document;
    } else {
      globalThis.document = {
        querySelector: (sel) =>
          sel === META_SELECTOR && meta !== undefined ? { content: meta } : null,
      };
    }
    const mod = await import(pathToFileURL(file).href);
    return mod.API_BASE;
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    fs.unlinkSync(file);
  }
}

// ===== 用例 =====
describe("API_BASE — meta 标签对模块侧生效（收口修复的核心）", async() => {
  await it("meta 指定地址时模块侧拿到同一地址", async() => {
    const v = await resolveApiBase({ meta: "http://backend:4000" });
    assert(v === "http://backend:4000", `meta=http://backend:4000 → ${v}`);
  });
  await it("meta 为空串时不当地址用，回落默认值", async() => {
    const v = await resolveApiBase({ meta: "" });
    assert(v === "http://localhost:3001", `meta="" → ${v}`);
  });
  await it("没有 meta 时回落默认值", async() => {
    const v = await resolveApiBase({});
    assert(v === "http://localhost:3001", `无 meta → ${v}`);
  });
});

describe("API_BASE — window.APP_CONFIG 优先（保留生产注入约定）", async() => {
  await it("APP_CONFIG 压过 meta 标签", async() => {
    const v = await resolveApiBase({
      meta: "http://backend:4000",
      appConfig: { API_BASE: "http://injected:9000" },
    });
    assert(v === "http://injected:9000", `两者都有时取 APP_CONFIG → ${v}`);
  });
  await it("APP_CONFIG 存在但缺 API_BASE 字段时继续往下走", async() => {
    const v = await resolveApiBase({ meta: "http://backend:4000", appConfig: {} });
    assert(v === "http://backend:4000", `APP_CONFIG={} → 走 meta → ${v}`);
  });
});

describe("API_BASE — 无 document 的服务端环境不炸", async() => {
  await it("只有 APP_CONFIG 时取它", async() => {
    const v = await resolveApiBase({ hasDocument: false, appConfig: { API_BASE: "http://srv:1" } });
    assert(v === "http://srv:1", `无 document + APP_CONFIG → ${v}`);
  });
  await it("什么都没有时取默认值", async() => {
    const v = await resolveApiBase({ hasDocument: false });
    assert(v === "http://localhost:3001", `无 document 无 APP_CONFIG → ${v}`);
  });
});

function listFrontendFiles() {
  const files = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith(".html")) files.push(name);
  }
  files.push("main.js");
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.name.endsWith(".js")) files.push(relPath);
    }
  };
  walk("src");
  return files;
}

describe("单一数据源 — meta 查询全仓只剩 src/config.js", async() => {
  await it("逐个前端文件扫描", () => {
    const needle = META_SELECTOR;
    const hit = listFrontendFiles().filter((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").includes(needle));
    assert(hit.length === 1 && hit[0] === "src/config.js", `命中文件 = ${JSON.stringify(hit)}`);
  });
  await it("config.js 保留 export、APP_CONFIG 钩子与默认值三个要素", () => {
    assert(/export const API_BASE =/.test(CONFIG_SRC), "仍导出 API_BASE");
    assert(CONFIG_SRC.includes("window.APP_CONFIG?.API_BASE"), "window.APP_CONFIG 覆盖点未丢");
    assert(CONFIG_SRC.includes("\"http://localhost:3001\""), "默认地址未丢");
  });
});

describe("ai-config.html — 改为 module 并 import 两个共享模块", async() => {
  const html = fs.readFileSync(path.join(ROOT, "ai-config.html"), "utf8");
  await it("script 标签类型与两条 import", () => {
    assert(html.includes("<script type=\"module\">"), "script 是 type=module");
    assert(html.includes("import { API_BASE } from \"/src/config.js\";"), "import API_BASE");
    assert(
      html.includes("import { configNeedsHighlight } from \"/src/panels/config-check.js\";"),
      "import configNeedsHighlight",
    );
  });
  await it("页面内不再自解析 API_BASE", () => {
    assert(!html.includes("const API_BASE"), "无本地 API_BASE 副本");
  });
  await it("提醒规则的页面内副本已删，改走共享函数", () => {
    assert(!html.includes("config[provider]"), "config[provider] 签名不复存在");
    assert(!html.includes("needRemind"), "needRemind 中间量不复存在");
    assert(html.includes("!configNeedsHighlight(config)"), "横幅显隐改由共享规则决定");
  });
});

describe("ai-config.html — onclick 入口显式挂回 window", async() => {
  const html = fs.readFileSync(path.join(ROOT, "ai-config.html"), "utf8");
  await it("5 个 onclick 调用的函数都有 window 绑定", () => {
    const handlers = [...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]);
    const uniq = [...new Set(handlers)];
    assert(handlers.length === 5, `onclick 处理器共 ${handlers.length} 个（不应变）`);
    for (const name of uniq) {
      assert(html.includes(`window.${name} = ${name};`), `${name} 已挂回 window`);
    }
  });
});

describe("index.html — 首配弹窗 IIFE 也吃共享 API_BASE", async() => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  await it("module + import，无本地副本", () => {
    assert(html.includes("import { API_BASE } from \"/src/config.js\";"), "IIFE 改为 import");
    assert(!html.includes("const API_BASE"), "index.html 无本地 API_BASE 副本");
  });
});

describe("webpack — CopyPlugin 给出 dist 侧的模块真身", async() => {
  const wp = fs.readFileSync(path.join(ROOT, "webpack.config.js"), "utf8");
  await it("两个被 import 的模块都要拷", () => {
    assert(wp.includes("{ from: \"src/config.js\", to: \"src/config.js\" }"), "拷贝 src/config.js");
    assert(
      wp.includes("{ from: \"src/panels/config-check.js\", to: \"src/panels/config-check.js\" }"),
      "拷贝 src/panels/config-check.js",
    );
  });
});

// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } catch (err) {
    console.error("运行异常:", err);
    process.exit(1);
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
