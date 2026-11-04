#!/usr/bin/env node
/**
 * 单元测试 — 身份端点契约（server.js 的 /api/identity）
 *
 * 桌面启动器 scripts/mac/quest3-launcher 靠这个端点判断端口上监听的是不是
 * 本项目（端口被别的程序占用时不打开它的页面、不误报「服务已在运行」）。
 * 本测试钉住字段契约：app/version/pid/port 四字段齐全，且 app 值与启动器
 * 里的 APP_ID 一致（两边不一致时启动器会把自家服务当外人）。
 *
 * 用法：node tests/identity-test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const ROUTES_IDENTITY_SRC = fs.readFileSync(path.join(ROOT, "src/routes-identity.js"), "utf8");
const LAUNCHER_SRC = fs.readFileSync(path.join(ROOT, "scripts/mac/quest3-launcher"), "utf8");

let passed = 0;
let failed = 0;
const failures = [];
function assert(condition, message) {
  if (condition) { console.log("  OK " + message); passed++; }
  else { console.error("  FAIL " + message); failed++; failures.push(message); }
}
const describeQueue = [];
function describe(name, fn) { describeQueue.push({ name, fn }); }
function it(_name, fn) { return fn(); }

const APP_ID = "blender-auto-3d-explode";
const IDENTITY_ROUTE = "url.pathname === \"/api/identity\"";

describe("/api/identity 契约", () => {
  it("server.js 注册 identity 路由且调 handleIdentity", () => {
    assert(SERVER_SRC.includes(IDENTITY_ROUTE), "GET /api/identity 路由已注册");
    assert(SERVER_SRC.includes("await handleIdentity(req, res);"), "路由调 handleIdentity");
  });

  it("handleIdentity 返回 app/version/pid/port 四字段", () => {
    // main 侧重构后实现迁至 src/routes-identity.js（server.js 只注册路由）
    assert(ROUTES_IDENTITY_SRC.includes("app: APP_ID"), "响应含 app: APP_ID");
    for (const key of ["version:", "pid:", "port:"]) {
      assert(ROUTES_IDENTITY_SRC.includes(key), "响应含 " + key);
    }
    assert(ROUTES_IDENTITY_SRC.includes("export const APP_ID = \"" + APP_ID + "\""), "APP_ID 与启动器约定一致");
  });

  it("启动器按身份判定端口归属，不误开别人的页面", () => {
    assert(LAUNCHER_SRC.includes("APP_ID=\"" + APP_ID + "\""), "启动器 APP_ID 与 server 一致");
    assert(LAUNCHER_SRC.includes("/api/identity"), "启动器查询 identity 端点");
    assert(LAUNCHER_SRC.includes("is_own_service"), "启动器有 is_own_service 判定");
    assert(LAUNCHER_SRC.includes("report_foreign_occupant"), "端口被占用时拒绝打开");
  });

  it("启动器指向当前工作区与快捷方式端口", () => {
    assert(
      LAUNCHER_SRC.includes("$HOME/AI Shared/repo/quest3-exploded"),
      "APP_DIR 指向本仓库工作区",
    );
    assert(LAUNCHER_SRC.includes("QUEST3_PORT:-3011"), "默认端口 3011");
  });
});

(async() => {
  for (const item of describeQueue) {
    console.log("\n──── " + item.name);
    await item.fn();
  }
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
