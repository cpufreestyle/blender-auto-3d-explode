#!/usr/bin/env node
/**
 * 单元测试 — macOS 桌面启动器（scripts/mac/quest3-launcher）
 *
 * 钉住的回归：老启动器用「curl / 有没有响应」判断服务是否已在运行，端口被别的
 * 程序占用时会把别人的页面当成本项目打开——实测 :3001 被 freellmapi 占住后，
 * 双击桌面图标打开的是它的 Vite 脚手架首页，通知还写着「服务已在运行」。
 *
 * 不变量（全部用假服务 + 假 open/osascript 在临时目录里跑真脚本）：
 *   · 端口上是别人的服务：不 open、不抢占、不谎报，退出码 2，日志与告警里报出
 *     占用者的 PID 与命令行；
 *   · 端口上是自己的服务且版本与 package.json 一致：直接复用，只 open 一次；
 *   · 端口上是自己的服务但版本旧：按 /api/identity 给的 PID 只杀自己那个实例，
 *     再拉新实例，就绪后 open；
 *   · stop 只停自己的：端口上是别人的进程时一个都不杀；
 *   · status 三种占用状态各报对，且不动任何进程。
 *
 * 接缝：启动器读 QUEST3_APP_DIR / QUEST3_PORT / QUEST3_LABEL / QUEST3_AGENT_DIR /
 *   QUEST3_LOG_FILE / QUEST3_RUN_DIR / QUEST3_OSA / QUEST3_OPEN_CMD，测试全部指向
 *   临时目录，不碰 ~/Library/LaunchAgents 与 ~/Apps/quest3-exploded。
 *
 * 平台：脚本本身是 macOS 专属（lsof / launchctl / ps -o command=），非 darwin
 *   直接跳过——它守的是桌面端行为，Linux runner 上没有对应语义。
 *
 * 用法：node tests/desktop-launcher-test.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const IS_DARWIN = process.platform === "darwin";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "mac", "quest3-launcher");

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
let passed = 0;
let failed = 0;
const failures = [];

// 同步写 1 号 fd：本用例要跑子进程、还可能让 launchd 拉起服务，console.log 的
// 异步缓冲会把 OK/FAIL 与 describe 标题的顺序打乱，读数就不可信了。
function emit(text) {
  fs.writeSync(1, text);
}

function assert(condition, message) {
  if (condition) {
    emit(`  OK ${message}\n`);
    passed++;
  } else {
    emit(`  FAIL ${message}\n`);
    failed++;
    failures.push(message);
  }
}

// /api/identity 没拿到响应（超时）时值是空串，先记一条明确失败，
// 别让 JSON.parse 抛出来把整个运行打断。
function pidOf(body, message) {
  if (!body) assert(false, `${message}：没拿到响应`);
  try {
    return JSON.parse(body || "{}").pid || 0;
  } catch {
    assert(false, `${message}：响应不是合法 JSON`);
    return 0;
  }
}

function versionOf(body) {
  try {
    return JSON.parse(body || "{}").version;
  } catch {
    return undefined;
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
// it 只登记用例，不自己执行。describe 的函数体是同步调用 it(...) 的，外部也不 await
// 它，所以老写法（it 里 await fn）会让全部用例同时开跑：这些用例都要独占同一个测试
// 端口和同一套夹具，并行跑就是互相把对方的服务杀掉、assert 输出顺序全乱，用例抛的
// 异常还会变成未被捕获的 rejection 直接把进程打挂。执行时机统一交给下面的 runner。
const caseQueue = [];
function it(name, fn) {
  caseQueue.push({ name, fn });
}

// ===== 夹具 =====
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "q3-launcher-test-"));
const BIN_DIR = path.join(TMP_ROOT, "bin");
const OPEN_LOG = path.join(TMP_ROOT, "open.log");
const OSA_LOG = path.join(TMP_ROOT, "osa.log");
const LOG_FILE = path.join(TMP_ROOT, "launcher.log");
const RUN_DIR = path.join(TMP_ROOT, "run");
const AGENT_DIR = path.join(TMP_ROOT, "agents");
const APP_DIR = path.join(TMP_ROOT, "appdir");
const STUB_SERVER = path.join(APP_DIR, "server.js");
const STUB_VERSION_FILE = path.join(APP_DIR, "stub-version.txt");

const PORT = 3457;
const LABEL = "com.cpufreestyle.quest3exploded.test";
const OWN_APP_ID = "blender-auto-3d-explode";
const FOREIGN_APP_ID = "freellmapi";
const EXPECTED_VERSION = "3.3.3"; // 与 appdir/package.json 一致 = 已是最新

const spawned = []; // 测试拉起的假服务，收尾统一清

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

function truncateLog(file) {
  fs.writeFileSync(file, "");
}

function readLog(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 假服务：/api/identity 按 STUB_APP / STUB_VERSION（或同目录 stub-version.txt）
// 回身份，其余路径一律 200 HTML —— 老启动器只看「端口有没有响应」，正好会被它骗到。
const STUB_SOURCE = [
  "const http = require(\"http\");",
  "const fs = require(\"fs\");",
  "const path = require(\"path\");",
  "const port = Number(process.env.PORT);",
  "const app = process.env.STUB_APP || \"blender-auto-3d-explode\";",
  "const name = process.env.STUB_NAME || \"stub\";",
  "let version = process.env.STUB_VERSION;",
  "if (!version) {",
  "  try {",
  "    version = fs.readFileSync(path.join(__dirname, \"stub-version.txt\"), \"utf8\").trim();",
  "  } catch { version = \"0.0.1\"; }",
  "}",
  "http.createServer((req, res) => {",
  "  if (req.url === \"/api/identity\") {",
  "    res.writeHead(200, { \"Content-Type\": \"application/json\" });",
  "    res.end(JSON.stringify({ app, name, version, pid: process.pid, port }));",
  "    return;",
  "  }",
  "  res.writeHead(200, { \"Content-Type\": \"text/html\" });",
  "  res.end(\"<html><title>stub</title></html>\");",
  "}).listen(port, \"127.0.0.1\", () => console.log(\"stub listening \" + port));",
  "",
].join("\n");

function setupFixtures() {
  writeFile(STUB_SERVER, STUB_SOURCE);
  writeFile(STUB_VERSION_FILE, EXPECTED_VERSION);
  writeFile(path.join(APP_DIR, "package.json"), JSON.stringify({ version: EXPECTED_VERSION }));
  // 预置 undici 标记，避免 ensure_deps 真去仓库拷贝一份
  writeFile(path.join(APP_DIR, "node_modules", "undici", "package.json"), "{}");
  // 假 open / 假 osascript：只追加记录，不真的开浏览器、不弹通知
  writeFile(
    path.join(BIN_DIR, "open"),
    "#!/bin/bash\n" + `printf '%s\\n' "$*" >> ${JSON.stringify(OPEN_LOG)}\n`,
    0o755,
  );
  writeFile(
    path.join(BIN_DIR, "osa"),
    "#!/bin/bash\n" + `printf '%s\\n' "$*" >> ${JSON.stringify(OSA_LOG)}\n`,
    0o755,
  );
  truncateLog(OPEN_LOG);
  truncateLog(OSA_LOG);
  truncateLog(LOG_FILE);
}

function launcherEnv(extra = {}) {
  return {
    ...process.env,
    QUEST3_APP_DIR: APP_DIR,
    QUEST3_PORT: String(PORT),
    QUEST3_LABEL: LABEL,
    QUEST3_AGENT_DIR: AGENT_DIR,
    QUEST3_LOG_FILE: LOG_FILE,
    QUEST3_RUN_DIR: RUN_DIR,
    QUEST3_OSA: path.join(BIN_DIR, "osa"),
    QUEST3_OPEN_CMD: path.join(BIN_DIR, "open"),
    ...extra,
  };
}

function runLauncher(args = [], extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn("bash", [LAUNCHER, ...args], {
      env: launcherEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function startStub(extraEnv = {}) {
  const child = spawn(process.execPath, [STUB_SERVER], {
    env: { ...process.env, PORT: String(PORT), ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
  });
  spawned.push(child);
  return child;
}

// 轮询 /api/identity，直到 predicate 成立或超时
async function waitForIdentity(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let body = "";
    try {
      body = await new Promise((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: PORT, path: "/api/identity", timeout: 1000 },
          res => {
            let data = "";
            res.on("data", c => (data += c));
            res.on("end", () => resolve(data));
          },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
      });
    } catch {
      body = "";
    }
    if (body && predicate(body)) return body;
    await sleep(150);
  }
  return "";
}

async function waitForPortFree(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let busy = true;
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: PORT, path: "/", timeout: 1000 },
          () => resolve(),
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
      });
    } catch {
      busy = false;
    }
    if (!busy) return true;
    await sleep(150);
  }
  return false;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 身份没拿到时 pidOf 回 0，而 kill(0) 是射杀整个进程组，会把测试自己带走。
// 收尾一律走这里，非正整数直接跳过。
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

async function killPortOccupant() {
  const body = await waitForIdentity(() => true, 1000).catch(() => "");
  if (!body) return;
  try {
    const { pid } = JSON.parse(body);
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    /* 占用者不是我们能解析的身份，交给最终清理 */
  }
}

// ===== 用例 =====

describe("端口被别的程序占用", () => {
  it("拒绝打开别人的页面，退出码 2 并报出占用者", async() => {
    if (!IS_DARWIN) return;
    setupFixtures();
    const foreign = startStub({
      STUB_APP: FOREIGN_APP_ID,
      STUB_NAME: "FreeLLM API",
      STUB_VERSION: "9.9.9",
    });
    const body = await waitForIdentity(b => b.includes(FOREIGN_APP_ID));
    assert(body.includes(FOREIGN_APP_ID), "假的外部服务已在端口上响应身份");
    const foreignPid = pidOf(body, "身份响应");

    truncateLog(OPEN_LOG);
    truncateLog(OSA_LOG);
    truncateLog(LOG_FILE);

    const { code } = await runLauncher();
    const openCalls = readLog(OPEN_LOG).trim();
    const osaCalls = readLog(OSA_LOG);
    const log = readLog(LOG_FILE);

    assert(code === 2, `退出码为 2（实际 ${code}）`);
    assert(openCalls === "", `没有调用 open 打开别人的页面（实际：${openCalls || "无"}）`);
    assert(
      osaCalls.includes("无法启动") && osaCalls.includes("已拒绝打开该页面"),
      "弹了告警说明拒绝打开",
    );
    assert(
      log.includes("occupied by a foreign process") && log.includes(String(foreignPid)),
      "日志记下占用进程 PID 与命令行",
    );
    assert(pidAlive(foreignPid), "没有杀别人的进程");
    killPid(foreignPid);
    await waitForPortFree();
  });
});

describe("端口上是自己的服务", () => {
  it("版本一致时直接复用，只开一次浏览器", async() => {
    if (!IS_DARWIN) return;
    setupFixtures();
    writeFile(STUB_VERSION_FILE, EXPECTED_VERSION);
    const own = startStub();
    const body = await waitForIdentity(b => b.includes(OWN_APP_ID));
    assert(body.includes(OWN_APP_ID), "自己的服务已在端口上响应身份");
    const ownPid = pidOf(body, "身份响应");

    truncateLog(OPEN_LOG);
    truncateLog(OSA_LOG);
    truncateLog(LOG_FILE);

    const { code } = await runLauncher();
    const openCalls = readLog(OPEN_LOG).trim().split("\n")
      .filter(Boolean);

    assert(code === 0, `退出码为 0（实际 ${code}）`);
    assert(openCalls.length === 1, `只调用一次 open（实际 ${openCalls.length} 次）`);
    assert(readLog(OSA_LOG).includes("已在运行"), "通知说明是复用已在运行的服务");
    assert(pidAlive(ownPid), "没有重启已在运行的同版本实例");
    killPid(ownPid);
    await waitForPortFree();
  });

  it("版本过期时只杀自己那个实例，再拉新实例", async() => {
    if (!IS_DARWIN) return;
    setupFixtures();
    writeFile(STUB_VERSION_FILE, EXPECTED_VERSION);
    const stale = startStub({ STUB_VERSION: "3.3.2" });
    const body = await waitForIdentity(b => b.includes(OWN_APP_ID));
    assert(body.includes(OWN_APP_ID), "旧的自己的服务已在端口上响应身份");
    const stalePid = pidOf(body, "身份响应");

    truncateLog(OPEN_LOG);
    truncateLog(OSA_LOG);
    truncateLog(LOG_FILE);

    const { code } = await runLauncher();
    const openCalls = readLog(OPEN_LOG).trim().split("\n")
      .filter(Boolean);
    const after = await waitForIdentity(b => b.includes(OWN_APP_ID), 15000);

    assert(code === 0, `退出码为 0（实际 ${code}）`);
    assert(!pidAlive(stalePid), "旧的自己的实例已被停掉");
    assert(after.includes(OWN_APP_ID), "新实例已在同一端口上的就绪");
    assert(
      versionOf(after) === EXPECTED_VERSION,
      `新实例版本是 ${EXPECTED_VERSION}（实际 ${versionOf(after)}）`,
    );
    assert(openCalls.length === 1, `只调用一次 open（实际 ${openCalls.length} 次）`);
    await killPortOccupant();
    await waitForPortFree();
  });
});

describe("stop 与 status", () => {
  it("stop 不碰端口上的别人进程", async() => {
    if (!IS_DARWIN) return;
    setupFixtures();
    const foreign = startStub({ STUB_APP: FOREIGN_APP_ID, STUB_NAME: "FreeLLM API" });
    const body = await waitForIdentity(b => b.includes(FOREIGN_APP_ID));
    const foreignPid = pidOf(body, "身份响应");

    const { code } = await runLauncher(["stop"]);
    assert(code === 0, `stop 退出码为 0（实际 ${code}）`);
    assert(pidAlive(foreignPid), "端口上是别人的进程时，stop 一个都不杀");
    killPid(foreignPid);
    await waitForPortFree();
  });

  it("stop 停掉自己的服务", async() => {
    if (!IS_DARWIN) return;
    setupFixtures();
    const own = startStub();
    const body = await waitForIdentity(b => b.includes(OWN_APP_ID));
    const ownPid = pidOf(body, "身份响应");

    const { code } = await runLauncher(["stop"]);
    assert(code === 0, `stop 退出码为 0（实际 ${code}）`);
    assert(!pidAlive(ownPid), "自己的实例已被停掉");
    await waitForPortFree();
  });

  it("status 三种占用状态各报对", async() => {
    if (!IS_DARWIN) return;
    setupFixtures();

    const free = await runLauncher(["status"]);
    assert(free.code === 0, "空闲时 status 退出码为 0");
    assert(free.stdout.includes("空闲"), "空闲时报告端口空闲");

    startStub({ STUB_APP: FOREIGN_APP_ID, STUB_NAME: "FreeLLM API" });
    const body = await waitForIdentity(b => b.includes(FOREIGN_APP_ID));
    const foreignPid = pidOf(body, "身份响应");
    const foreignStatus = await runLauncher(["status"]);
    assert(foreignStatus.stdout.includes("被其他程序占用"), "有别人占用时如实报告");
    assert(foreignStatus.stdout.includes("本服务未运行"), "并说明本服务未在运行");

    const before = readLog(OPEN_LOG);
    // 同一端口只能有一个监听者：先让外部服务退位，再换成自己的。
    // 别提前起 stub——端口还被占着，它只会 EADDRINUSE 直接退出。
    killPid(foreignPid);
    await waitForPortFree();
    const own2 = startStub();
    const ownBody = await waitForIdentity(b => b.includes(OWN_APP_ID));
    assert(ownBody.includes(OWN_APP_ID), "自己的服务已在端口上响应身份");
    const ownStatus = await runLauncher(["status"]);
    assert(ownStatus.stdout.includes("本服务正在运行"), "自己占用时如实报告在运行");
    assert(readLog(OPEN_LOG) === before, "status 不打开浏览器");
    await killPortOccupant();
    await waitForPortFree();
  });
});

// ===== 收尾 =====
async function cleanup() {
  for (const child of spawned) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  await killPortOccupant();
  if (IS_DARWIN) {
    // 用例里可能经 launchd 拉起过测试 label 的实例，这里卸掉
    try {
      spawn("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], {
        stdio: "ignore",
      });
    } catch {
      /* 没有加载过 */
    }
  }
}

// 异常/超时打断也要收干净：残留的假服务占住端口，会把下一次运行整体带偏
function emergencyCleanup() {
  for (const child of spawned) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  if (IS_DARWIN) {
    try {
      // 启动器拉起的实例不在 spawned 里，必须单独卸载
      spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], {
        stdio: "ignore",
      });
    } catch {
      /* 没加载过 */
    }
  }
}
process.on("exit", emergencyCleanup);

function portBusy() {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

(async() => {
  if (!IS_DARWIN) {
    emit("SKIP 桌面启动器测试：仅 macOS（当前 " + process.platform + "）\n");
    process.exit(0);
  }
  const busy = portBusy();
  if (busy) {
    emit(`\u524d\u7f6e\u68c0\u67e5\u5931\u8d25\uff1a\u6d4b\u8bd5\u7aef\u53e3 ${PORT} 已被占用（PID ${busy}），先清干净再跑。\n`);
    process.exit(1);
  }
  setupFixtures();
  let crashed = null;
  try {
    for (const { name, fn } of describeQueue) {
      emit(`\n${name}\n`);
      caseQueue.length = 0;
      await fn();
      const cases = caseQueue.slice();
      caseQueue.length = 0;
      for (const { name: caseName, fn: caseFn } of cases) {
        emit(`▶ ${caseName}\n`);
        try {
          await caseFn();
        } catch (err) {
          // 单个用例抛异常不该打断后面的用例，更不该变成 unhandledRejection
          assert(false, "用例抛异常：" + ((err && err.message) || err));
        }
      }
    }
  } catch (err) {
    crashed = err;
  }
  await cleanup();
  if (crashed) {
    emit(`\n\u6267\u884c\u88ab\u5f02\u5e38\u6253\u65ad\uff1a${(crashed && crashed.message) || crashed}\n`);
    process.exit(1);
  }
  emit(`\n\u5171 ${passed} 断言通过，${failed} 失败\n`);
  if (failed > 0) {
    emit("失败项：\n");
    for (const f of failures) emit("  - " + f + "\n");
    process.exit(1);
  }
})();
