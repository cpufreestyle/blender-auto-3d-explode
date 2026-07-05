/**
 * 快速测试脚本 — 检查 Blender + 直接调用拆解脚本
 * 运行: node scripts/quick_test.mjs
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'quick_test_result.txt');

let out = '';
const w = (s) => { out += s + '\n'; console.log(s); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

function httpPostFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----B' + Math.random().toString(36).slice(2);
    const fileBuf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: model/gltf-binary\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuf, footer]);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

async function main() {
  w('========================================');
  w('  快速测试 ' + new Date().toLocaleString());
  w('========================================\n');

  // 1. 检查 Blender
  w('--- 1. 检查 Blender ---');
  const blenderPaths = [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/local/bin/blender',
    '/usr/bin/blender',
  ];
  let blenderPath = null;
  for (const p of blenderPaths) {
    if (fs.existsSync(p)) { blenderPath = p; break; }
  }
  if (!blenderPath) {
    try {
      execFileSync('which', ['blender'], { timeout: 5000 });
      blenderPath = 'blender';
    } catch { /* not in PATH */ }
  }

  if (blenderPath) {
    w(`  ✅ Blender: ${blenderPath}`);
    try {
      const ver = execFileSync(blenderPath, ['--version'], { timeout: 10000, encoding: 'utf-8' });
      const m = ver.match(/Blender ([\d.]+)/);
      w(`  版本: ${m ? m[1] : 'unknown'}`);
    } catch (e) {
      w(`  版本检查失败: ${e.message}`);
    }
  } else {
    w('  ❌ Blender 未安装');
  }

  // 2. 检查模型
  w('\n--- 2. 检查模型 ---');
  const modelPath = path.join(ROOT, 'models', 'Quest3.glb');
  if (fs.existsSync(modelPath)) {
    const sz = fs.statSync(modelPath).size;
    w(`  ✅ ${modelPath} (${(sz/1024).toFixed(1)} KB)`);
  } else {
    w('  ❌ 模型不存在');
    fs.writeFileSync(OUT, out, 'utf-8');
    return;
  }

  // 3. 启动服务器
  w('\n--- 3. 启动服务器 ---');
  const serverProc = spawn('node', [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let srvOut = '';
  serverProc.stdout.on('data', d => srvOut += d);
  serverProc.stderr.on('data', d => srvOut += d);

  w('  等待 4 秒...');
  await sleep(4000);
  w('  服务器输出:');
  srvOut.split('\n').forEach(l => { if (l.trim()) w('    ' + l); });

  // 4. 测试 health
  w('\n--- 4. 测试 /api/health ---');
  try {
    const r = await httpGet('http://localhost:3001/api/health');
    w(`  HTTP ${r.status}`);
    const h = JSON.parse(r.body);
    w(`  status: ${h.status}`);
    w(`  blender: ${h.blender}`);
    w(`  version: ${h.version}`);
    w(`  message: ${h.message}`);
  } catch (e) {
    w(`  ❌ ${e.message}`);
  }

  // 5. 测试 split
  w('\n--- 5. 测试 /api/split ---');
  if (blenderPath) {
    w('  发送 Quest3.glb 进行拆解...');
    w('  (Blender 处理中，请等待...)');
    try {
      const r = await httpPostFile('http://localhost:3001/api/split', modelPath);
      w(`  HTTP ${r.status}`);
      const data = JSON.parse(r.body);
      if (data.success) {
        w(`  ✅ 拆解成功！`);
        w(`  总部件数: ${data.total_parts}`);
        w(`  耗时: ${data.elapsed_seconds}s`);
        w(`  模型中心: ${JSON.stringify(data.model_center)}`);
        w(`  模型尺寸: ${JSON.stringify(data.model_size)}`);
        w(`\n  部件列表:`);
        (data.parts || []).forEach((p, i) => {
          w(`    ${i+1}. ${p.display_name || p.name} | 面数:${p.face_count} | 中心:[${p.center?.map(v=>v.toFixed(2)).join(',')}]`);
        });
        const glbKB = Math.round((data.glb_base64?.length || 0) * 3 / 4 / 1024);
        w(`\n  拆解后 GLB: ${glbKB} KB`);
      } else {
        w(`  ❌ 失败: ${data.error}`);
        if (data.blender_output) w(`  Blender 输出: ${data.blender_output.substring(0, 500)}`);
      }
    } catch (e) {
      w(`  ❌ ${e.message}`);
    }
  } else {
    w('  ⏭️ Blender 不可用，跳过');
  }

  // 6. 关闭
  w('\n--- 6. 关闭服务器 ---');
  serverProc.kill();
  w('  已关闭');

  w('\n========================================');
  w('  测试完成');
  w('========================================');

  fs.writeFileSync(OUT, out, 'utf-8');
  console.log(`\n📄 结果: ${OUT}`);
  process.exit(0);
}

main().catch(e => {
  w(`\n💥 错误: ${e.message}\n${e.stack}`);
  fs.writeFileSync(OUT, out, 'utf-8');
  process.exit(1);
});
