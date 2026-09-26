#!/usr/bin/env node
/**
 * 单元测试 — Blender MCP addon TCP 客户端（src/blender-mcp-client.js，从 server.js 抽取）
 *
 * 抽取的不变量：
 *   - 连接后写出一条换行分隔的 JSON 命令 { type, params }（params 缺省 {}）；
 *   - 回复带 result 字段 → 解析出 result；不带 result → 原样透传整个 JSON；
 *   - 回复 status === "error" → reject，message 缺省 "addon error"；
 *   - 连接失败 → reject，文案含 host:port 与底层 err.message；
 *   - 到超时仍无完整 JSON → reject "Blender MCP addon 响应超时"；
 *   - 半包（JSON 不完整）继续累积，直到可解析；累积到对端关闭仍不可解析 →
 *     reject "addon 响应解析失败: ..."；
 *   - finish 幂等：已结算后到达的数据/对端关闭不再二次 settle（否则会出现
 *     unhandled rejection）；
 *   - BLENDER_MCP_HOST / PORT 默认 localhost:9876。
 *
 * 用法：node tests/blender-mcp-client-test.mjs
 */

import net from "node:net";
import { execFileSync } from "node:child_process";
import { createBlenderMcpClient, BLENDER_MCP_HOST, BLENDER_MCP_PORT } from "../src/blender-mcp-client.js";

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

// 起一个一次性 TCP 服务：handler(socket, server, firstLine) 自行决定回复什么
function withServer(handler) {
  const server = net.createServer((sock) => handler(sock));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function clientFor(server) {
  const { port } = server.address();
  return createBlenderMcpClient({ host: "127.0.0.1", port });
}

// 循环直到 socket 上有数据可读，便于逐片写入以模拟分片到达
function waitData(sock, durationMs = 60) {
  return new Promise((r) => setTimeout(r, durationMs));
}

function rejectsWith(promise, expected) {
  return promise.then(
    () => false,
    (err) => String(err && err.message).includes(expected),
  );
}

describe("默认地址", async() => {
  await it("默认值与端口类型", () => {
    if (!process.env.BLENDERMCP_HOST) {
      assert(BLENDER_MCP_HOST === "localhost", "默认 host 为 localhost");
    }
    if (!process.env.BLENDERMCP_PORT) {
      assert(BLENDER_MCP_PORT === 9876, "默认 port 为 9876");
      assert(Number.isInteger(BLENDER_MCP_PORT), "port 被 Number() 归一成整数");
    }
  });
});

describe("正常往返", async() => {
  await it("发出的命令是一条换行分隔 JSON", async() => {
    let seen = "";
    const server = await withServer((sock) => {
      sock.on("data", (c) => {
        seen += c.toString("utf8");
        sock.write("{\"status\":\"ok\",\"result\":{\"count\":7}}\n");
      });
    });
    const r = await clientFor(server)("get_assembly_sequence", { method: "distance" });
    assert(
      seen === "{\"type\":\"get_assembly_sequence\",\"params\":{\"method\":\"distance\"}}\n",
      `写入内容逐字匹配: ${JSON.stringify(seen)}`,
    );
    assert(
      r && r.count === 7,
      "回复带 result 时解析出 result 字段",
    );
    server.close();
  });

  await it("params 缺省为空对象", async() => {
    let seen = "";
    const server = await withServer((sock) => {
      sock.on("data", (c) => {
        seen += c.toString("utf8");
        sock.write("{\"status\":\"ok\"}\n");
      });
    });
    await clientFor(server)("ping");
    assert(seen === "{\"type\":\"ping\",\"params\":{}}\n", "缺省 params 序列化为 {}");
    server.close();
  });

  await it("回复不带 result 时透传整个 JSON", async() => {
    const server = await withServer((sock) => {
      sock.on("data", () => sock.write("{\"status\":\"ok\",\"foo\":1,\"bar\":[2]}\n"));
    });
    const r = await clientFor(server)("anything");
    assert(
      r && r.foo === 1 && Array.isArray(r.bar) && r.bar[0] === 2,
      "无 result 字段时整个对象透传",
    );
    server.close();
  });

  await it("分片到达也能拼齐", async() => {
    const server = await withServer(async(sock) => {
      sock.on("data", async() => {
        sock.write("{\"status\":\"ok\",\"resu");
        await waitData(sock, 30);
        sock.write("lt\":{\"ok\":true}}\n");
      });
    });
    const r = await clientFor(server)("chunked");
    assert(r && r.ok === true, "后半片到达后整体解析成功");
    server.close();
  });

  await it("已结算后到达的杂音不再二次 settle", async() => {
    const server = await withServer(async(sock) => {
      sock.on("data", async() => {
        sock.write("{\"status\":\"ok\",\"result\":{\"n\":1}}\n");
        await waitData(sock, 20);
        sock.write("这不是 JSON"); // 若 finish 不幂等，这里会 reject 成 unhandled
        sock.end();
      });
    });
    const r = await clientFor(server)("noise");
    assert(r && r.n === 1, "先到的有效回复定案，后续垃圾数据被忽略");
    server.close();
  });
});

describe("超时参数", async() => {
  await it("自定义值与 15s 默认值都原样透传", async() => {
    const server = await withServer(() => {});
    const client = clientFor(server);
    const real = globalThis.setTimeout;
    const seen = [];
    globalThis.setTimeout = (fn, ms, ...rest) => {
      seen.push(ms);
      return real(fn, 0, ...rest); // 立刻触发，测试不必真等 15s
    };
    try {
      assert(
        await rejectsWith(client("t", {}, 250), "Blender MCP addon 响应超时"),
        "自定义 timeoutMs 生效",
      );
      assert(seen[seen.length - 1] === 250, `透传给 setTimeout 的是 250（实际 ${seen[seen.length - 1]}）`);
      assert(
        await rejectsWith(client("t"), "Blender MCP addon 响应超时"),
        "缺省 timeoutMs 也会走到超时分支",
      );
      assert(seen[seen.length - 1] === 15_000, `缺省值为 15000（实际 ${seen[seen.length - 1]}）`);
    } finally {
      globalThis.setTimeout = real;
    }
    server.close();
  });

  await it("结算时清理超时定时器", async() => {
    const server = await withServer((sock) => {
      sock.on("data", () => sock.write("{\"status\":\"ok\",\"result\":{\"n\":1}}\n"));
    });
    const real = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = (id) => {
      cleared++;
      return real(id);
    };
    try {
      const r = await clientFor(server)("t");
      assert(r && r.n === 1, "正常往返仍成立");
      assert(cleared >= 1, `finish 清理了超时定时器（${cleared} 次）`);
    } finally {
      globalThis.clearTimeout = real;
    }
    server.close();
  });
});

describe("环境变量覆盖", async() => {
  await it("BLENDERMCP_PORT 被 Number() 归一成整数", () => {
    // 模块级常量在 import 时求值，故用子进程带上环境变量再导入
    const code =
      "import { BLENDER_MCP_HOST, BLENDER_MCP_PORT } from \"./src/blender-mcp-client.js\";" +
      "console.log(JSON.stringify([BLENDER_MCP_HOST, BLENDER_MCP_PORT, typeof BLENDER_MCP_PORT]));";
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, BLENDERMCP_HOST: "10.1.2.3", BLENDERMCP_PORT: "12345" },
    }).trim();
    const [host, port, type] = JSON.parse(out);
    assert(host === "10.1.2.3", `host 取自环境变量（${host}）`);
    assert(port === 12345 && type === "number", `port 由字符串 "12345" 归一成数字 12345（${port}/${type}）`);
  });
});

describe("重复回复", async() => {
  await it("对端连发两条只认第一条", async() => {
    const server = await withServer(async(sock) => {
      sock.on("data", async() => {
        sock.write("{\"status\":\"ok\",\"result\":{\"n\":1}}\n");
        await waitData(sock, 20);
        sock.write("{\"status\":\"ok\",\"result\":{\"n\":2}}\n");
        sock.end();
      });
    });
    const r = await clientFor(server)("dup");
    assert(r && r.n === 1, "first reply wins：只取第一条结果");
    server.close();
  });
});

describe("addon 报错", async() => {
  await it("status === error 带 message", async() => {
    const server = await withServer((sock) => {
      sock.on("data", () => sock.write("{\"status\":\"error\",\"message\":\"场景为空\"}\n"));
    });
    assert(
      await rejectsWith(clientFor(server)("analyze_assembly"), "场景为空"),
      "reject 携带 addon 的 message",
    );
    server.close();
  });

  await it("status === error 无 message 时用兜底文案", async() => {
    const server = await withServer((sock) => {
      sock.on("data", () => sock.write("{\"status\":\"error\"}\n"));
    });
    assert(await rejectsWith(clientFor(server)("analyze_assembly"), "addon error"), "reject 兜底 addon error");
    server.close();
  });
});

describe("连接与收尾", async() => {
  await it("连接被拒时文案含 host:port", async() => {
    // 先占一个端口再放开，确保一定连不上
    const probe = await withServer(() => {});
    const { port } = probe.address();
    await new Promise((r) => probe.close(r));
    const client = createBlenderMcpClient({ host: "127.0.0.1", port });
    assert(
      await rejectsWith(client("x"), `无法连接 Blender MCP addon (127.0.0.1:${port})`),
      "reject 文案含 host:port",
    );
    assert(
      await rejectsWith(client("x"), "ECONNREFUSED"),
      "reject 文案含底层 err.message",
    );
  });

  await it("超时未响应", async() => {
    const server = await withServer(() => {}); // 接了但永远不回
    const started = Date.now();
    const ok = await rejectsWith(
      clientFor(server)("slow", {}, 120),
      "Blender MCP addon 响应超时",
    );
    const took = Date.now() - started;
    assert(ok, "reject 超时文案");
    assert(took >= 100, `确实等到了超时才结算（实际 ${took}ms）`);
    assert(took < 1500, `没有拖到默认 15s（实际 ${took}ms）`);
    server.close();
  });

  await it("半包后对端关闭 → 解析失败", async() => {
    const server = await withServer((sock) => {
      sock.on("data", () => {
        sock.write("{\"status\":\"ok\",\"resu");
        sock.end();
      });
    });
    assert(
      await rejectsWith(clientFor(server)("partial"), "addon 响应解析失败: "),
      "reject 解析失败并带原始错误信息",
    );
    server.close();
  });

  await it("对端空关闭时不结算也不崩", async() => {
    // 没有任何字节：end 分支的 if (!done && buf) 不成立，交给超时兜底
    const server = await withServer((sock) => {
      sock.on("data", () => sock.end());
    });
    const started = Date.now();
    const ok = await rejectsWith(clientFor(server)("empty", {}, 120), "Blender MCP addon 响应超时");
    assert(ok, `空响应最终由超时兜底（${Date.now() - started}ms）`);
    server.close();
  });
});

// ===== 运行 =====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
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
