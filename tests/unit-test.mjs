#!/usr/bin/env node
/**
 * 单元测试 — 纯函数模块
 *
 * 测试 src/utils.js 和 src/server-utils.js 中导出的函数
 * 不依赖浏览器或 Three.js 环境
 *
 * 用法：
 *   node tests/unit-test.mjs
 */

import {
  UnionFind,
  easeOutCubic,
  clamp,
  smoothStep,
  lerp,
  isQuest3Model,
  generatePartName,
  base64ToUtf8,
  formatBytes,
  validateGLBHeader,
  computeStepGroupCount,
  sortPartsForDisassembly,
  computeExplodeVector,
} from "../src/utils.js";

import {
  sanitizeFilename,
  parseMultipartBuffer,
  getCORSHeaders,
  cleanupOldTempFiles,
  isAllowedExtension,
  findBlenderCandidates,
  createBlenderJobQueue,
  MAX_PARTS,
  MAX_BOUNDARY_LENGTH,
  MAX_FILE_SIZE,
  MAX_HEADER_SIZE,
  TEMP_FILE_TTL_MS,
  ALLOWED_EXTENSIONS,
} from "../src/server-utils.js";

// Buffer is a global in Node.js
// ===== 测试框架 =====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
    failures.push(message);
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${message}: ${actual}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
    failed++;
    failures.push(message);
  }
}

function assertApprox(actual, expected, epsilon, message) {
  const ok = Math.abs(actual - expected) < epsilon;
  if (ok) {
    console.log(`  ✅ ${message}: ${actual} ≈ ${expected}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}: 期望 ≈${expected}, 实际 ${actual}`);
    failed++;
    failures.push(message);
  }
}

function describe(name, fn) {
  console.log(`\n📋 ${name}`);
  fn();
}

// ===== 测试开始 =====

console.log("═".repeat(60));
console.log("  🧪 单元测试 — 纯函数模块");
console.log("═".repeat(60));

// ── UnionFind ──
describe("UnionFind 数据结构", () => {
  const uf = new UnionFind(10);

  // 初始状态：每个元素自成一派
  assertEqual(uf.find(0), 0, "初始 find(0) = 0");
  assertEqual(uf.find(5), 5, "初始 find(5) = 5");

  // union 操作
  uf.union(0, 1);
  assertEqual(uf.find(0), uf.find(1), "union(0,1) 后 find(0) == find(1)");

  uf.union(1, 2);
  assertEqual(uf.find(0), uf.find(2), "传递性: union(1,2) 后 find(0) == find(2)");

  uf.union(3, 4);
  uf.union(2, 3);
  assertEqual(uf.find(0), uf.find(4), "多级传递: 0-1-2-3-4 全部连通");

  // 未连通的元素
  assert(uf.find(0) !== uf.find(5), "find(0) != find(5) — 未连通");

  // 路径压缩验证
  const uf2 = new UnionFind(100);
  for (let i = 0; i < 99; i++) uf2.union(i, i + 1);
  const root = uf2.find(0);
  assertEqual(uf2.find(99), root, "100 个元素全连通后 find(0) == find(99)");

  // roots 方法
  const uf3 = new UnionFind(6);
  uf3.union(0, 1);
  uf3.union(2, 3);
  assertEqual(uf3.roots().length, 4, "6 元素 union(0,1) union(2,3) 后有 4 个连通分量");

  // componentSize
  assertEqual(uf3.componentSize(0), 2, "componentSize(0) = 2");
  assertEqual(uf3.componentSize(4), 1, "componentSize(4) = 1");
});

// ── easeOutCubic ──
describe("easeOutCubic 缓动函数", () => {
  assertApprox(easeOutCubic(0), 0, 1e-10, "easeOutCubic(0) = 0");
  assertApprox(easeOutCubic(1), 1, 1e-10, "easeOutCubic(1) = 1");
  assertApprox(easeOutCubic(0.5), 0.875, 1e-10, "easeOutCubic(0.5) = 0.875");
  assertApprox(easeOutCubic(0.25), 0.578125, 1e-10, "easeOutCubic(0.25) = 0.578125");
  // 减速特性：前半段比线性快
  assert(easeOutCubic(0.5) > 0.5, "easeOutCubic(0.5) > 0.5（前半段加速）");
});

// ── clamp ──
describe("clamp 数值限制", () => {
  assertEqual(clamp(5, 0, 10), 5, "clamp(5, 0, 10) = 5");
  assertEqual(clamp(-5, 0, 10), 0, "clamp(-5, 0, 10) = 0");
  assertEqual(clamp(15, 0, 10), 10, "clamp(15, 0, 10) = 10");
  assertEqual(clamp(0, 0, 10), 0, "clamp(0, 0, 10) = 0（边界）");
  assertEqual(clamp(10, 0, 10), 10, "clamp(10, 0, 10) = 10（边界）");
});

// ── smoothStep ──
describe("smoothStep 阶梯函数", () => {
  assertEqual(smoothStep(0, 1, -1), 0, "smoothStep(0,1,-1) = 0（低于下界）");
  assertEqual(smoothStep(0, 1, 2), 1, "smoothStep(0,1,2) = 1（高于上界）");
  assertApprox(smoothStep(0, 1, 0), 0, 1e-10, "smoothStep(0,1,0) = 0");
  assertApprox(smoothStep(0, 1, 1), 1, 1e-10, "smoothStep(0,1,1) = 1");
  assertApprox(smoothStep(0, 1, 0.5), 0.5, 1e-10, "smoothStep(0,1,0.5) = 0.5（中点）");

  // edge0 == edge1 退化情况
  assertEqual(smoothStep(5, 5, 3), 0, "smoothStep(5,5,3) = 0（退化，x < edge0）");
  assertEqual(smoothStep(5, 5, 7), 1, "smoothStep(5,5,7) = 1（退化，x >= edge0）");

  // 负范围
  assertEqual(smoothStep(-2, 0, -1), 0.5, "smoothStep(-2,0,-1) = 0.5");
});

// ── lerp ──
describe("lerp 线性插值", () => {
  assertApprox(lerp(0, 10, 0), 0, 1e-10, "lerp(0,10,0) = 0");
  assertApprox(lerp(0, 10, 1), 10, 1e-10, "lerp(0,10,1) = 10");
  assertApprox(lerp(0, 10, 0.5), 5, 1e-10, "lerp(0,10,0.5) = 5");
  assertApprox(lerp(-5, 5, 0.3), -2, 1e-10, "lerp(-5,5,0.3) = -2");
});

// ── isQuest3Model ──
describe("isQuest3Model 文件名检测", () => {
  assert(isQuest3Model("Quest3.glb"), "Quest3.glb → true");
  assert(isQuest3Model("quest3.stl"), "quest3.stl → true");
  assert(isQuest3Model("Quest 3 URDF.urdf"), "Quest 3 URDF.urdf → true");
  assert(isQuest3Model("QUEST3 model.glb"), "QUEST3 model.glb → true");
  assert(!isQuest3Model("basketball.glb"), "basketball.glb → false");
  assert(!isQuest3Model("robot.stl"), "robot.stl → false");
  assert(!isQuest3Model(""), "空字符串 → false");
  assert(!isQuest3Model(null), "null → false");
  assert(!isQuest3Model(undefined), "undefined → false");
  assert(!isQuest3Model("quest.glb"), "quest.glb (无3) → false");
});

// ── generatePartName ──
describe("generatePartName 部件命名", () => {
  const bbox = {
    center: { x: 0, y: 0, z: 0 },
    size: { x: 10, y: 10, z: 10 },
    min: { x: -5, y: -5, z: -5 },
    max: { x: 5, y: 5, z: 5 },
  };

  // 右侧
  assertEqual(
    generatePartName(0, { x: 4, y: 0, z: 0 }, bbox),
    "部件1·右侧",
    "右侧部件命名",
  );

  // 左侧
  assertEqual(
    generatePartName(1, { x: -4, y: 0, z: 0 }, bbox),
    "部件2·左侧",
    "左侧部件命名",
  );

  // 顶部
  assertEqual(
    generatePartName(2, { x: 0, y: 4, z: 0 }, bbox),
    "部件3·顶部",
    "顶部部件命名",
  );

  // 底部
  assertEqual(
    generatePartName(3, { x: 0, y: -4, z: 0 }, bbox),
    "部件4·底部",
    "底部部件命名",
  );

  // 前方
  assertEqual(
    generatePartName(4, { x: 0, y: 0, z: 4 }, bbox),
    "部件5·前方",
    "前方部件命名",
  );

  // 后方
  assertEqual(
    generatePartName(5, { x: 0, y: 0, z: -4 }, bbox),
    "部件6·后方",
    "后方部件命名",
  );

  // 中心
  assertEqual(
    generatePartName(6, { x: 0.1, y: 0.1, z: 0.1 }, bbox),
    "部件7·中心",
    "中心部件命名",
  );
});

// ── base64ToUtf8 ──
describe("base64ToUtf8 解码", () => {
  // ASCII
  assertEqual(base64ToUtf8("SGVsbG8gV29ybGQ="), "Hello World", "ASCII 解码");

  // 中文 UTF-8
  assertEqual(base64ToUtf8("5L2g5aW9"), "你好", "中文解码");

  // 混合
  assertEqual(base64ToUtf8("UXVlc3QgMyDniIbngrjlm74="), "Quest 3 爆炸图", "中英混合解码");

  // 空字符串
  assertEqual(base64ToUtf8(""), "", "空字符串解码");
});

// ── formatBytes ──
describe("formatBytes 文件大小格式化", () => {
  assertEqual(formatBytes(0), "0 B", "0 B");
  assertEqual(formatBytes(512), "512 B", "512 B");
  assertEqual(formatBytes(1024), "1.0 KB", "1024 → 1.0 KB");
  assertEqual(formatBytes(1536), "1.5 KB", "1536 → 1.5 KB");
  assertEqual(formatBytes(1048576), "1.0 MB", "1048576 → 1.0 MB");
  assertEqual(formatBytes(5242880), "5.0 MB", "5242880 → 5.0 MB");
});

// ── validateGLBHeader ──
describe("validateGLBHeader GLB 头部校验", () => {
  // 构造有效的 GLB 头部
  const validGLB = new ArrayBuffer(20);
  const view = new DataView(validGLB);
  view.setUint32(0, 0x46546c67, true); // magic 'glTF'
  view.setUint32(4, 2, true); // version 2
  view.setUint32(8, 20, true); // total length
  view.setUint32(12, 0, true); // chunk length (dummy)
  view.setUint32(16, 0x4e4f534a, true); // chunk type JSON

  const result = validateGLBHeader(new Uint8Array(validGLB));
  assert(result.valid, "有效 GLB 头部 → valid: true");
  assertEqual(result.version, 2, "GLB 版本 = 2");
  assertEqual(result.length, 20, "GLB 长度 = 20");

  // 太短
  const shortResult = validateGLBHeader(new Uint8Array(5));
  assert(!shortResult.valid, "太短的数据 → invalid");
  assert(!!shortResult.error, "包含错误信息");

  // 错误的 magic
  const badGLB = new ArrayBuffer(12);
  const badView = new DataView(badGLB);
  badView.setUint32(0, 0x00000000, true);
  badView.setUint32(4, 2, true);
  badView.setUint32(8, 12, true);
  const badResult = validateGLBHeader(new Uint8Array(badGLB));
  assert(!badResult.valid, "错误的 magic → invalid");

  // null 输入
  assert(!validateGLBHeader(null).valid, "null 输入 → invalid");
  assert(!validateGLBHeader(undefined).valid, "undefined 输入 → invalid");
});

// ── sanitizeFilename ──
describe("sanitizeFilename 文件名消毒", () => {
  assertEqual(sanitizeFilename("model.glb"), "model.glb", "正常文件名不变");
  assertEqual(sanitizeFilename("path/to/file.glb"), "pathtofile.glb", "移除路径分隔符");
  assertEqual(sanitizeFilename("..\\..\\evil.exe"), "evil.exe", "移除 .. 和反斜杠");
  assertEqual(sanitizeFilename("file\x00name.glb"), "filename.glb", "移除控制字符");
  assertEqual(sanitizeFilename("file\x1fname.glb"), "filename.glb", "移除 DEL 控制字符");
  assertEqual(sanitizeFilename("正常文件.glb"), "正常文件.glb", "保留中文字符");
  assertEqual(sanitizeFilename(""), "", "空字符串返回空");
});

// ── parseMultipartBuffer ──
describe("parseMultipartBuffer multipart 解析", () => {
  // 构造有效的 multipart 数据
  const boundary = "TestBoundary123";
  const fileContent = "Hello GLB World";
  const multipartData =
    `--${boundary}\r\n` +
    "Content-Disposition: form-data; name=\"file\"; filename=\"test.glb\"\r\n" +
    "Content-Type: application/octet-stream\r\n" +
    "\r\n" +
    fileContent +
    `\r\n--${boundary}--\r\n`;

  const buffer = Buffer.from(multipartData, "latin1");
  const result = parseMultipartBuffer(buffer, `--${boundary}`);

  assert(!!result, "解析结果非 null");
  assertEqual(result.filename, "test.glb", "文件名正确");
  assertEqual(result.fieldname, "file", "字段名正确");
  assertEqual(result.contentType, "application/octet-stream", "Content-Type 正确");
  assertEqual(result.data.toString("utf-8"), fileContent, "文件内容正确");

  // 空文件名
  const emptyMultipart =
    `--${boundary}\r\n` +
    "Content-Disposition: form-data; name=\"file\"; filename=\"\"\r\n" +
    "Content-Type: application/octet-stream\r\n" +
    "\r\n" +
    `\r\n--${boundary}--\r\n`;
  const emptyResult = parseMultipartBuffer(Buffer.from(emptyMultipart, "latin1"), `--${boundary}`);
  assertEqual(emptyResult, null, "空文件名 → null");

  // 无效 boundary
  const invalidResult = parseMultipartBuffer(buffer, "--WrongBoundary");
  assertEqual(invalidResult, null, "错误 boundary → null");

  // 恶意文件名（路径遍历）
  const maliciousMultipart =
    `--${boundary}\r\n` +
    "Content-Disposition: form-data; name=\"file\"; filename=\"../../etc/passwd\"\r\n" +
    "Content-Type: application/octet-stream\r\n" +
    "\r\n" +
    "evil" +
    `\r\n--${boundary}--\r\n`;
  const maliciousResult = parseMultipartBuffer(
    Buffer.from(maliciousMultipart, "latin1"),
    `--${boundary}`,
  );
  assert(!!maliciousResult, "恶意文件名解析结果非 null");
  assertEqual(maliciousResult.filename, "etcpasswd", "路径遍历被移除");
  assert(!maliciousResult.filename.includes(".."), "文件名不含 ..");
  assert(!maliciousResult.filename.includes("/"), "文件名不含 /");
});

// ── getCORSHeaders ──
describe("getCORSHeaders CORS 头", () => {
  const headers = getCORSHeaders();

  assertEqual(headers["Access-Control-Allow-Origin"], "*", "CORS Origin = *");
  assert(headers["Access-Control-Allow-Methods"].includes("GET"), "允许 GET");
  assert(headers["Access-Control-Allow-Methods"].includes("POST"), "允许 POST");
  assert(headers["Access-Control-Allow-Methods"].includes("OPTIONS"), "允许 OPTIONS");
  assert(headers["Access-Control-Allow-Headers"].includes("X-Manifest"), "允许 X-Manifest 头");
  assert(
    headers["Access-Control-Expose-Headers"].includes("X-Total-Parts"),
    "暴露 X-Total-Parts 头",
  );

  // 确保每次调用返回新对象（防止共享引用被修改）
  const headers2 = getCORSHeaders();
  headers2["X-Custom"] = "test";
  assert(!headers["X-Custom"], "每次调用返回独立对象");
});

// ── 常量验证 ──
describe("安全常量", () => {
  assertEqual(MAX_PARTS, 10, "MAX_PARTS = 10");
  assertEqual(MAX_BOUNDARY_LENGTH, 200, "MAX_BOUNDARY_LENGTH = 200");
  assert(MAX_PARTS > 0, "MAX_PARTS > 0");
  assert(MAX_BOUNDARY_LENGTH > 0, "MAX_BOUNDARY_LENGTH > 0");
  assertEqual(MAX_FILE_SIZE, 150 * 1024 * 1024, "MAX_FILE_SIZE = 150MB");
  assertEqual(MAX_HEADER_SIZE, 8192, "MAX_HEADER_SIZE = 8192");
  assertEqual(TEMP_FILE_TTL_MS, 3600000, "TEMP_FILE_TTL_MS = 1小时");
  assert(ALLOWED_EXTENSIONS.includes(".glb"), "ALLOWED_EXTENSIONS 包含 .glb");
  assert(ALLOWED_EXTENSIONS.includes(".gltf"), "ALLOWED_EXTENSIONS 包含 .gltf");
  assert(ALLOWED_EXTENSIONS.includes(".stl"), "ALLOWED_EXTENSIONS 包含 .stl");
  assert(ALLOWED_EXTENSIONS.includes(".obj"), "ALLOWED_EXTENSIONS 包含 .obj");
});

// ── isAllowedExtension ──
describe("isAllowedExtension 文件扩展名校验", () => {
  assert(isAllowedExtension(".glb"), ".glb 允许");
  assert(isAllowedExtension(".gltf"), ".gltf 允许");
  assert(isAllowedExtension(".stl"), ".stl 允许");
  assert(isAllowedExtension(".obj"), ".obj 允许");
  assert(isAllowedExtension(".GLB"), ".GLB 大写允许（大小写不敏感）");
  assert(isAllowedExtension(".Glb"), ".Glb 混合大小写允许");
  assert(!isAllowedExtension(".exe"), ".exe 不允许");
  assert(!isAllowedExtension(".js"), ".js 不允许");
  assert(!isAllowedExtension(".py"), ".py 不允许");
  assert(!isAllowedExtension(""), "空字符串不允许");
  assert(!isAllowedExtension(null), "null 不允许");
  assert(!isAllowedExtension(undefined), "undefined 不允许");
  assert(!isAllowedExtension("glb"), "无点号不允许");
});

// ── findBlenderCandidates ──
describe("findBlenderCandidates Blender 路径候选", () => {
  // macOS
  const macCandidates = findBlenderCandidates("darwin", "/Users/test");
  assert(macCandidates.length >= 5, "macOS 至少有 5 个候选路径");
  assert(macCandidates.includes("/Applications/Blender.app/Contents/MacOS/Blender"), "macOS 包含 Applications 路径");
  assert(macCandidates.includes("/opt/homebrew/bin/blender"), "macOS 包含 Homebrew 路径");
  assertEqual(macCandidates[macCandidates.length - 1], "blender", "macOS 最后是回退值 blender");
  assert(
    macCandidates.some(c => c.includes("/Users/test")),
    "macOS 包含用户目录候选",
  );

  // Linux
  const linuxCandidates = findBlenderCandidates("linux", "/home/test");
  assert(linuxCandidates.length >= 5, "Linux 至少有 5 个候选路径");
  assert(linuxCandidates.includes("/usr/bin/blender"), "Linux 包含 /usr/bin/blender");
  assert(linuxCandidates.includes("/snap/bin/blender"), "Linux 包含 snap 路径");
  assertEqual(linuxCandidates[linuxCandidates.length - 1], "blender", "Linux 最后是回退值 blender");

  // Windows
  const winCandidates = findBlenderCandidates("win32", "C:/Users/test", {
    ProgramFiles: "C:/Program Files",
    "ProgramFiles(x86)": "C:/Program Files (x86)",
  });
  assert(winCandidates.length >= 4, "Windows 至少有 4 个候选路径");
  assertEqual(winCandidates[winCandidates.length - 1], "blender", "Windows 最后是回退值 blender");
  assert(
    winCandidates.some(c => c.includes("Blender Foundation")),
    "Windows 包含 Program Files 路径",
  );

  // 未知平台只返回回退值
  const unknownCandidates = findBlenderCandidates("freebsd", "/home/test");
  assertEqual(unknownCandidates.length, 1, "未知平台只有回退值");
  assertEqual(unknownCandidates[0], "blender", "未知平台回退值为 blender");
});

// ── createBlenderJobQueue ──
describe("createBlenderJobQueue Blender 任务串行队列", () => {
  // 基本功能：enqueue 返回 Promise
  const queue = createBlenderJobQueue();
  const order = [];

  queue.enqueue(() => { order.push(1); return Promise.resolve(); });
  queue.enqueue(() => { order.push(2); return Promise.resolve(); });
  queue.enqueue(() => { order.push(3); return Promise.resolve(); });

  // 同步任务立即执行，但需要等待 microtask 完成
  // 这里先验证 enqueue 返回 Promise
  const q2 = createBlenderJobQueue();
  const p = q2.enqueue(() => Promise.resolve(42));
  assert(p instanceof Promise, "enqueue 返回 Promise");

  // 异常不破坏队列
  const queue3 = createBlenderJobQueue();
  const failP = queue3.enqueue(() => Promise.reject(new Error("test error")));
  failP.catch(() => {}); // 吞掉 rejection
  const nextP = queue3.enqueue(() => Promise.resolve("ok"));
  assert(nextP instanceof Promise, "失败后队列仍可入队新任务");

  // 独立队列互不干扰
  const qA = createBlenderJobQueue();
  const qB = createBlenderJobQueue();
  assert(qA !== qB, "不同队列实例独立");
  const pA = qA.enqueue(() => Promise.resolve("A"));
  const pB = qB.enqueue(() => Promise.resolve("B"));
  assert(pA instanceof Promise && pB instanceof Promise, "独立队列各自返回 Promise");
});

// ── cleanupOldTempFiles ──
describe("cleanupOldTempFiles 临时文件清理", () => {
  // Mock fs 模块
  const mockFiles = {
    "old1.tmp": { mtimeMs: Date.now() - 7200000 }, // 2小时前
    "old2.tmp": { mtimeMs: Date.now() - 5000000 }, // 超过1小时
    "new1.tmp": { mtimeMs: Date.now() - 60000 },   // 1分钟前
    "new2.tmp": { mtimeMs: Date.now() - 1000 },     // 刚创建
  };
  const deleted = [];
  const mockFs = {
    readdirSync: () => Object.keys(mockFiles),
    statSync: (filePath) => {
      const name = filePath.split("/").pop();
      return { mtimeMs: mockFiles[name].mtimeMs };
    },
    unlinkSync: (filePath) => { deleted.push(filePath.split("/").pop()); },
  };
  const mockPath = {
    join: (dir, file) => `${dir}/${file}`,
  };

  const cleaned = cleanupOldTempFiles("/tmp/test", mockFs, mockPath, 3600000);
  assertEqual(cleaned, 2, "清理了 2 个过期文件");
  assert(deleted.includes("old1.tmp"), "删除了 old1.tmp");
  assert(deleted.includes("old2.tmp"), "删除了 old2.tmp");
  assert(!deleted.includes("new1.tmp"), "保留 new1.tmp");
  assert(!deleted.includes("new2.tmp"), "保留 new2.tmp");

  // 目录不存在时返回 0
  const errorFs = {
    readdirSync: () => { throw new Error("ENOENT"); },
  };
  const errorResult = cleanupOldTempFiles("/nonexistent", errorFs, mockPath);
  assertEqual(errorResult, 0, "目录不存在时返回 0");

  // 空目录
  const emptyFs = {
    readdirSync: () => [],
  };
  const emptyResult = cleanupOldTempFiles("/tmp/empty", emptyFs, mockPath);
  assertEqual(emptyResult, 0, "空目录返回 0");
});

// ── parseMultipartBuffer 安全补充 ──
describe("parseMultipartBuffer 安全边界", () => {
  const boundary = "SafeBoundary";

  // part 数量超限
  let multiPartData = "";
  for (let i = 0; i < MAX_PARTS + 1; i++) {
    multiPartData +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="file${i}.glb"\r\n` +
      "Content-Type: application/octet-stream\r\n" +
      "\r\n" +
      "data" +
      "\r\n";
  }
  multiPartData += `--${boundary}--\r\n`;

  let threw = false;
  try {
    parseMultipartBuffer(Buffer.from(multiPartData, "latin1"), `--${boundary}`);
  } catch (e) {
    threw = true;
    assert(e.message.includes(String(MAX_PARTS)), "错误信息包含 MAX_PARTS 值");
  }
  assert(threw, "超过 MAX_PARTS 限制时抛出异常");

  // 二进制内容包含 null 字节
  const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  const binaryMultipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="binary.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n`, "latin1"),
    binaryContent,
    Buffer.from(`\r\n--${boundary}--\r\n`, "latin1"),
  ]);
  const binaryResult = parseMultipartBuffer(binaryMultipart, `--${boundary}`);
  assert(!!binaryResult, "二进制内容解析成功");
  assertEqual(binaryResult.filename, "binary.glb", "二进制文件文件名正确");
  assertEqual(binaryResult.data.length, 5, "二进制数据长度正确");
});

// ── sanitizeFilename 安全补充 ──
describe("sanitizeFilename 安全边界补充", () => {
  // 全部是危险字符
  assertEqual(sanitizeFilename("../../../.."), "", "纯路径遍历字符返回空");
  assertEqual(sanitizeFilename("\\\\\\\\"), "", "纯反斜杠返回空");

  // 混合攻击
  assertEqual(sanitizeFilename("..\\..\\..\\Windows\\system32"), "Windowssystem32", "复杂路径遍历被清除");
  assertEqual(sanitizeFilename("\x00\x01\x02evil.glb"), "evil.glb", "前缀控制字符被移除");

  // Unicode 保留
  assertEqual(sanitizeFilename("模型文件.glb"), "模型文件.glb", "中文文件名保留");
  assertEqual(sanitizeFilename("модель.glb"), "модель.glb", "俄文文件名保留");
  assertEqual(sanitizeFilename("モデル.glb"), "モデル.glb", "日文文件名保留");
});

// ── computeStepGroupCount ──
describe("computeStepGroupCount 步骤分组计算", () => {
  assertEqual(computeStepGroupCount(0), 2, "0 个部件 → 最少 2 组");
  assertEqual(computeStepGroupCount(1), 2, "1 个部件 → 最少 2 组");
  assertEqual(computeStepGroupCount(3), 2, "3 个部件 → ceil(3/3)=1 → 最少 2 组");
  assertEqual(computeStepGroupCount(4), 2, "4 个部件 → ceil(4/3)=2");
  assertEqual(computeStepGroupCount(6), 2, "6 个部件 → ceil(6/3)=2");
  assertEqual(computeStepGroupCount(7), 3, "7 个部件 → ceil(7/3)=3");
  assertEqual(computeStepGroupCount(9), 3, "9 个部件 → ceil(9/3)=3");
  assertEqual(computeStepGroupCount(15), 5, "15 个部件 → ceil(15/3)=5");
  assertEqual(computeStepGroupCount(18), 6, "18 个部件 → 最多 6 组");
  assertEqual(computeStepGroupCount(30), 6, "30 个部件 → 最多 6 组");
  assertEqual(computeStepGroupCount(100), 6, "100 个部件 → 最多 6 组");
});

// ── sortPartsForDisassembly ──
describe("sortPartsForDisassembly 部件排序", () => {
  const makePart = (name, dist) => ({
    name,
    homePos: { length: () => dist },
  });

  // 无装配顺序：按距离降序
  const parts = [
    makePart("近", 1),
    makePart("远", 5),
    makePart("中", 3),
  ];
  const sorted = sortPartsForDisassembly(parts);
  assertEqual(sorted[0].name, "远", "无顺序时最远的先拆");
  assertEqual(sorted[1].name, "中", "中间第二");
  assertEqual(sorted[2].name, "近", "最近的最后拆");

  // 有装配顺序：按装配顺序排列
  const ordered = sortPartsForDisassembly(parts, ["近", "中", "远"]);
  assertEqual(ordered[0].name, "近", "装配顺序优先：第一个");
  assertEqual(ordered[1].name, "中", "装配顺序优先：第二个");
  assertEqual(ordered[2].name, "远", "装配顺序优先：第三个");

  // 装配顺序部分匹配：未匹配的按距离降序
  const partialOrder = sortPartsForDisassembly(parts, ["中"]);
  assertEqual(partialOrder[0].name, "中", "部分匹配：匹配的在前");
  assertEqual(partialOrder[1].name, "远", "部分匹配：未匹配按距离降序");
  assertEqual(partialOrder[2].name, "近", "部分匹配：最近的最后");

  // 空装配顺序回退到距离排序
  const emptyOrder = sortPartsForDisassembly(parts, []);
  assertEqual(emptyOrder[0].name, "远", "空装配顺序回退距离降序");

  // 不修改原数组
  const original = [makePart("a", 1), makePart("b", 2)];
  const result = sortPartsForDisassembly(original);
  assertEqual(original[0].name, "a", "原数组未被修改");
  assert(result !== original, "返回新数组");

  // 使用 partCenter 而非 homePos
  const partsWithCenter = [
    { name: "A", homePos: { length: () => 10 }, partCenter: { length: () => 1 } },
    { name: "B", homePos: { length: () => 1 }, partCenter: { length: () => 10 } },
  ];
  const centerSorted = sortPartsForDisassembly(partsWithCenter);
  assertEqual(centerSorted[0].name, "B", "优先使用 partCenter 的距离");
});

// ── computeExplodeVector ──
describe("computeExplodeVector 爆炸方向计算", () => {
  // 远离中心的部件：沿径向向外
  const radial = computeExplodeVector({ x: 3, y: 0, z: 0 }, 0, 4);
  assert(radial.x > 0, "右侧部件爆炸方向向右");
  assertApprox(radial.y, 0, 1e-10, "右侧部件 y 方向无偏移");
  assertApprox(radial.z, 0, 1e-10, "右侧部件 z 方向无偏移");
  assert(radial.x >= 1.0, "爆炸距离至少为 1.0");

  // 中心部件（距离 < 0.001）：均匀角度分布
  const center0 = computeExplodeVector({ x: 0, y: 0, z: 0 }, 0, 4);
  const center1 = computeExplodeVector({ x: 0, y: 0, z: 0 }, 1, 4);
  const center2 = computeExplodeVector({ x: 0, y: 0, z: 0 }, 2, 4);
  assert(center0.x !== center1.x || center0.y !== center1.y, "不同索引的中心部件方向不同");
  assertApprox(Math.sqrt(center0.x ** 2 + center0.y ** 2), 1.0, 1e-10, "中心部件爆炸距离 = 1.0");
  assertApprox(Math.sqrt(center1.x ** 2 + center1.y ** 2), 1.0, 1e-10, "中心部件爆炸距离 = 1.0");

  // 距离 * 3 > 1.0 时，使用实际距离 * 3
  const farPart = computeExplodeVector({ x: 0, y: 2, z: 0 }, 0, 1);
  assertApprox(farPart.y, 6.0, 1e-10, "距离2*3=6 的爆炸距离");

  // 负方向
  const negPart = computeExplodeVector({ x: -4, y: 0, z: 0 }, 0, 1);
  assert(negPart.x < 0, "左侧部件爆炸方向向左");

  // 三维方向
  const diagPart = computeExplodeVector({ x: 1, y: 1, z: 1 }, 0, 1);
  assert(diagPart.x > 0 && diagPart.y > 0 && diagPart.z > 0, "对角线部件沿对角线爆炸");
  const dist = Math.sqrt(diagPart.x ** 2 + diagPart.y ** 2 + diagPart.z ** 2);
  assertApprox(dist, Math.sqrt(3) * 3, 1e-10, "对角线爆炸距离 = sqrt(3) * 3");
});

// ===== 结果汇总 =====
console.log("\n" + "═".repeat(60));
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed === 0) {
  console.log("  ✅ 全部测试通过！");
} else {
  console.log("  ❌ 有测试失败！");
  console.log("\n  失败项:");
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log("═".repeat(60));

process.exit(failed > 0 ? 1 : 0);
