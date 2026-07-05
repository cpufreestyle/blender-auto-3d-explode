#!/usr/bin/env node
/**
 * 端到端自动化测试
 *
 * 测试流程：
 *   1. 健康检查 — 验证 Blender 后端可用
 *   2. 上传 Quest3.glb — 验证返回 15 个部位
 *   3. 验证每个部位名称与 QUEST3_PART_TEMPLATES 一致
 *   4. 验证 GLB 二进制响应可正常解析
 *
 * 用法：
 *   node tests/e2e-test.mjs
 *   SERVER_URL=http://localhost:3001 node tests/e2e-test.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const PROJECT_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${message}: ${actual}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}: 期望 ${expected}, 实际 ${actual}`);
    failed++;
  }
}

/**
 * GET 请求工具
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

/**
 * POST multipart/form-data 上传文件
 * 返回二进制响应 + 头信息
 */
function uploadFile(url, filePath, fieldName = 'file') {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 600000,
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, buffer, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.write(body);
    req.end();
  });
}

// 加载预期部位名称
function loadExpectedPartNames() {
  const configPath = path.join(PROJECT_ROOT, 'quest3_config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg.parts.map(p => p.name);
  } catch {
    // 回退到硬编码
    return [
      '主机身', '前面板', '面罩海绵',
      '左透镜模组', '右透镜模组', '左透镜', '右透镜',
      '主板', '左摄像头', '右摄像头', '中置摄像头',
      '下置追踪摄像头', '左头带臂', '右头带臂', '头带',
    ];
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  🧪 Quest 3 拆解端到端测试');
  console.log(`  📡 服务器: ${SERVER_URL}`);
  console.log('═'.repeat(60));

  // ── 测试 1: 健康检查 ──
  console.log('\n📋 测试 1: 健康检查');
  try {
    const resp = await httpGet(`${SERVER_URL}/api/health`);
    assertEqual(resp.status, 200, '健康检查状态码');

    const data = JSON.parse(resp.body);
    assert(data.status === 'ok', `Blender 状态: ${data.status}`);
    assert(data.version !== 'unknown', `Blender 版本: ${data.version}`);

    if (data.status !== 'ok') {
      console.error('  ⚠️ Blender 不可用，跳过拆解测试');
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  结果: ${passed} 通过, ${failed} 失败`);
      console.log('═'.repeat(60));
      process.exit(failed > 0 ? 1 : 0);
    }
  } catch (err) {
    console.error(`  ❌ 健康检查失败: ${err.message}`);
    console.error('  请确保服务器已启动: node server.js');
    process.exit(1);
  }

  // ── 测试 2: 上传 Quest3.glb 并拆解 ──
  console.log('\n📋 测试 2: 上传 Quest3.glb 拆解');
  const glbPath = path.join(PROJECT_ROOT, 'meta-quest-3', 'source', 'Quest3.glb');
  assert(fs.existsSync(glbPath), `测试文件存在: ${glbPath}`);

  if (!fs.existsSync(glbPath)) {
    console.error('  ⚠️ 测试文件不存在，跳过拆解测试');
    process.exit(1);
  }

  const expectedNames = loadExpectedPartNames();
  console.log(`  期望部位数: ${expectedNames.length}`);

  try {
    const resp = await uploadFile(`${SERVER_URL}/api/split`, glbPath);
    assertEqual(resp.status, 200, '拆解请求状态码');

    // 检查二进制响应头
    const successHeader = resp.headers['x-success'];
    assert(successHeader === 'true', 'X-Success 头为 true');

    const totalParts = parseInt(resp.headers['x-total-parts'] || '0');
    const manifestBase64 = resp.headers['x-manifest'] || '';

    assert(totalParts > 0, `返回部件数 > 0: ${totalParts}`);
    assertEqual(totalParts, 15, '返回部件数 = 15');
    assert(manifestBase64.length > 0, 'manifest 头非空');

    // 解析 manifest
    let manifest = null;
    try {
      const manifestJson = Buffer.from(manifestBase64, 'base64').toString('utf-8');
      manifest = JSON.parse(manifestJson);
    } catch (err) {
      assert(false, `manifest 解析失败: ${err.message}`);
    }

    if (manifest) {
      assert(manifest.parts && manifest.parts.length === 15, 'manifest.parts 长度 = 15');

      // ── 测试 3: 验证部位名称 ──
      console.log('\n📋 测试 3: 验证部位名称');
      const actualNames = manifest.parts.map(p => p.display_name || p.name);
      console.log(`  实际部位: ${actualNames.join(', ')}`);

      for (const expectedName of expectedNames) {
        assert(
          actualNames.includes(expectedName),
          `部位 "${expectedName}" 存在`
        );
      }

      // ── 测试 4: 验证 GLB 二进制数据 ──
      console.log('\n📋 测试 4: 验证 GLB 二进制数据');
      const glbBuffer = resp.buffer;
      assert(glbBuffer.length > 0, `GLB 数据非空: ${glbBuffer.length} bytes`);

      // GLB 文件头检查：magic = 0x46546C67 ('glTF')
      const magic = glbBuffer.readUInt32LE(0);
      assertEqual(magic, 0x46546C67, 'GLB magic header');

      // GLB 版本检查
      const version = glbBuffer.readUInt32LE(4);
      assertEqual(version, 2, 'GLB version');

      // GLB 总长度检查
      const totalLength = glbBuffer.readUInt32LE(8);
      assertEqual(totalLength, glbBuffer.length, 'GLB 总长度匹配');
    }

  } catch (err) {
    console.error(`  ❌ 拆解测试失败: ${err.message}`);
    failed++;
  }

  // ── 结果汇总 ──
  console.log('\n' + '═'.repeat(60));
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed === 0) {
    console.log('  ✅ 全部测试通过！');
  } else {
    console.log('  ❌ 有测试失败！');
  }
  console.log('═'.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试运行错误:', err);
  process.exit(1);
});
