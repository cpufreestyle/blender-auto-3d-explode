// 配置面板 + Blender 健康检测（L2 前端模块化拆分）
// 从 main.js 抽取：AI 配置拉取与高亮、配置保存消息监听、Blender 后端健康检测与一键启动。
// 仅依赖 DOM 与 fetch，不触碰 3D 场景状态，便于独立维护与测试。
// 注意：本模块在导入时即执行顶部「Blender 健康检测」初始化与事件绑定。

// 读取 ai-config.json：缺失 provider 或 key 时高亮「配置 AI」按钮
export function fetchConfigAndHighlight(btn) {
  if (!btn) return;
  fetch("ai-config.json")
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => {
      if (!cfg) {
        btn.classList.add("need-config");
        return;
      }
      const provider = cfg.provider;
      const hasProvider = !!provider && provider !== "img3d";
      const key = provider && cfg[provider] && cfg[provider].key;
      const hasKey = !!(key && key !== "***");
      if (!hasProvider || !hasKey) {
        btn.classList.add("need-config");
      }
    })
    .catch(() => {/* 配置不存在时不强制提醒 */});
}

// 配置弹窗内保存成功后，移除首页按钮的「待配置」提醒
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "config-saved") {
    const btn = document.getElementById("open-config-btn");
    if (btn) btn.classList.remove("need-config");
  }
});

// ===== Blender 状态检测 + 一键启动 =====
const blenderStatusEl = document.getElementById("blender-status");
const blenderBanner = document.getElementById("blender-banner");
const blenderLaunchBtn = document.getElementById("blender-launch");
const blenderDismissBtn = document.getElementById("blender-dismiss");

// 依次尝试同源与独立后端端口，兼容两种部署方式
async function fetchBlenderHealth() {
  const candidates = [
    location.origin + "/api/health",
    `http://${location.hostname}:3001/api/health`,
  ];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { method: "GET" });
      if (r.ok) return await r.json();
    } catch (_) {
      /* 尝试下一个地址 */
    }
  }
  return null; // 后端不可达
}

function updateBlenderUI(health) {
  if (!blenderStatusEl) return;
  if (!health || health.status !== "ok") {
    blenderStatusEl.className = "blender-chip " + (health ? "error" : "unknown");
    blenderStatusEl.textContent = health ? "❌ Blender 不可用" : "⚠️ 后端离线";
    if (blenderBanner) {
      // 仅当后端可达但 Blender 不可用时提示
      blenderBanner.classList.toggle("hidden", !health);
    }
  } else {
    blenderStatusEl.className = "blender-chip ok";
    blenderStatusEl.textContent = `✅ Blender ${health.version || ""}`.trim();
    if (blenderBanner) blenderBanner.classList.add("hidden");
  }
}

async function launchBlender() {
  if (blenderLaunchBtn) blenderLaunchBtn.disabled = true;
  const candidates = [
    location.origin + "/api/blender/launch",
    `http://${location.hostname}:3001/api/blender/launch`,
  ];
  let ok = false;
  for (const u of candidates) {
    try {
      const r = await fetch(u, { method: "POST" });
      if (r.ok) { ok = true; break; }
    } catch (_) {
      /* 尝试下一个地址 */
    }
  }
  if (blenderLaunchBtn) blenderLaunchBtn.disabled = false;
  updateBlenderUI(await fetchBlenderHealth());
  if (!ok && blenderBanner) {
    const t = blenderBanner.querySelector(".bb-text");
    if (t) t.textContent = "未能启动 Blender，请确认本机已安装 Blender 应用。";
  }
}

if (blenderLaunchBtn) blenderLaunchBtn.addEventListener("click", launchBlender);
if (blenderDismissBtn && blenderBanner) {
  blenderDismissBtn.addEventListener("click", () => blenderBanner.classList.add("hidden"));
}

// 打开软件时检测 Blender 状态
fetchBlenderHealth().then(updateBlenderUI);
