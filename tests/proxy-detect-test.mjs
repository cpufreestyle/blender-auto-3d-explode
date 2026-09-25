#!/usr/bin/env node
/**
 * 单元测试 — 零配置代理自动探测（src/proxy-detect.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - 环境变量优先，按 HTTPS_PROXY → HTTP_PROXY → https_proxy → http_proxy 取
 *     第一个非空值；命中即 setGlobalDispatcher(ProxyAgent) 后直接返回，不再扫端口；
 *   - 环境变量 URI 非法时 ProxyAgent 构造抛错被吞掉，只 warn 一行并继续扫端口；
 *   - 端口候选逐个尝试，命中即用 http://<candidate> 建 ProxyAgent 并返回，
 *     后续候选不再探测；
 *   - 候选可达但 ProxyAgent 构造失败时静默继续下一个候选（catch 里是空实现）；
 *   - 全部落空时打印「未检测到本机代理」提示。
 *
 * 可观测面只有两条：console 文案（含选中的 URI）与 getGlobalDispatcher() 是否
 * 变成 ProxyAgent。端口候选经 candidates 参数注入，否则结果取决于开发机上开着
 * 哪个代理，测试无法稳定断言。
 *
 * 用法：node tests/proxy-detect-test.mjs
 */

import net from "node:net";
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { detectProxy } from "../src/proxy-detect.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致，describe 内 await it 串行）=====
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

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
async function it(_name, fn) {
  await fn();
}

const PROXY_ENV = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];

// 起一个监听中的 TCP 服务（扮演「本机代理」）
function listeningServer() {
  const server = net.createServer(() => {});
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// 先占再放，拿到一个几乎肯定无人监听的端口
async function freePort() {
  const server = await listeningServer();
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function candidate(port, suffix = "") {
  return `127.0.0.1:${port}${suffix}`;
}

function captureConsole() {
  const logs = [];
  const warns = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  return {
    logs,
    warns,
    restore() {
      console.log = realLog;
      console.warn = realWarn;
    },
  };
}

describe("环境变量代理", async() => {
  await it("HTTPS_PROXY 命中即用，且不再扫端口", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const up = await listeningServer();
    const cap = captureConsole();
    const before = getGlobalDispatcher();
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:1";
      await detectProxy([candidate(up.address().port)]);
      assert(
        cap.logs.some((l) => l.includes("使用环境变量代理: http://127.0.0.1:1")),
        `打印使用环境变量代理（${cap.logs}）`,
      );
      assert(
        cap.logs.every((l) => !l.includes("已自动启用本机代理")),
        "没有退化成扫端口",
      );
      assert(getGlobalDispatcher() instanceof ProxyAgent, "全局 dispatcher 变为 ProxyAgent");
      cap.logs.length = 0;
    } finally {
      cap.restore();
      setGlobalDispatcher(before);
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await new Promise((r) => up.close(r));
    }
  });

  await it("四个变量名都认", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    try {
      for (const k of PROXY_ENV) {
        const cap = captureConsole();
        process.env[k] = "http://127.0.0.1:2";
        await detectProxy([]);
        cap.restore();
        assert(
          cap.logs.some((l) => l.includes("使用环境变量代理: http://127.0.0.1:2")),
          `${k} 被识别`,
        );
        delete process.env[k];
      }
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  await it("优先级 HTTPS_PROXY > HTTP_PROXY > https_proxy > http_proxy", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    try {
      const cap = captureConsole();
      process.env.HTTPS_PROXY = "http://127.0.0.1:11";
      process.env.HTTP_PROXY = "http://127.0.0.1:12";
      process.env.https_proxy = "http://127.0.0.1:13";
      process.env.http_proxy = "http://127.0.0.1:14";
      await detectProxy([]);
      cap.restore();
      assert(
        cap.logs.some((l) => l.includes("使用环境变量代理: http://127.0.0.1:11")),
        "HTTPS_PROXY 胜出",
      );

      const cap2 = captureConsole();
      delete process.env.HTTPS_PROXY;
      await detectProxy([]);
      cap2.restore();
      assert(
        cap2.logs.some((l) => l.includes("使用环境变量代理: http://127.0.0.1:12")),
        "去掉 HTTPS_PROXY 后 HTTP_PROXY 胜出",
      );
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  await it("空字符串视为未设置", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const closed = await freePort();
    try {
      const cap = captureConsole();
      process.env.HTTPS_PROXY = "";
      await detectProxy([candidate(closed)]);
      cap.restore();
      assert(
        cap.logs.every((l) => !l.includes("使用环境变量代理")),
        "空值不触发环境变量分支",
      );
      assert(
        cap.logs.some((l) => l.includes("未检测到本机代理")),
        "继续走端口扫描并落空",
      );
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  await it("URI 非法时 warn 后继续扫端口", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const up = await listeningServer();
    try {
      const cap = captureConsole();
      process.env.HTTP_PROXY = "!!!not-a-url";
      await detectProxy([candidate(up.address().port)]);
      cap.restore();
      assert(cap.warns.some((l) => l.includes("环境变量代理无效")), `warn 一行（${cap.warns}）`);
      assert(
        cap.logs.some((l) => l.includes(`已自动启用本机代理: http://${candidate(up.address().port)}`)),
        "吞掉后继续扫端口并命中",
      );
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await new Promise((r) => up.close(r));
    }
  });
});

describe("端口候选扫描", async() => {
  await it("命中第一个可达候选即返回", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const up1 = await listeningServer();
    const up2 = await listeningServer();
    const before = getGlobalDispatcher();
    const cap = captureConsole();
    try {
      await detectProxy([candidate(up1.address().port), candidate(up2.address().port)]);
      cap.restore();
      const want = `已自动启用本机代理: http://${candidate(up1.address().port)}`;
      assert(cap.logs.some((l) => l.includes(want)), `打印命中（${want}）`);
      assert(
        cap.logs.filter((l) => l.includes("已自动启用本机代理")).length === 1,
        "只命中一次：第二个同样可达的候选没有被继续采用",
      );
      assert(getGlobalDispatcher() instanceof ProxyAgent, "全局 dispatcher 变为 ProxyAgent");
    } finally {
      cap.restore();
      setGlobalDispatcher(before);
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await new Promise((r) => up1.close(r));
      await new Promise((r) => up2.close(r));
    }
  });

  await it("连接被静默丢弃时由超时判为不可达", async() => {
    // 192.0.2.0/24 是 RFC 5737 文档保留段，不可路由：连接既连不上也不报错，
    // 只能等满 400ms 的 socket 超时——这是 timeout 分支唯一现实的触发方式。
    // 假设该地址在运行环境里是被静默丢弃的（RFC 保留段的正常状况）；若所在网络
    // 直接拒绝，took 会远小于 400，届时下面的下界断言会明确失败。
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    try {
      const cap = captureConsole();
      const t0 = Date.now();
      await detectProxy(["192.0.2.1:9999"]);
      const took = Date.now() - t0;
      cap.restore();
      assert(took >= 350, `等满了超时才结算（${took}ms，阈值 400）`);
      assert(took < 5000, `没有被拖到 OS 级 ETIMEDOUT（${took}ms；去掉 400ms 上限会到几十秒）`);
      assert(
        cap.logs.every((l) => !l.includes("已自动启用本机代理")),
        "被静默丢弃的地址没有误判成可用代理",
      );
      assert(cap.logs.some((l) => l.includes("未检测到本机代理")), "落入落空提示");
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  await it("全部落空时给出提示", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const p1 = await freePort();
    const p2 = await freePort();
    try {
      const cap = captureConsole();
      await detectProxy([candidate(p1), candidate(p2)]);
      cap.restore();
      assert(
        cap.logs.some((l) => l.includes("未检测到本机代理")),
        "提示未检测到本机代理",
      );
      assert(
        cap.logs.every((l) => !l.includes("已自动启用本机代理")),
        "没有误启用",
      );
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  await it("候选可达但 ProxyAgent 构造失败时静默跳过", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const up1 = await listeningServer();
    const up2 = await listeningServer();
    const before = getGlobalDispatcher();
    const cap = captureConsole();
    try {
      // "host:port:extra" 拆出的 host/port 仍可连通，但拼出的 http:// URI 非法
      await detectProxy([candidate(up1.address().port, ":x"), candidate(up2.address().port)]);
      cap.restore();
      assert(
        cap.logs.some((l) => l.includes(`已自动启用本机代理: http://${candidate(up2.address().port)}`)),
        "第一个候选的异常被吞，第二个候选顶上",
      );
      assert(getGlobalDispatcher() instanceof ProxyAgent, "最终仍设置成功");
    } finally {
      cap.restore();
      setGlobalDispatcher(before);
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await new Promise((r) => up1.close(r));
      await new Promise((r) => up2.close(r));
    }
  });

  await it("设置的代理真的接管全局 fetch（http 绝对形式请求行）", async() => {
    // 这是本模块存在的意义：光看 console 只能证明打了日志，这里让 fetch 真走一遍。
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    const lines = [];
    const proxy = net.createServer((s) => {
      s.once("data", (c) => {
        lines.push(c.toString("utf8"));
        s.destroy();
      });
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const before = getGlobalDispatcher();
    const cap = captureConsole();
    try {
      await detectProxy([candidate(proxy.address().port)]);
      // 假代理收到请求就断开，fetch 必然失败；这里只关心请求写给了谁，
      // 用一个定时器兜底防止异常路径把测试挂住。
      await Promise.race([
        fetch("http://probe.invalid/some/path").catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      cap.restore();
      const first = lines.join("").split("\r\n")[0];
      assert(
        first === "GET http://probe.invalid/some/path HTTP/1.1",
        `代理收到绝对形式请求行（${JSON.stringify(first)}）——说明用的是 http 代理而非 https`,
      );
    } finally {
      cap.restore();
      setGlobalDispatcher(before);
      await new Promise((r) => proxy.close(r));
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  await it("空候选列表直接落空", async() => {
    const saved = {};
    for (const k of PROXY_ENV) saved[k] = process.env[k];
    for (const k of PROXY_ENV) delete process.env[k];
    try {
      const cap = captureConsole();
      await detectProxy([]);
      cap.restore();
      assert(cap.logs.some((l) => l.includes("未检测到本机代理")), "无候选时给出提示");
    } finally {
      for (const k of PROXY_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

// ===== 运行 =====
(async() => {
  try {
    for (const item of describeQueue) {
      console.log(`\n── ${item.name}`);
      await item.fn();
    }
  } finally {
    // 探测是进程级副作用，跑完把 dispatcher 还原成普通 Agent
    setGlobalDispatcher(new Agent());
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
