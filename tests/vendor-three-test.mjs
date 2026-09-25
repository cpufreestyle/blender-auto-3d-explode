#!/usr/bin/env node
/**
 * 单元测试 — vendor/three 镜像守卫（dev 模式 importmap 的 three 副本）
 *
 * 背景：index.html 的 importmap 把裸 "three" 与 "three/examples/jsm/..." 映射到
 * /vendor/three/...，这是 dev 模式（npx serve . / node server.js）下裸导入的
 * 解析手段；webpack 构建产物走 node_modules/three，不经过这里。两套 three 一旦
 * 漂移，dev 与生产就跑在不同版本上且不报错——本仓库历史上就漂过 26 个版本
 * （镜像停在 r160、package.json 早已 0.186），examples 平铺到 vendor 根目录时
 * GLTFExporter→utils/TextureUtils 的相对路径也是断的。scripts/vendor_three_sync.py
 * （npm run vendor:sync）负责生成同构镜像，本测试负责钉住四件事：
 *   1. 镜像文件集合与 node_modules/three 的同步闭包逐文件字节一致；
 *   2. core 的 REVISION 与 package.json 的 three 次版本号一致（可读的失败信息）；
 *   3. main.js + src/ 里每个 three/examples/jsm 说明符都被 importmap 覆盖，
 *      且解析目标就在镜像里（新增导入漏配 importmap / 漏同步都会被杀）；
 *   4. 其它页面（preview-glb.html 与 tests/ 下手动页）引用的 vendor 路径都
 *      真实存在——这些页面曾被漂移和断支路径同时坑过。
 *
 * 用法：node tests/vendor-three-test.mjs
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = path.join(ROOT, "vendor", "three");
const NM = path.join(ROOT, "node_modules", "three");

// 同步脚本闭包的产物清单（入口 = core 构建产物 + 源码实际 import 的 5 个 examples）
const EXPECTED = [
  "build/three.core.js",
  "build/three.module.js",
  "examples/jsm/controls/OrbitControls.js",
  "examples/jsm/exporters/GLTFExporter.js",
  "examples/jsm/geometries/RoundedBoxGeometry.js",
  "examples/jsm/loaders/GLTFLoader.js",
  "examples/jsm/loaders/STLLoader.js",
  "examples/jsm/utils/BufferGeometryUtils.js",
  "examples/jsm/utils/SkeletonUtils.js",
];

const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function listMirrorFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(MIRROR, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

describe("镜像文件集合与同步闭包一致", () => {
  it("无缺失、无残留", () => {
    const actual = listMirrorFiles();
    const missing = EXPECTED.filter((f) => !actual.includes(f));
    const stale = actual.filter((f) => !EXPECTED.includes(f));
    assert(
      missing.length === 0 && stale.length === 0,
      `镜像共 ${actual.length} 个文件${missing.length ? `，缺: ${missing.join(", ")}` : ""}` +
        `${stale.length ? `，残留: ${stale.join(", ")}` : ""}`,
    );
  });
});

describe("镜像与 node_modules/three 逐文件字节一致", () => {
  it("升级 three 忘记跑 vendor:sync 即杀", () => {
    if (!fs.existsSync(NM)) {
      assert(false, "node_modules/three 不存在（先 npm ci；守卫需要它做对照）");
      return;
    }
    for (const rel of EXPECTED) {
      const m = path.join(MIRROR, rel);
      const n = path.join(NM, rel);
      assert(fs.existsSync(m) && fs.existsSync(n) && sha256(m) === sha256(n), `${rel} 字节一致`);
    }
  });
});

describe("core REVISION 与 package.json 的 three 次版本号一致", () => {
  it("0.186.0 → '186'", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const want = pkg.dependencies.three.replace(/^[\^~]/, "").split(".")[1];
    const core = fs.readFileSync(path.join(MIRROR, "build", "three.core.js"), "utf8");
    const m = core.match(/REVISION\s*=\s*'([^']+)'/);
    assert(!!m, "镜像 core 里取得到 REVISION");
    assert(m && m[1] === want, `REVISION ${m && m[1]} === package.json three 次版本 ${want}`);
  });
});

describe("importmap 覆盖源码里的每个 examples 导入", () => {
  it("说明符 → importmap 条目 → 镜像文件全链路通", () => {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const mapJson = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert(!!mapJson, "index.html 有 importmap");
    const map = JSON.parse(mapJson[1].trim()).imports;

    // 扫 main.js + src/ 里的 examples 说明符
    const specifiers = new Set();
    const scan = (rel) => {
      const dir = path.join(ROOT, rel);
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) scan(r);
        else if (entry.name.endsWith(".js")) {
          const text = fs.readFileSync(path.join(ROOT, r), "utf8");
          const reFrom = /from\s+["'](three(?:\/examples\/jsm\/[^"']+)?)["']/g;
          const reDyn = /import\(\s*["'](three(?:\/examples\/jsm\/[^"']+)?)["']\s*\)/g;
          for (const m of text.matchAll(reFrom)) specifiers.add(m[1]);
          for (const m of text.matchAll(reDyn)) specifiers.add(m[1]);
        }
      }
    };
    scan("src");
    const mainText = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
    for (const m of mainText.matchAll(/from\s+["'](three(?:\/examples\/jsm\/[^"']+)?)["']/g)) specifiers.add(m[1]);

    assert(specifiers.has("three"), "裸 three 主映射纳入覆盖（M4 型漏洞：主映射指错路径）");
    assert(map["three"] === "/vendor/three/build/three.module.js",
      `importmap 的 "three" 必须精确指向 build/three.module.js（当前 ${map["three"]}）`);
    const moduleBuild = fs.readFileSync(path.join(ROOT, "vendor/three/build/three.module.js"), "utf8");
    assert(/from\s+["']\.\/three\.core\.js["']/.test(moduleBuild),
      "three.module.js 从 three.core.js 再导出（0.186 的双构建产物结构，REVISION 在 core 里）");
    assert(specifiers.size > 0, `源码里扫到 ${specifiers.size} 个 three 说明符（含 examples）`);
    for (const spec of specifiers) {
      const target = Object.keys(map).includes(spec) ?
        map[spec] :
        Object.keys(map)
          .filter((k) => k.endsWith("/") && spec.startsWith(k))
          .sort((a, b) => b.length - a.length)
          .map((k) => map[k] + spec.slice(k.length))[0];
      assert(!!target, `${spec} 有 importmap 条目`);
      if (!target) continue;
      assert(target.startsWith("/vendor/three/"), `${spec} → ${target} 指向镜像`);
      const file = path.join(ROOT, target.replace(/^\//, ""));
      assert(fs.existsSync(file), `${target} 在磁盘上存在`);
    }
  });
});

describe("其它页面引用的 vendor 路径都真实存在", () => {
  it("preview-glb.html 与 tests/ 手动页", () => {
    const pages = [
      "preview-glb.html",
      "tests/view-simple.html",
      "tests/test-explosion.html",
      "tests/auto-split-v2.html",
    ];
    let checked = 0;
    for (const page of pages) {
      const text = fs.readFileSync(path.join(ROOT, page), "utf8");
      const refs = [
        ...text.matchAll(/from\s+["']([^"']*vendor\/[^"']+)["']/g),
        ...text.matchAll(/import\(\s*["']([^"']*vendor\/[^"']+)["']\s*\)/g),
      ].map((m) => m[1].split("?")[0]);
      for (const ref of refs) {
        const file = path.resolve(path.dirname(path.join(ROOT, page)), ref);
        checked++;
        assert(fs.existsSync(file), `${page} 的 ${ref} 存在`);
      }
    }
    assert(checked > 0, `共核对 ${checked} 个页面侧 vendor 引用`);
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
    for (const f of failures) console.log(`    - ${f}`);
    console.log("  （镜像漂移时运行 npm run vendor:sync 重新同步）");
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
