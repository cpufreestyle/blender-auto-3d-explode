// Bootstrap: make Node's built-in global fetch (undici) route through the local proxy.
// Loaded via NODE_OPTIONS=--require ./proxy-bootstrap.cjs so server.js outbound
// calls (Tripo / Meshy / Hyper3D APIs) work in this network environment.
const { ProxyAgent, setGlobalDispatcher } = require("undici");

const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  "http://127.0.0.1:7897";

// connect.rejectUnauthorized=false: tolerate the local proxy's MITM/self-signed
// CA for tunneled HTTPS targets (WinHTTP trusts the system store; Node does not).
setGlobalDispatcher(
  new ProxyAgent({ uri: proxy, connect: { rejectUnauthorized: false } })
);
console.log(`[proxy-bootstrap] global fetch -> ${proxy} (rejectUnauthorized=false)`);
