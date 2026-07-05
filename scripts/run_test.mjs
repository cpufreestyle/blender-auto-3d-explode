/**
 * 快速测试拆解 API
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

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
  console.log('═══════════════════════════════════════════');
  console.log('  🧪 测试 GLB 拆解 API');
  console.log('═══════════════════════════════════════════\n');

  // 1. 健康检查
  console.log('━━━ 1. 健康检查 ━━━');
  const health = await new Promise((resolve, reject) => {
    http.get('http://localhost:3001/api/health', (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  console.log(`  status: ${health.status}`);
  console.log(`  blender: ${health.version}`);
  console.log(`  message: ${health.message}`);

  // 2. 拆解测试
  console.log('\n━━━ 2. 拆解 Quest3.glb ━━━');
  const modelPath = path.join(ROOT, 'models', 'Quest3.glb');
  console.log(`  文件: ${modelPath}`);
  console.log(`  大小: ${(fs.statSync(modelPath).size / 1024).toFixed(1)} KB`);
  console.log('  发送中... (Blender 处理需要时间)\n');

  const start = Date.now();
  const resp = await httpPostFile('http://localhost:3001/api/split', modelPath);
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  const data = JSON.parse(resp.body);

  if (data.success) {
    console.log(`  ✅ 拆解成功！(HTTP ${resp.status}, ${elapsed}s)`);
    console.log(`  耗时: ${data.elapsed_seconds}s`);
    console.log(`  总部件数: ${data.total_parts}`);
    console.log(`  模型中心: [${data.model_center.map(v => v.toFixed(3)).join(', ')}]`);
    console.log(`  模型尺寸: [${data.model_size.map(v => v.toFixed(3)).join(', ')}]`);

    console.log('\n  ┌──────── 部件列表 ────────┐');
    const parts = data.parts || [];
    parts.forEach((p, i) => {
      const center = p.center.map(v => v.toFixed(2)).join(', ');
      const size = p.size.map(v => v.toFixed(2)).join(', ');
      console.log(`  │ ${String(i+1).padStart(2)}. ${p.display_name || p.name}`);
      console.log(`  │     面数: ${p.face_count}  顶点: ${p.vertex_count}`);
      console.log(`  │     中心: [${center}]  尺寸: [${size}]`);
    });

    const glbKB = Math.round((data.glb_base64?.length || 0) * 3 / 4 / 1024);
    console.log(`  └────────────────────────────┘`);
    console.log(`\n  拆解后 GLB: ${glbKB} KB`);
  } else {
    console.log(`  ❌ 拆解失败 (HTTP ${resp.status})`);
    console.log(`  错误: ${data.error}`);
    if (data.blender_output) {
      console.log(`\n  Blender 输出:\n${data.blender_output}`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  🏁 测试完成');
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('💥 错误:', err.message);
  process.exit(1);
});
