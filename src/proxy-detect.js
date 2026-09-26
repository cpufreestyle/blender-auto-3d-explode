// 零配置代理自动探测（从 server.js 抽取，行为不变）。
//
// 让 server 开箱即用：若已设置 HTTP(S)_PROXY 则直接用；否则探测本机常见代理端口
// （Clash 7897/7890、1080、8080），命中即用 undici ProxyAgent 接管全局 fetch。
// 这样外网 API（TokenDance / Tripo / Meshy 等）无需再手动 --require proxy-bootstrap.cjs。
//
// 接缝：依赖 node:net 与 undici 的 ProxyAgent / setGlobalDispatcher，外加一个
//   candidates 参数（默认四个常见端口）——否则端口扫描结果取决于开发者本机开着
//   哪个代理，测试无法稳定断言。
//   注意两条时序约定，调换会改变日志形态：
//   1) server.js 在 import 之后、把 console.* 重定向到结构化 logger 之前 await
//      这个函数，故此处 console.log/warn 走原生 console（探测是启动期日志）；
//   2) setGlobalDispatcher 是进程级副作用，必须在任何外网 fetch 之前生效。
import net from "net";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// ── 零配置代理自动探测 ──────────────────────────────
// 让 server 开箱即用：若已设置 HTTP(S)_PROXY 则直接用；否则探测本机常见代理端口
// （Clash 7897/7890、1080、8080），命中即用 undici ProxyAgent 接管全局 fetch。
// 这样外网 API（TokenDance / Tripo / Meshy 等）无需再手动 --require proxy-bootstrap.cjs。
// 默认候选端口（Clash 常用 7897/7890，HTTP 1080，其它 8080）
const DEFAULT_PROXY_CANDIDATES = ["127.0.0.1:7897", "127.0.0.1:7890", "127.0.0.1:1080", "127.0.0.1:8080"];

// candidates 可传：默认扫上面四个常见端口；测试传入自选端口，避免依赖
// 开发者本机是否开着某个代理而使结果不确定。
export async function detectProxy(candidates = DEFAULT_PROXY_CANDIDATES) {
  const envProxy =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.http_proxy;
  if (envProxy) {
    try {
      setGlobalDispatcher(new ProxyAgent({ uri: envProxy, connect: { rejectUnauthorized: false } }));
      console.log(`  🌐 使用环境变量代理: ${envProxy}`);
      return;
    } catch (e) {
      console.warn(`  ⚠️ 环境变量代理无效，忽略: ${e.message}`);
    }
  }
  for (const c of candidates) {
    const [host, port] = c.split(":");
    const reachable = await new Promise((resolve) => {
      const sock = net.createConnection({ host, port: Number(port), timeout: 400 });
      sock.once("connect", () => { try { sock.destroy(); } catch {} resolve(true); });
      sock.once("error", () => { try { sock.destroy(); } catch {} resolve(false); });
      sock.once("timeout", () => { try { sock.destroy(); } catch {} resolve(false); });
    });
    if (reachable) {
      try {
        setGlobalDispatcher(new ProxyAgent({ uri: `http://${c}`, connect: { rejectUnauthorized: false } }));
        console.log(`  🌐 已自动启用本机代理: http://${c}`);
        return;
      } catch { }
    }
  }
  console.log("  ℹ️ 未检测到本机代理；外网 API（TokenDance/Tripo 等）如需访问请启动代理或设置 HTTP_PROXY");
}
