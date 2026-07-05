import http from 'http';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATUS_FILE = path.join(ROOT, 'server_status.txt');

// Kill old process
try { execSync('lsof -ti :3001 | xargs kill -9 2>/dev/null', { timeout: 5000 }); } catch {}

// Start backend
const log = [];
log.push('Starting backend server...');
const server = spawn('node', ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  detached: false,
});

server.stdout.on('data', (d) => log.push(`[server] ${d.toString().trim()}`));
server.stderr.on('data', (d) => log.push(`[server-err] ${d.toString().trim()}`));

// Wait 4 seconds then check
setTimeout(() => {
  log.push('Checking backend...');
  http.get('http://localhost:3001/api/health', (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      log.push(`Backend response: ${d}`);
      log.push('BACKEND=OK');
      
      // Check frontend
      http.get('http://localhost:8080/', (res2) => {
        log.push(`Frontend: HTTP ${res2.statusCode}`);
        log.push('FRONTEND=OK');
        log.push('URL_TEST=http://localhost:8080/test-blender-split.html');
        log.push('URL_APP=http://localhost:8080/index.html');
        fs.writeFileSync(STATUS_FILE, log.join('\n'), 'utf-8');
        // Don't exit - keep server running
        server.unref();
        process.exit(0);
      }).on('error', (e) => {
        log.push(`Frontend: DOWN - ${e.message}`);
        log.push('FRONTEND=DOWN');
        log.push('HINT=Run: npx serve . -l 8080');
        fs.writeFileSync(STATUS_FILE, log.join('\n'), 'utf-8');
        server.unref();
        process.exit(0);
      });
    });
  }).on('error', (e) => {
    log.push(`Backend: DOWN - ${e.message}`);
    log.push('BACKEND=DOWN');
    fs.writeFileSync(STATUS_FILE, log.join('\n'), 'utf-8');
    process.exit(1);
  });
}, 4000);
