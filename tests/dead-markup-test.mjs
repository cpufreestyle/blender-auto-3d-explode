#!/usr/bin/env node
/**
 * 单元测试 — 静态标记与样式表的死代码守卫
 *
 * 背景：部件浮窗（partInfo）删除后，index.html 里留下了一整块无人读写的
 * #part-tooltip 标记与 .part-tooltip 样式，而这两处都没有任何 JS 消费者。
 * 只靠 grep 单点搜索容易漏，也容易被后续改动重新养回死标记；更要命的是
 * tailwind 式「同名字符串」会让朴素 substring 匹配漏报——.btn.upload-btn
 * 曾经就靠 id="upload-btn" 里的同名子串冒充成有消费者。本测试把「静态资产
 * 里不存在死代码」固化成可执行断言：
 *
 *   - index.html 的每个 id 都必须有消费者。消费者 = src 下所有 js +
 *     main.js + index.html 自己的内联脚本 + html 里除 id 声明以外的其余
 *     标记（label[for] / datalist[list] 这类属性接线即算消费者），且必须
 *     以词边界命中，避免被子串蒙混过关；
 *   - style.css 的每个 class 选择器都必须真实落在某个元素上。做法是从
 *     class 属性、classList 调用、className 赋值里收割「类名 token」，
 *     再要求每个 CSS class 都被收割到；运行时拼出来的类名走显式白名单，
 *     白名单每条都要写清拼接处与出处行号；
 *   - style.css 的每个 @keyframes 都必须被某条 animation / animation-name
 *     声明引用；
 *   - 仓库根目录的每个 .css 都必须被某个 html 的 link 标签加载——
 *     upload-enhancement.css 曾经躺在根目录没人链，构建也没 copy 它。
 *
 * 用法：node tests/dead-markup-test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
function it(_name, fn) {
  return fn();
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ===== 夹具：读源 =====
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function jsFiles() {
  const files = [path.join(ROOT, "main.js")];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(ROOT, "src"));
  return files;
}

function htmlFiles() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(ROOT, f));
}

const inlineScripts = (html) =>
  (html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || [])
    .map((block) => block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""))
    .join("\n");

// 去掉 id 声明本身，剩下的才算「消费者」
const htmlWithoutIdDeclarations = (html) => html.replace(/\sid="[^"]*"/g, "");

const wordHit = (haystack, needle) =>
  new RegExp(`(?<![\\w-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(haystack);

/** 从任意源码里收割「真实会落到元素上的类名」 */
function harvestClassTokens(blob) {
  const tokens = new Set();
  const addSplit = (raw) => {
    for (const t of raw.split(/[^A-Za-z0-9_-]+/)) if (t) tokens.add(t);
  };

  // class="a b c" —— 含 JS 字符串里转义写法的 class=\"a b c\"
  for (const m of blob.matchAll(/class\s*=\s*\\?["']([^"'\n]*)/g)) addSplit(m[1]);
  // element.classList.add/remove/toggle/contains("a")
  for (const m of blob.matchAll(/classList\.\w+\(\s*\\?["']([^"']*)/g)) addSplit(m[1]);
  // el.className = "a b c"
  for (const m of blob.matchAll(/className\s*=\s*\\?["']([^"']*)/g)) addSplit(m[1]);

  return tokens;
}

const mainHtml = readText("index.html");
const mainJs = jsFiles().map((f) => fs.readFileSync(f, "utf8")).join("\n");
const allHtml = htmlFiles().map((f) => fs.readFileSync(f, "utf8")).join("\n");
const mainCss = readText("style.css");
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ===== id 守卫 =====
describe("index.html 的 id 都有消费者", () => {
  const ids = [...new Set([...mainHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))].sort();
  const consumers = [
    mainJs,
    inlineScripts(mainHtml),
    htmlWithoutIdDeclarations(mainHtml),
  ].join("\n");

  it("数量与现状一致（回归后先看这里，别静默放行）", () => {
    assert(ids.length === 77, `index.html 声明了 ${ids.length} 个 id，预期 77`);
  });

  it("没有任何 id 是孤儿（词边界命中才算）", () => {
    const orphans = ids.filter((id) => !wordHit(consumers, id));
    assert(
      orphans.length === 0,
      orphans.length === 0 ? "77 个 id 全部有消费者" : `孤儿 id: ${orphans.join(", ")}`,
    );
  });
});

// ===== class 选择器守卫 =====
describe("style.css 的 class 选择器都真实生效", () => {
  const cssNoComment = stripCssComments(mainCss);
  const classes = [...new Set([...cssNoComment.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]))].sort();
  const tokens = harvestClassTokens([allHtml, mainJs].join("\n"));

  // 运行时拼出来的类名，静态扫不到字面量；每条都要写清拼接处。
  const RUNTIME_TEMPLATED = new Map([
    // src/status-ui.js:16 与 src/panels/ai-paint-panel.js:56
    //   el.className = "status-box " + type;  type 默认 "info"
    ["info", "status-ui.js:16 / ai-paint-panel.js:56 \"status-box \" + type"],
    // src/export-panel.js:68
    //   el.className = `toast toast-${type}${isLightTheme ? " toast-light" : ""}`
    ["toast", "export-panel.js:68 模板字面量前缀"],
    ["toast-light", "export-panel.js:68 `... ${isLightTheme ? \" toast-light\" : \"\"}`"],
    ["toast-success", "export-panel.js:68 `toast toast-${type}`，type=\"success\""],
    ["toast-error", "export-panel.js:68 `toast toast-${type}`，type=\"error\""],
  ]);

  it("数量与现状一致", () => {
    assert(classes.length === 118, `style.css 有 ${classes.length} 个 class 选择器，预期 118`);
  });

  it("每个 class 都有 token 落在元素上", () => {
    const orphans = classes.filter((c) => !tokens.has(c) && !RUNTIME_TEMPLATED.has(c));
    assert(
      orphans.length === 0,
      orphans.length === 0 ?
        "118 个 class 全部落在元素上（5 个走运行时白名单）" :
        `孤立 class: ${orphans.join(", ")}`,
    );
  });

  it("白名单里每条都在 style.css 里确实存在（防止过期条目）", () => {
    const stale = [...RUNTIME_TEMPLATED.keys()].filter((c) => !classes.includes(c));
    assert(stale.length === 0, stale.length === 0 ? "白名单无过期条目" : `白名单已过期: ${stale.join(", ")}`);
  });
});

// ===== keyframes 守卫 =====
describe("style.css 的关键帧都被引用", () => {
  const cssNoComment = stripCssComments(mainCss);
  const names = [...new Set([...cssNoComment.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))].sort();

  const CSS_KEYWORDS = new Set([
    "none", "infinite", "linear", "ease", "ease-in", "ease-out", "ease-in-out",
    "both", "forwards", "backwards", "alternate", "running", "paused",
    "normal", "reverse", "step-start", "step-end",
  ]);

  it("每个 @keyframes 都被 animation 声明引用", () => {
    const usedNames = new Set();
    for (const m of cssNoComment.matchAll(/animation(?:-name)?\s*:([^;]+);/g)) {
      for (const token of m[1].split(/[\s,]+/)) {
        // 时长（0.2s / 200ms）与百分比起头不是字母，天然被这条挡掉
        if (/^[A-Za-z][\w-]*$/.test(token) && !CSS_KEYWORDS.has(token)) usedNames.add(token);
      }
    }
    const unused = names.filter((n) => !usedNames.has(n));
    assert(
      unused.length === 0,
      unused.length === 0 ? `${names.length} 组关键帧全部被引用` : `未被引用: ${unused.join(", ")}`,
    );
  });
});

// ===== 根目录样式表守卫 =====
describe("根目录 .css 都被页面加载", () => {
  const rootCss = fs.readdirSync(ROOT).filter((f) => f.endsWith(".css"));

  it("没有孤立样式表", () => {
    const orphans = rootCss.filter((file) => !allHtml.includes(`href="${file}`));
    assert(
      orphans.length === 0,
      orphans.length === 0 ?
        `${rootCss.length} 个根目录样式表均被 link 标签加载` :
        `无人加载: ${orphans.join(", ")}`,
    );
  });
});

// ===== 汇总 =====
for (const { name, fn } of describeQueue) {
  console.log(`\n${name}`);
  fn();
}

console.log(`\n  结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log("  失败的用例:");
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
console.log("  \u2705 全部测试通过！");
