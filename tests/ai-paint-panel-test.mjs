#!/usr/bin/env node
/**
 * 单元测试 — 图片上传校验（src/panels/image-validate.js 的 validateImageFile）
 *
 * validateImageFile 是从 setupAIPaint.handleImageFile 里提出来的纯函数。提出去
 * 之前，这两条判断（MIME 白名单 + 10MB 体积上限）内联在闭包里，只能把整个面板
 * 起在浏览器里才能验到；现在它们可以被直接单测，边界也能逐字节钉住。单独成模块
 * 而不是留在 ai-paint-panel.js 里，是因为后者 import config-panel.js，而那个
 * 模块在顶层就碰 window——放在一起的话本测试在 Node 里根本 import 不起来。
 *
 * 钉住的不变量：
 *   - 判定顺序：先看类型、再看体积。一个又不是图片、又超大的文件拿到的是类型
 *     错误文案——顺序反了会让用户先看到体积提示，从而以为体积是唯一问题；
 *   - MIME 前缀必须是 "image/"（带斜杠），不是整词相等也不是模糊包含：
 *     image/png 与 image/svg+xml 都过，"text/plain" 与 "imagex/png" 都拒；
 *   - 体积上限是「大于 10MB 才拒」，因此恰好 10MB 是合法的（off-by-one 边界）；
 *   - 合法时返回 null 而不是 false/undefined——调用方写的是 `if (invalid)`，
 *     但返回值的类型属于对外契约，改动应该被测出来。
 *
 * 用法：node tests/ai-paint-panel-test.mjs
 */

import { validateImageFile } from "../src/panels/image-validate.js";

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

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`);
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}

const MAX = 10 * 1024 * 1024;
const TYPE_ERR = "❌ 请上传图片文件";
const SIZE_ERR = "❌ 图片不能超过 10MB";

// 真实 File 的两个字段就够：type 来自系统 MIME 映射，size 来自字节数
function fakeFile(type, size, name = "pic.png") {
  return { type, size, name };
}

// ===== 用例 =====
const OK_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  "image/avif", "image/bmp", "image/svg+xml",
];

// 刻意混进三类「看起来像图片」的：别的 image/* 之外的 base type（notimage/）、
// 少了斜杠的 imagex/、以及连斜杠都没有的裸 "images" / "image"
const BAD_TYPES = [
  "text/plain", "application/pdf", "video/mp4", "audio/mpeg", "model/gltf-binary",
  "", "notimage/png", "imagex/png", "images", "image",
];

describe("validateImageFile — 接收 image/* 类型", async() => {
  for (const type of OK_TYPES) {
    assertEqual(validateImageFile(fakeFile(type, 1024)), null, `${type} 被接受`);
  }
});

describe("validateImageFile — 拒绝非 image/* 类型", async() => {
  for (const type of BAD_TYPES) {
    assertEqual(validateImageFile(fakeFile(type, 1024)), TYPE_ERR, `type 为 ${JSON.stringify(type)} 时拒`);
  }
});

describe("validateImageFile — 体积边界", async() => {
  assertEqual(validateImageFile(fakeFile("image/png", 0)), null, "0 字节被接受（判断交给后续读取）");
  assertEqual(validateImageFile(fakeFile("image/png", 1)), null, "1 字节被接受");
  assertEqual(validateImageFile(fakeFile("image/png", 1024)), null, "1KB 被接受");
  assertEqual(validateImageFile(fakeFile("image/png", 5 * 1024 * 1024)), null, "5MB 被接受");
  assertEqual(validateImageFile(fakeFile("image/png", MAX - 1)), null, `恰好 ${MAX} - 1 字节被接受`);
  assertEqual(validateImageFile(fakeFile("image/png", MAX)), null, `恰好 ${MAX} 字节（10MB）也被接受：上限是严格大于`);
  assertEqual(validateImageFile(fakeFile("image/png", MAX + 1)), SIZE_ERR, "超出 1 字节即拒");
  assertEqual(validateImageFile(fakeFile("image/png", 20 * 1024 * 1024)), SIZE_ERR, "20MB 被拒");
});

describe("validateImageFile — 判定顺序：类型优先于体积", async() => {
  // 一个又不是图片、又超大的文件：拿到的一定是类型文案。顺序反了的话，
  // 用户会先被告知体积问题，从而以为只要压小体积就能通过。
  assertEqual(validateImageFile(fakeFile("application/pdf", 50 * 1024 * 1024)), TYPE_ERR, "非图片且超大 → 类型错误");
  assertEqual(validateImageFile(fakeFile("", MAX + 1)), TYPE_ERR, "无类型且超大 → 类型错误");
});

describe("validateImageFile — 没有文件时按类型错误处理", async() => {
  assertEqual(validateImageFile(null), TYPE_ERR, "null 文件");
  assertEqual(validateImageFile(undefined), TYPE_ERR, "undefined 文件");
});

describe("validateImageFile — 合法返回 null 这个值本身", async() => {
  const ok = validateImageFile(fakeFile("image/png", 2048));
  assert(ok === null, "返回值严格为 null（不是 undefined / false / 空串）");
  assert(!ok, "返回值 falsy，调用方的 `if (invalid)` 才能正确放行");
});

// ===== 运行 =====
for (const { name, fn } of describeQueue) {
  console.log(`\n📋 ${name}`);
  await fn();
}

console.log("\n" + "=".repeat(60));
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed === 0) {
  console.log("  ✅ 全部测试通过！");
} else {
  console.log("  ❌ 有测试失败！");
  console.log("\n  失败项:");
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
