#!/usr/bin/env node
/**
 * 单元测试 — 重放地址契约（src/replay-url.js）
 *
 * 钉住三件事：只有 manifest 才进重放页；URL 里的文件名必须编码；重放页与
 * manifest 都落在 API_BASE 指定的后端来源上（?api= 开发态 / 桌面快捷方式）。
 */

import fs from "node:fs";

import { buildReplayUrl, isManifestUrl } from "../src/replay-url.js";

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

describe("isManifestUrl", () => {
  it("识别清单与普通模型", () => {
    assert(isManifestUrl("/models/generated/a-manifest.json"), "相对 .json 是清单");
    assert(isManifestUrl("/models/generated/a.JSON?x=1"), ".JSON 与 query 都不影响判定");
    assert(!isManifestUrl("/models/generated/a.glb"), ".glb 不是清单");
    assert(!isManifestUrl(""), "空值不是清单");
    assert(!isManifestUrl(null), "null 不是清单");
  });
});

describe("buildReplayUrl", () => {
  it("把清单地址完整编码进 manifest 参数", () => {
    const url = buildReplayUrl("/models/generated/Quest 3-manifest-x.json", {
      apiBase: "http://localhost:3011",
    });
    assert(url.startsWith("http://localhost:3011/replay.html?manifest="), "指向 API_BASE 来源的重放页");
    assert(url.includes("%2Fmodels%2Fgenerated%2F"), "路径分隔符已编码");
    assert(
      new URL(url).searchParams.get("manifest") === "/models/generated/Quest 3-manifest-x.json",
      "空格编码后可无损还原",
    );
    assert(!url.includes(" "), "地址里没有裸空格");
    assert(new URL(url).searchParams.get("api") === "http://localhost:3011", "带上 API_BASE 供重放页取清单");
  });

  it("换端口 / 换机器时跟随 apiBase", () => {
    const url = buildReplayUrl("/models/generated/a.json", { apiBase: "http://127.0.0.1:8080" });
    assert(url.startsWith("http://127.0.0.1:8080/replay.html?"), "端口跟随 API_BASE");
    assert(new URL(url).searchParams.get("manifest") === "/models/generated/a.json", "参数可无损还原");
    assert(new URL(url).searchParams.get("api") === "http://127.0.0.1:8080", "重放页记住自定义后端来源");
  });

  it("缺省 apiBase 使用 config.js 的 API_BASE", () => {
    const url = buildReplayUrl("/models/generated/a.json");
    assert(url.includes("replay.html?manifest="), "缺省仍产出可用地址");
    assert(new URL(url).searchParams.get("manifest") === "/models/generated/a.json", "缺省参数可还原");
  });
});

describe("replay.html 接线", () => {
  const html = fs.readFileSync(new URL("../replay.html", import.meta.url), "utf8");

  it("importmap 能解析裸 three 与 controls 子路径", () => {
    assert(html.includes("\"three\": \"/vendor/three/build/three.module.js\""), "three 映射");
    assert(html.includes("\"three/examples/jsm/\""), "examples 子路径映射");
  });

  it("复用 src/config.js 的 API_BASE，不复制 meta 解析", () => {
    assert(html.includes("from \"./src/config.js\""), "导入共享配置");
    assert(!html.includes("meta[name='api-base']"), "没有第二份 meta 解析");
  });

  it("进度滑块与错误态有可访问性标注", () => {
    assert(html.includes("id=\"progress\"") && html.includes("aria-label=\"拆解进度\""), "滑块有 aria-label");
    assert(html.includes("id=\"err\"") && html.includes("role=\"alert\""), "错误区是 alert");
  });
});

for (const { name, fn } of describeQueue) {
  console.log(`\n── ${name}`);
  fn();
}
console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log("  失败的用例:");
  for (const f of failures) console.log("    - " + f);
  process.exit(1);
}
console.log("  ✅ 全部测试通过！");
