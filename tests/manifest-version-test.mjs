#!/usr/bin/env node
/**
 * 单元测试 — manifest 版本协商（src/manifest-version.js）
 *
 * 钉住的契约：
 *   · compatible：version 等于支持版本时通过，message 为空
 *   · missing：字段不存在 / undefined / null 都按兼容处理，但 message 提示
 *     重新导出（老文件与手写文件不该被一棍子打死）
 *   · unsupported：版本更高、非整数、非数字、小于 1、manifest 不是对象
 *   · 边界：version 为 0 / 1 / 2 / 1.0 / "1" / true / [] 各自归属明确
 *   · isManifestCompatible 与 inspectManifestVersion.supported 一致
 *
 * 用法：node tests/manifest-version-test.mjs
 */

import {
  inspectManifestVersion,
  isManifestCompatible,
  MANIFEST_SUPPORTED_VERSION,
} from "../src/manifest-version.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log("  OK " + message);
    passed++;
  } else {
    console.error("  FAIL " + message);
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

const V = MANIFEST_SUPPORTED_VERSION;

describe("compatible — 已知版本", async() => {
  await it("version 等于支持版本时通过，且不带 message", () => {
    const r = inspectManifestVersion({ version: V, parts: [] });
    assert(r.status === "compatible", "status = compatible");
    assert(r.supported === true, "supported = true");
    assert(r.version === V, "回带 version");
    assert(r.message === "", "无提示文案");
  });

  await it("支持版本常量是 1（与 split-manifest 的 MANIFEST_VERSION 对齐）", () => {
    assert(V === 1, "MANIFEST_SUPPORTED_VERSION = 1（实测 " + V + "）");
  });
});

describe("missing — 无版本字段按兼容处理", async() => {
  await it("字段不存在 / undefined / null 都算 missing 且 supported", () => {
    for (const m of [{ parts: [] }, { version: undefined, parts: [] }, { version: null, parts: [] }]) {
      const r = inspectManifestVersion(m);
      assert(r.status === "missing", "输入 " + JSON.stringify(m) + " -> missing");
      assert(r.supported === true, "且 supported");
      assert(r.version === null, "version 回 null");
    }
  });

  await it("message 提示按 v1 兼容读取并建议重新导出", () => {
    const r = inspectManifestVersion({ parts: [] });
    assert(r.message.includes("未声明 version"), "说明没版本号");
    assert(r.message.includes("v" + V), "说明按哪个版本读");
    assert(r.message.includes("重新导出"), "给出行动建议");
  });
});

describe("unsupported — 版本比我们新", async() => {
  await it("version 高于支持版本时拒绝，message 点名双方版本", () => {
    const r = inspectManifestVersion({ version: V + 1, parts: [] });
    assert(r.status === "unsupported", "status = unsupported");
    assert(r.supported === false, "supported = false");
    assert(r.version === V + 1, "回带读到的版本");
    assert(r.message.includes("v" + (V + 1)), "message 含文件版本");
    assert(r.message.includes("v" + V), "message 含支持版本");
    assert(r.message.includes("升级"), "给出行动建议");
  });

  await it("高很多也拒绝", () => {
    const r = inspectManifestVersion({ version: 99, parts: [] });
    assert(r.status === "unsupported", "v99 -> unsupported");
  });
});

describe("unsupported — version 类型与取值非法", async() => {
  await it("非整数（字符串 / 浮点 / 布尔 / 数组 / 对象）全部拒绝", () => {
    for (const bad of ["1", 1.5, true, false, [1], { a: 1 }, NaN, Infinity]) {
      const r = inspectManifestVersion({ version: bad, parts: [] });
      assert(r.status === "unsupported", "version=" + JSON.stringify(bad) + " -> unsupported");
      assert(r.supported === false, "且 supported = false");
    }
  });

  await it("version 小于 1 拒绝（有效版本从 1 开始）", () => {
    for (const bad of [0, -1, -99]) {
      const r = inspectManifestVersion({ version: bad, parts: [] });
      assert(r.status === "unsupported", "version=" + bad + " -> unsupported");
      assert(r.message.includes("有效版本从 1 开始"), "message 说明原因");
    }
  });

  await it("manifest 本身不是对象时拒绝", () => {
    for (const bad of [null, undefined, 42, "str", [1, 2], true]) {
      const r = inspectManifestVersion(bad);
      assert(r.status === "unsupported", "输入 " + JSON.stringify(bad) + " -> unsupported");
      assert(r.message.includes("不是一个对象"), "message 说明原因");
    }
  });
});

describe("isManifestCompatible — 与 supported 一致", async() => {
  await it("compatible 与 missing 都为 true", () => {
    assert(isManifestCompatible({ version: V, parts: [] }) === true, "compatible -> true");
    assert(isManifestCompatible({ parts: [] }) === true, "missing -> true");
  });

  await it("unsupported 一律 false", () => {
    for (const bad of [{ version: V + 1 }, { version: 0 }, { version: "1" }, null, 42]) {
      assert(isManifestCompatible(bad) === false, "输入 " + JSON.stringify(bad) + " -> false");
    }
  });

  await it("返回值恒为布尔（不是 truthy 值）", () => {
    const a = isManifestCompatible({ parts: [] });
    const b = isManifestCompatible(null);
    assert(a === true && b === false, "严格等于 true / false");
  });
});

// ===== runner =====
(async() => {
  for (const d of describeQueue) {
    console.log("\n📋 " + d.name);
    await d.fn();
  }
  console.log("\n" + "═".repeat(60));
  console.log("  结果: " + passed + " 通过, " + failed + " 失败");
  if (failed > 0) {
    console.error("  失败项:");
    for (const f of failures) console.error("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();

