// 第三方云端图片转3D 提供商（Meshy / Tripo / Hyper3D-Rodin）
// 直接调用各厂商 REST API（与 scripts/mcp_server.py 中的 MCP 工具逻辑一致）。
//
// 本模块为「纯函数」：输入配置 + 图片 base64，返回 { glbBuffer, manifest }，
// 由调用方（server.js 的 handleImageTo3D）负责组装 HTTP 响应，避免与响应/存储逻辑耦合。
// 缺失 API Key 时抛出带 status=400 的错误；其余错误沿调用栈上抛。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadBuffer(url) {
  const r = await fetch(url, { headers: { "User-Agent": "blender-explode" } });
  if (!r.ok) throw new Error(`GLB 下载失败 ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function providerApiKey(cfg, envVar) {
  return (cfg && cfg.apiKey) || process.env[envVar] || "";
}

function missingKeyError(label, envVar) {
  const e = new Error(
    `${label} 未配置 API Key：请在 ai-config.html 的「图片转3D」中填入 ${label} API Key，` +
      `或设置环境变量 ${envVar}。`
  );
  e.status = 400;
  return e;
}

function requireProviderKey(label, cfg, envVar) {
  const apiKey = providerApiKey(cfg, envVar);
  if (!apiKey) throw missingKeyError(label, envVar);
  return apiKey;
}

async function pollTask({ deadline, timeoutMsg, intervalMs = 5000, checkStatus }) {
  while (true) {
    if (Date.now() > deadline) throw new Error(timeoutMsg);
    await sleep(intervalMs);
    const r = await checkStatus();
    if (r.failed) throw new Error(r.error || "任务失败");
    if (r.done) return r.modelUrl;
  }
}

/**
 * Meshy image-to-3d：POST /openapi/v1/image-to-3d → 轮询 → 下载 model_urls.glb
 */
export async function runMeshyImageTo3D(cfg, body, imageBase64) {
  const apiKey = requireProviderKey("Meshy", cfg, "MESHY_API_KEY");
  const mime = (/^data:(image\/[a-zA-Z0-9.+-]+)/.exec(body.image) || [])[1] || "image/png";
  const dataUri = `data:${mime};base64,${imageBase64}`;
  console.log("  🌐 图片转3D: 创建 Meshy image-to-3d 任务");
  const createRes = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: dataUri, should_texture: true, enable_pbr: true, target_formats: ["glb"] }),
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error(`Meshy 创建任务失败 ${createRes.status}: ${t.slice(0, 400)}`);
  }
  const taskId = (await createRes.json()).result;
  if (!taskId) throw new Error("Meshy 未返回任务 ID");
  const deadline = Date.now() + 10 * 60 * 1000;
  const modelUrl = await pollTask({
    deadline,
    timeoutMsg: "Meshy 任务超时（10 分钟）",
    intervalMs: 5000,
    checkStatus: async () => {
      const pr = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!pr.ok) throw new Error(`Meshy 状态查询失败 ${pr.status}`);
      const d = await pr.json();
      return {
        done: d.status === "SUCCEEDED",
        failed: d.status === "FAILED" || d.status === "CANCELED",
        error: d.status,
        modelUrl: d.model_urls?.glb || d.model_url,
      };
    },
  });
  if (!modelUrl) throw new Error("Meshy 输出中未找到 GLB 链接");
  const glbBuffer = await downloadBuffer(modelUrl);
  return { glbBuffer, manifest: { total_parts: 0, parts: [], engine: "meshy" } };
}

/**
 * Tripo image-to-model：上传图片换 file_token → POST /v3/generation/image-to-model → 轮询 → 下载
 */
export async function runTripoImageTo3D(cfg, body, imageBase64) {
  const apiKey = requireProviderKey("Tripo", cfg, "TRIPO_API_KEY");
  const mime = (/^data:(image\/[a-zA-Z0-9.+-]+)/.exec(body.image) || [])[1] || "image/png";
  const imageBytes = Buffer.from(imageBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([imageBytes], { type: mime }), "image.png");
  console.log(`  🌐 图片转3D: 上传图片到 Tripo (${(imageBytes.length / 1024).toFixed(1)} KB)`);
  const upRes = await fetch("https://openapi.tripo3d.ai/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!upRes.ok) {
    const t = await upRes.text();
    throw new Error(`Tripo 文件上传失败 ${upRes.status}: ${t.slice(0, 400)}`);
  }
  const fileToken = (await upRes.json())?.data?.file_token;
  if (!fileToken) throw new Error("Tripo 未返回 file_token");
  const model = (cfg && cfg.model) || body.model || "v3.1-20260211";
  console.log(`  🚀 图片转3D: 创建 Tripo image-to-model (${model})`);
  const taskRes = await fetch("https://openapi.tripo3d.ai/v3/generation/image-to-model", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: fileToken, model, texture: true, pbr: true }),
  });
  if (!taskRes.ok) {
    const t = await taskRes.text();
    throw new Error(`Tripo 创建任务失败 ${taskRes.status}: ${t.slice(0, 400)}`);
  }
  const taskId = (await taskRes.json())?.data?.task_id;
  if (!taskId) throw new Error("Tripo 未返回 task_id");
  const deadline = Date.now() + 10 * 60 * 1000;
  const modelUrl = await pollTask({
    deadline,
    timeoutMsg: "Tripo 任务超时（10 分钟）",
    intervalMs: 5000,
    checkStatus: async () => {
      const pr = await fetch(`https://openapi.tripo3d.ai/v3/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!pr.ok) throw new Error(`Tripo 状态查询失败 ${pr.status}`);
      const d = (await pr.json()).data || {};
      return { done: d.status === "success", failed: d.status === "failed", error: d.status, modelUrl: d.output?.model_url };
    },
  });
  if (!modelUrl) throw new Error("Tripo 输出中未找到 GLB 链接");
  const glbBuffer = await downloadBuffer(modelUrl);
  return { glbBuffer, manifest: { total_parts: 0, parts: [], engine: "tripo" } };
}

/**
 * Hyper3D(Rodin) image-to-3d：multipart POST /api/v2/rodin → 轮询 → POST /api/v2/download 取 GLB
 */
export async function runHyper3DImageTo3D(cfg, body, imageBase64) {
  const apiKey = requireProviderKey("Hyper3D(Rodin)", cfg, "HYPER3D_API_KEY");
  const mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+)/.exec(body.image);
  const mime = (mimeMatch && mimeMatch[1]) || "image/png";
  const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png";
  const imageBytes = Buffer.from(imageBase64, "base64");
  const form = new FormData();
  form.append("images", new Blob([imageBytes], { type: mime }), `0000${ext}`);
  form.append("tier", "Sketch");
  form.append("mesh_mode", "Raw");
  form.append("texture_mode", "high");
  console.log(`  🌐 图片转3D: 创建 Hyper3D Rodin 任务 (${(imageBytes.length / 1024).toFixed(1)} KB)`);
  const createRes = await fetch("https://hyperhuman.deemos.com/api/v2/rodin", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error(`Hyper3D 创建任务失败 ${createRes.status}: ${t.slice(0, 400)}`);
  }
  const cd = await createRes.json();
  const uuid = cd.uuid || (cd.data && cd.data.uuid);
  const subKey = cd.subscription_key || (cd.data && cd.data.subscription_key);
  if (!uuid || !subKey) throw new Error("Hyper3D 未返回任务标识 (uuid/subscription_key)");
  const deadline = Date.now() + 10 * 60 * 1000;
  await pollTask({
    deadline,
    timeoutMsg: "Hyper3D 任务超时（10 分钟）",
    intervalMs: 5000,
    checkStatus: async () => {
      const pr = await fetch("https://hyperhuman.deemos.com/api/v2/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_key: subKey }),
      });
      if (!pr.ok) throw new Error(`Hyper3D 状态查询失败 ${pr.status}`);
      const d = await pr.json();
      const jobs = d.jobs || [];
      if (jobs.some((j) => j.status === "Failed")) throw new Error("Hyper3D 生成失败");
      return { done: jobs.length > 0 && jobs.every((j) => j.status === "Done") };
    },
  });
  const dlRes = await fetch("https://hyperhuman.deemos.com/api/v2/download", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task_uuid: uuid }),
  });
  if (!dlRes.ok) {
    const t = await dlRes.text();
    throw new Error(`Hyper3D 下载请求失败 ${dlRes.status}: ${t.slice(0, 400)}`);
  }
  const dlData = await dlRes.json();
  const list = dlData.list || [];
  const glbItem = list.find((i) => i.name && i.name.endsWith(".glb"));
  if (!glbItem || !glbItem.url) throw new Error("Hyper3D 未返回 GLB 下载链接");
  const glbBuffer = await downloadBuffer(glbItem.url);
  return { glbBuffer, manifest: { total_parts: 0, parts: [], engine: "hyper3d" } };
}

/**
 * Hyper3D(Rodin) text-to-3d：用自然语言提示词生成 3D 模型。
 * 与 image-to-3d 共用 /api/v2/rodin 端点，只是以 prompt 字段替代 images 字段。
 * 流程：创建任务 → 轮询 → 下载 GLB。返回 { glbBuffer, manifest }。
 */
export async function runHyper3DTextTo3D(cfg, prompt) {
  const apiKey = requireProviderKey("Hyper3D(Rodin)", cfg, "HYPER3D_API_KEY");
  const text = (prompt || "").toString().trim();
  if (!text) {
    const e = new Error("Hyper3D 文生3D 需要非空的文本提示词");
    e.status = 400;
    throw e;
  }
  const form = new FormData();
  form.append("prompt", text);
  form.append("tier", "Sketch");
  form.append("mesh_mode", "Raw");
  form.append("texture_mode", "high");
  console.log(`  🌐 文生3D: 创建 Hyper3D Rodin 文本任务 (${text.length} 字)`);
  const createRes = await fetch("https://hyperhuman.deemos.com/api/v2/rodin", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error(`Hyper3D 创建任务失败 ${createRes.status}: ${t.slice(0, 400)}`);
  }
  const cd = await createRes.json();
  const uuid = cd.uuid || (cd.data && cd.data.uuid);
  const subKey = cd.subscription_key || (cd.data && cd.data.subscription_key);
  if (!uuid || !subKey) throw new Error("Hyper3D 未返回任务标识 (uuid/subscription_key)");
  const deadline = Date.now() + 10 * 60 * 1000;
  await pollTask({
    deadline,
    timeoutMsg: "Hyper3D 任务超时（10 分钟）",
    intervalMs: 5000,
    checkStatus: async () => {
      const pr = await fetch("https://hyperhuman.deemos.com/api/v2/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_key: subKey }),
      });
      if (!pr.ok) throw new Error(`Hyper3D 状态查询失败 ${pr.status}`);
      const d = await pr.json();
      const jobs = d.jobs || [];
      if (jobs.some((j) => j.status === "Failed")) throw new Error("Hyper3D 生成失败");
      return { done: jobs.length > 0 && jobs.every((j) => j.status === "Done") };
    },
  });
  const dlRes = await fetch("https://hyperhuman.deemos.com/api/v2/download", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task_uuid: uuid }),
  });
  if (!dlRes.ok) {
    const t = await dlRes.text();
    throw new Error(`Hyper3D 下载请求失败 ${dlRes.status}: ${t.slice(0, 400)}`);
  }
  const dlData = await dlRes.json();
  const list = dlData.list || [];
  const glbItem = list.find((i) => i.name && i.name.endsWith(".glb"));
  if (!glbItem || !glbItem.url) throw new Error("Hyper3D 未返回 GLB 下载链接");
  const glbBuffer = await downloadBuffer(glbItem.url);
  return { glbBuffer, manifest: { total_parts: 0, parts: [], engine: "hyper3d-text", prompt: text } };
}
