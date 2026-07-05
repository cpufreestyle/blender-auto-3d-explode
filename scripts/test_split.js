/**
 * 自动化测试脚本 — 检查 Blender + 启动服务器 + 测试拆解
 * 运行: node scripts/test_split.js
 * 结果输出到: test_output.txt
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'test_output.txt');

const BLENDER_CANDIDATES = [
  '/Applications/Blender.app/Contents/MacOS/Blender',
  '/usr/bin/blender',
  '/usr/local/bin/blender',
];

let output = '';

function log(msg) {
  output += msg + '\n';
  console.log(msg);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 查找 Blender
 */
async function findBlender() {
  for (const p of BLENDER_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        const { stdout } = await execFileAsync(p, ['--version'], { timeout: 10000 });
        const version = stdout.match(/Blender ([\d.]+)/)?.[1] || 'unknown';
        return { path: p, version };
      }
    } catch { /* try next */ }
  }
  // 尝试 PATH
  try {
    const { stdout } = await execFileAsync('blender', ['--version'], { timeout: 10000 });
    const version = stdout.match(/Blender ([\d.]+)/)?.[1] || 'unknown';
    return { path: 'blender', version };
  } catch {
    return null;
  }
}

/**
 * HTTP GET 请求
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

/**
 * HTTP POST multipart/form-data
 */
function httpPostFile(url, filePath, fieldName = 'file') {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // 构建 multipart body
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: model/gltf-binary\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

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
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Request timeout (120s)'));
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  log('═══════════════════════════════════════════════════');
  log('  🧪 GLB 拆解自动化测试');
  log('  ' + new Date().toLocaleString());
  log('═══════════════════════════════════════════════════\n');

  // 1. 检查 Node.js
  log('━━━ 1. 检查 Node.js ━━━');
  const { stdout: nodeVer } = await execFileAsync('node', ['--version']);
  log(`  Node.js 版本: ${nodeVer.trim()}`);

  // 2. 检查 Blender
  log('\n━━━ 2. 检查 Blender ━━━');
  const blender = await findBlender();
  if (blender) {
    log(`  ✅ Blender ${blender.version}`);
    log(`  路径: ${blender.path}`);
  } else {
    log('  ❌ Blender 未安装');
    log('  前端将自动回退到 JS 拆解模式');
  }

  // 3. 检查测试模型
  log('\n━━━ 3. 检查测试模型 ━━━');
  const modelPath = path.join(PROJECT_ROOT, 'models', 'Quest3.glb');
  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath);
    log(`  ✅ ${modelPath}`);
    log(`  大小: ${(stat.size / 1024).toFixed(1)} KB`);
  } else {
    log('  ❌ 测试模型不存在');
    // 写入结果并退出
    fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
    return;
  }

  // 4. 启动服务器
  log('\n━━━ 4. 启动服务器 ━━━');
  const serverPath = path.join(PROJECT_ROOT, 'server.js');
  const serverProc = spawn('node', [serverPath], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let serverOutput = '';
  serverProc.stdout.on('data', (d) => serverOutput += d.toString());
  serverProc.stderr.on('data', (d) => serverOutput += d.toString());

  log('  等待服务器启动...');
  await sleep(3000);
  log('  服务器输出:');
  serverOutput.split('\n').forEach(line => {
    if (line.trim()) log(`    ${line}`);
  });

  // 5. 测试 health 端点
  log('\n━━━ 5. 测试 /api/health ━━━');
  try {
    const resp = await httpGet('http://localhost:3001/api/health');
    log(`  HTTP ${resp.status}`);
    const health = JSON.parse(resp.body);
    log(`  status: ${health.status}`);
    log(`  blender: ${health.blender}`);
    log(`  version: ${health.version}`);
    log(`  message: ${health.message}`);
  } catch (err) {
    log(`  ❌ 健康检查失败: ${err.message}`);
  }

  // 6. 测试 split 端点
  log('\n━━━ 6. 测试 /api/split（Blender 拆解）━━━');
  if (blender) {
    log(`  发送 ${path.basename(modelPath)} 到 /api/split...`);
    log('  (Blender 处理中，请耐心等待...)');
    try {
      const resp = await httpPostFile('http://localhost:3001/api/split', modelPath);
      log(`  HTTP ${resp.status}`);

      const data = JSON.parse(resp.body);
      if (data.success) {
        log(`  ✅ 拆解成功！`);
        log(`  总部件数: ${data.total_parts}`);
        log(`  耗时: ${data.elapsed_seconds}s`);
        log(`  模型中心: [${data.model_center?.map(v => v.toFixed(3)).join(', ')}]`);
        log(`  模型尺寸: [${data.model_size?.map(v => v.toFixed(3)).join(', ')}]`);
        log(`\n  部件列表:`);
        const parts = data.parts || [];
        parts.forEach((p, i) => {
          log(`    ${i + 1}. ${p.display_name || p.name}`);
          log(`       中心: [${p.center?.map(v => v.toFixed(3)).join(', ')}]`);
          log(`       面数: ${p.face_count} | 顶点: ${p.vertex_count}`);
          log(`       尺寸: [${p.size?.map(v => v.toFixed(3)).join(', ')}]`);
        });
        const glbSize = Math.round((data.glb_base64?.length || 0) * 3 / 4);
        log(`\n  拆解后 GLB 大小: ${(glbSize / 1024).toFixed(1)} KB`);
      } else {
        log(`  ❌ 拆解失败: ${data.error}`);
      }
    } catch (err) {
      log(`  ❌ 请求失败: ${err.message}`);
    }
  } else {
    log('  ⏭️  Blender 不可用，跳过拆解测试');
    log('  前端会自动回退到 JS 连通分量拆解');
  }

  // 7. 关闭服务器
  log('\n━━━ 7. 关闭服务器 ━━━');
  serverProc.kill();
  log('  服务器已关闭');

  log('\n═══════════════════════════════════════════════════');
  log('  🏁 测试完成');
  log('═══════════════════════════════════════════════════\n');

  // 写入文件
  fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
  console.log(`\n📄 结果已写入: ${OUTPUT_FILE}`);

  // 退出
  process.exit(0);
}

main().catch(err => {
  log(`\n💥 未捕获错误: ${err.message}`);
  log(err.stack || '');
  fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
  process.exit(1);
});
