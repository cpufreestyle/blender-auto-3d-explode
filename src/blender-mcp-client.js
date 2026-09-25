// Blender MCP addon TCP 客户端（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的「Blender MCP addon 客户端」段：callBlenderMcp 以一条
// 换行分隔的 JSON 向 addon（scripts/blender_mcp_addon.py，默认 127.0.0.1:9876）
// 发命令并解析其单条 JSON 回复；内置 15s 超时、连接失败、addon 主动报错、
// 分片到达、半包后对端关闭五种收尾路径。
//
// DI / 接缝：createBlenderMcpClient({ host, port }) 让测试把客户端指向本地
// 临时 TCP 服务（否则只能连真实 9876，用户开着 Blender 时结果不可控）；
// 默认值仍取模块级 BLENDER_MCP_HOST / BLENDER_MCP_PORT，server.js 里
// createBlenderMcpClient() 无参调用即与原行为一致。net import 留在本模块内，
// server.js 的 detectProxy 另有一处 net 使用，故该 import 不动。
import net from "net";

// Blender MCP addon（scripts/blender_mcp_addon.py）监听的 TCP 地址
export const BLENDER_MCP_HOST = process.env.BLENDERMCP_HOST || "localhost";
export const BLENDER_MCP_PORT = Number(process.env.BLENDERMCP_PORT || 9876);

// ── Blender MCP addon 客户端（TCP，行分隔 JSON）────────

/**
 * 向 Blender MCP addon 发送单条命令并返回解析后的 JSON 结果。
 * addon 对每条命令回复一个完整 JSON。
 * @param {string} type   命令类型（如 get_assembly_sequence）
 * @param {object} params 命令参数
 * @param {number} timeoutMs 超时（默认 15s）
 * @returns {Promise<object>} addon 的 result 字段
 */
export function createBlenderMcpClient({ host = BLENDER_MCP_HOST, port = BLENDER_MCP_PORT } = {}) {
  return function callBlenderMcp(type, params = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(
        { host, port },
        () => {
          socket.write(JSON.stringify({ type, params }) + "\n");
        },
      );
      let buf = "";
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch {
          /* noop */
        }
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new Error("Blender MCP addon 响应超时")),
        timeoutMs,
      );
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buf += chunk;
        try {
          const parsed = JSON.parse(buf);
          if (parsed && parsed.status === "error") {
            finish(reject, new Error(parsed.message || "addon error"));
          } else {
            finish(resolve, parsed && "result" in parsed ? parsed.result : parsed);
          }
        } catch {
          /* JSON 尚不完整，继续接收 */
        }
      });
      socket.on("error", err =>
        finish(
          reject,
          new Error(`无法连接 Blender MCP addon (${host}:${port})：${err.message}`),
        ),
      );
      socket.on("end", () => {
        if (!done && buf) {
          try {
            const parsed = JSON.parse(buf);
            finish(resolve, parsed && "result" in parsed ? parsed.result : parsed);
          } catch (e) {
            finish(reject, new Error("addon 响应解析失败: " + e.message));
          }
        }
      });
    });
}
}
