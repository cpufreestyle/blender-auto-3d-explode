// 图片转 3D 统一调度器：本地 / 云端 / VLM 三条路线收敛到一个入口。
//
// 历史形态：server.js 的 handleImageTo3D 里按 deploy 分支散落四段实现（本地浮雕、
// 本地 TripoSR、内联 Replicate 轮询、VLM 脚本），各自写临时文件、起子进程、读产物、
// 直接写 HTTP 响应；「本地失败回退云端」这条规则和内联云路径纠缠在一起，且
// handleGenToBlender 里还有第三份云端 provider 分派副本。
//
// 现在：generateImageTo3D() 是唯一入口，统一契约为「返回 { glbBuffer, manifest }」，
// 由调用方负责写 HTTP 响应；各路线最坏耗时集中在本文件顶部；进程级能力
// （fs / path / os / spawn / execFile / Blender 路径 / 临时目录）经 deps 注入，
// 因此本模块可在测试里用假 deps 跑完整调度逻辑（不发真实请求、不起真实 Blender）。

import {
  runMeshyImageTo3D,
  runTripoImageTo3D,
  runHyper3DImageTo3D,
  pollTask,
} from "./providers/image-to-3d.js";
import { createVlmJobPaths, waitForChildExit } from "./server-utils.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";

// 各路线最坏耗时上限（毫秒），集中一处便于回看与调整。
export const IMAGE_TO_3D_TIMEOUTS = {
  blenderRelief: 600_000, // Blender 后台渲染 + 导出
  triposr: 900_000, // 单图真重建在 CPU 上需数分钟（含首次权重下载）
  replicate: 8 * 60 * 1000, // 上传 + 创建预测 + 轮询
  // VLM = MAX_RETRIES(4) 轮「大模型生成代码 + Blender 执行 + 自动修复」
  vlm: 30 * 60 * 1000,
};

/**
 * 图片转 3D 统一调度入口。
 *
 * @param {object} opts
 * @param {string} opts.mode - 部署方式：local / replicate / meshy / tripo / hyper3d / vlm。
 *   未知值按 Replicate 云端处理（与历史行为一致）。
 * @param {object} opts.body - 请求体（mode / tiles / resolution / depth / thickness / model ...）
 * @param {string} opts.imageBase64 - 不含 data URL 前缀的纯 base64 图片
 * @param {string} opts.mime - 图片 MIME（Replicate 上传需要）
 * @param {object} opts.config - AI_CONFIG（replicate / providers / vlm 配置）
 * @param {object} opts.deps - 进程级能力注入，见 server.js 的 IMAGE_TO_3D_DEPS
 * @returns {Promise<{glbBuffer: Buffer, manifest: object}>}
 */
export async function generateImageTo3D({ mode, body, imageBase64, mime, config, deps }) {
  if (mode === "local") {
    try {
      return await runLocalImageTo3D(body, imageBase64, config, deps);
    } catch (localErr) {
      // 已配置 Replicate Token 时，本地服务不可用则自动回退云端，提升易用性
      if (!(config.replicate || {}).token) throw localErr;
      console.warn(`  ⚠️ 本地图像转3D服务不可用，自动回退到 Replicate 云端: ${localErr.message}`);
      return await runReplicateImageTo3D(body, imageBase64, mime, "local", config, deps);
    }
  }
  // 第三方云端提供商（与 MCP tools 一致）：Meshy / Tripo / Hyper3D(Rodin)
  if (mode === "meshy") return runMeshyImageTo3D(config.providers?.meshy, body, imageBase64);
  if (mode === "tripo") return runTripoImageTo3D(config.providers?.tripo, body, imageBase64);
  if (mode === "hyper3d") return runHyper3DImageTo3D(config.providers?.hyper3d, body, imageBase64);
  // VLM 视觉模型程序化重建（看图→生成 3D 代码→自动修复→导出 GLB）
  if (mode === "vlm") return runVlmImageTo3D(config.vlm, body, imageBase64, deps);
  // Replicate 云端（及未知 deploy 值的历史兜底）
  return runReplicateImageTo3D(body, imageBase64, mime, mode, config, deps);
}

// ── 本地路线 ────────────────────────────────────────

/**
 * 本地部署图像转3D（默认：零依赖 Blender 浮雕/体素/深度方案，离线、可拆解）
 * - 默认走 blender_image_to_3d.py（用已安装的 Blender 跑，不需 GPU/venv），
 *   按 --tiles 切成若干独立网格（默认 3×3=9 块），拼合即还原、爆炸即分离，
 *   因此默认生成的模型就是「可拆解」的（满足本地教学拆解需求）。
 * - 仅当显式勾选「真重建」且本机 TripoSR 环境就绪时，才走 TripoSR 真重建（单网格，质量更高）。
 */
async function runLocalImageTo3D(body, imageBase64, config, deps) {
  const rep = config.replicate || {};
  // 真重建（TripoSR）：需 venv + 权重，单网格、默认不可拆解；仅显式请求且环境就绪时启用
  const triposrDir = process.env.TRIPOSR_DIR || deps.path.join(deps.rootDir, "external", "TripoSR");
  const venvPython = deps.path.join(triposrDir, ".venv", "bin", "python3");
  const inferScript = deps.path.join(deps.rootDir, "scripts", "triposr_infer.py");
  if (body.real && deps.fs.existsSync(venvPython) && deps.fs.existsSync(inferScript)) {
    return runLocalTripoSRImageTo3D(body, imageBase64, rep, deps, {
      triposrDir,
      venvPython,
      inferScript,
    });
  }
  return runLocalReliefImageTo3D(body, imageBase64, rep, deps);
}

/**
 * 本地「真重建」（TripoSR）：离线推理，生成有体积/背面的真·3D 网格 GLB。
 * 注意：默认单网格、不可拆解；如需可拆解请使用默认的浮雕/体素/深度方案。
 */
async function runLocalTripoSRImageTo3D(body, imageBase64, rep, deps, env) {
  const job = createLocalJob(deps);
  await deps.fs.promises.writeFile(job.image, Buffer.from(imageBase64, "base64"));

  const mcResolution = body.mcResolution ?? rep.mcResolution ?? 256;
  const bakeTexture = body.bakeTexture ?? rep.bakeTexture ?? false;
  const removeBg = body.removeBg ?? rep.removeBg ?? true; // 本地 TriPoSR 默认去背景：带背景会严重拉低重建质量
  const device = body.device ?? rep.device ?? "auto";
  const textureResolution = body.textureResolution ?? rep.textureResolution ?? 2048;
  const chunkSize = body.chunkSize ?? rep.chunkSize ?? 8192;

  const args = [
    env.inferScript,
    "--image", job.image,
    "--output", job.output,
    "--manifest", job.manifest,
    "--device", device,
    "--mc-resolution", String(mcResolution),
    "--texture-resolution", String(textureResolution),
    "--chunk-size", String(chunkSize),
    "--triposr-dir", env.triposrDir,
  ];
  if (bakeTexture) args.push("--bake-texture");
  if (removeBg) args.push("--remove-bg");

  console.log(`  🧊 图片转3D: 本地 TripoSR 真重建 ${env.inferScript} (mc=${mcResolution}, bake=${bakeTexture}, device=${device})`);
  let stdout = "";
  let stderr = "";
  try {
    const r = await deps.execFile(env.venvPython, args, {
      timeout: IMAGE_TO_3D_TIMEOUTS.triposr,
      maxBuffer: 200 * 1024 * 1024,
    });
    stdout = r.stdout || "";
    stderr = r.stderr || "";
  } catch (berr) {
    throw new Error(`TripoSR 推理失败: ${(berr.stderr || berr.stdout || berr.message || "").slice(0, 2000)}`);
  }
  if (stdout) console.log(`  📤 TripoSR stdout:\n${stdout.slice(0, 2000)}`);
  if (stderr) console.log(`  📤 TripoSR stderr:\n${stderr.slice(0, 2000)}`);

  if (!deps.fs.existsSync(job.output)) {
    throw new Error(
      `本地真实重建未生成 GLB 文件。请确认 TripoSR 环境已就绪（bash scripts/setup_triposr.sh）。` +
      `TripoSR stderr: ${stderr.slice(0, 800)}`
    );
  }

  const { glbBuffer, manifest } = await readLocalJobResult(deps, job);

  console.log(`  ✅ 图片转3D（本地·TripoSR 真重建）完成 (${(glbBuffer.length / 1024).toFixed(1)} KB, parts=${manifest.total_parts})`);
  return { glbBuffer, manifest };
}

/**
 * 本地「可拆解」重建（Blender 浮雕/体素/深度）：零依赖，用已安装 Blender 跑，
 * 按 --tiles 切成独立网格（默认 3×3），天生可爆炸拆解，离线即用。
 */
async function runLocalReliefImageTo3D(body, imageBase64, rep, deps) {
  if (!deps.blenderPath) {
    throw new Error(
      "本地可拆解重建失败：未找到 Blender 可执行文件。请先安装 Blender 并在 PATH 中可用，" +
        "或设置 BLENDER_PATH 环境变量后重启 server.js。"
    );
  }
  const reliefScript = deps.path.join(deps.rootDir, "blender_image_to_3d.py");
  if (!deps.fs.existsSync(reliefScript)) {
    throw new Error("未找到本地重建脚本: " + reliefScript);
  }

  const mode = (body.mode || rep.mode || "relief").toLowerCase(); // relief | voxel | depth
  if (mode !== "relief" && mode !== "voxel" && mode !== "depth") {
    throw new Error(`不支持的本地重建 mode: ${mode}`);
  }
  const tiles = Math.min(Math.max(parseInt(body.tiles ?? rep.tiles ?? 3, 10), 1), 8);
  const resolution = Math.min(Math.max(parseInt(body.resolution ?? rep.resolution ?? 128, 10), 16), 512);
  const depth = Math.min(Math.max(parseFloat(body.depth ?? rep.depth ?? 0.35), 0.02), 2);
  // 默认内嵌原图贴图，保证生成结果保留颜色（设为 false 可得到纯灰白浮雕，便于教学高亮）
  const useTexture = !!(body.texture ?? rep.texture ?? true);
  // depth 模式给模型真实厚度（侧墙 + 底盖），从背面看也是实体；relief/voxel 保持单面薄片
  const thicknessArgs = [];
  if (mode === "depth") {
    const thickness = Math.min(Math.max(parseFloat(body.thickness ?? rep.thickness ?? 0.08), 0), 1);
    thicknessArgs.push("--thickness", String(thickness));
  }

  const job = createLocalJob(deps);
  await deps.fs.promises.writeFile(job.image, Buffer.from(imageBase64, "base64"));

  const args = [
    "--background", "--python", reliefScript, "--",
    "--image", job.image,
    "--output", job.output,
    "--manifest", job.manifest,
    "--mode", mode,
    "--tiles", String(tiles),
    "--resolution", String(resolution),
    "--depth", String(depth),
    ...thicknessArgs,
  ];
  if (useTexture) args.push("--texture");

  console.log(`  🧊 图片转3D: 本地 Blender 可拆解重建 ${reliefScript} (mode=${mode}, tiles=${tiles}, tex=${useTexture})`);
  let stdout = "";
  let stderr = "";
  try {
    const r = await deps.execFile(deps.blenderPath, args, {
      timeout: IMAGE_TO_3D_TIMEOUTS.blenderRelief,
      maxBuffer: 200 * 1024 * 1024,
    });
    stdout = r.stdout || "";
    stderr = r.stderr || "";
  } catch (berr) {
    // Blender 后台模式常因无关 addon（如 tripo_addon）卸载时的异步清理而以非零码退出，
    // 但 GLB 往往已成功写出。因此先记录诊断信息，是否成功以 GLB 是否产出为准（见下方判断）。
    stderr = (berr.stderr || "") + (berr.stdout || "");
    console.warn(`  ⚠️ Blender 进程返回非零退出码（可能无关），将检查 GLB 是否已生成: ${String(berr.message || "").slice(0, 300)}`);
  }
  if (stdout) console.log(`  📤 Blender stdout:\n${stdout.slice(0, 2000)}`);
  if (stderr) console.log(`  📤 Blender stderr:\n${stderr.slice(0, 2000)}`);

  if (!deps.fs.existsSync(job.output)) {
    throw new Error(
      `本地可拆解重建未生成 GLB 文件。请确认 Blender 可正常运行（${deps.blenderPath}）。` +
      `Blender stderr: ${stderr.slice(0, 800)}`
    );
  }

  const { glbBuffer, manifest } = await readLocalJobResult(deps, job);

  console.log(`  ✅ 图片转3D（本地·可拆解·${tiles}×${tiles}块）完成 (${(glbBuffer.length / 1024).toFixed(1)} KB, parts=${manifest.total_parts})`);
  return { glbBuffer, manifest };
}

// ── VLM 路线 ────────────────────────────────────────

/**
 * VLM 视觉模型程序化重建（图片转3D 的 VLM 路线）
 * 调用 scripts/vlm_img_to_blender.py：视觉模型看图→生成 Blender 代码→沙箱执行+自动修复→导出 GLB
 */
async function runVlmImageTo3D(vlmCfg, body, imageBase64, deps) {
  // 每次请求一组唯一路径：固定名（vlm_in.png / vlm_img_to_3d.glb）在并发请求下会互相
  // 覆盖输入图片与产物 GLB，后到的请求会读到前一个请求的文件
  const { image: imgPath, glb: glbPath, code: codePath } = createVlmJobPaths(deps.os.tmpdir(), deps.path);
  try {
    const provider = vlmCfg?.provider || "stepfun";
    const model = vlmCfg?.model || "step-3.7-flash";
    await deps.fs.promises.writeFile(imgPath, Buffer.from(imageBase64, "base64"));

    const script = deps.path.join(deps.rootDir, "scripts", "vlm_img_to_blender.py");
    const args = [
      "--provider", provider,
      "--model", model,
      "--image", imgPath,
      "--out", glbPath,
      "--code-out", codePath,
    ];
    console.log(`  🤖 图片转3D(VLM): spawn ${provider}/${model}`);

    const child = deps.spawn("python3", [script, ...args], { cwd: deps.rootDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));

    const exitCode = await waitForChildExit(child, IMAGE_TO_3D_TIMEOUTS.vlm, `VLM 脚本（${provider}/${model}）`);
    if (exitCode !== 0) {
      throw new Error(`VLM 脚本退出 ${exitCode}: ${stderr.slice(-800)}`);
    }

    if (!deps.fs.existsSync(glbPath)) {
      throw new Error("VLM 未导出 GLB；脚本输出: " + stdout.slice(-600));
    }
    const glbBuffer = await deps.fs.promises.readFile(glbPath);
    console.log(`  ✅ 图片转3D(VLM) 完成 (${(glbBuffer.length / 1024).toFixed(1)} KB)`);
    return { glbBuffer, manifest: { total_parts: 0, parts: [] } };
  } finally {
    // 产物已读进内存（或本次请求已失败），把这三个文件收掉，别让系统临时目录
    // 按请求数堆积；万一进程被杀，server-utils 的 TTL 清理会兜底
    for (const file of [imgPath, glbPath, codePath]) {
      try {
        deps.fs.rmSync(file, { force: true });
      } catch {
        // 清理失败不影响已经返回给客户端的结果
      }
    }
  }
}

// ── Replicate 云端路线 ──────────────────────────────

/**
 * 云端 Replicate 图片转3D：上传文件 → 创建预测 → 轮询 → 下载 GLB。
 * requestedMode 为调用方原始 deploy：仅当显式选择「云端」时才使用 body.model 作为
 * 云端模型；本地模式回退到云端时，body.model 是本地生成方式（relief/voxel/depth 等），
 * 不能当作 Replicate 模型名。
 */
async function runReplicateImageTo3D(body, imageBase64, mime, requestedMode, config, deps) {
  const rep = config.replicate || {};
  const token = rep.token;
  if (!token) {
    throw Object.assign(
      new Error(
        "图片转3D 失败：未配置 Replicate Token。请先在 ai-config.html 填写 Replicate API Token（及模型 owner/name），" +
          "并在下拉框选择「Replicate 云端」；或运行 `bash scripts/setup_triposr.sh` 准备本地 TripoSR 真重建环境。"
      ),
      { status: 400 }
    );
  }
  const imageBytes = Buffer.from(imageBase64, "base64");
  const auth = { Authorization: `Bearer ${token}` };

  // 1. 上传图片到 Replicate 文件服务，换取可访问 URL
  //    注意：Replicate /v1/files 要求 multipart/form-data，文件字段名为 "content"
  console.log(`  ☁️ 图片转3D: 上传图片到 Replicate (${(imageBytes.length / 1024).toFixed(1)} KB)`);
  const form = new FormData();
  form.append("content", new Blob([imageBytes], { type: mime }), "image.png");
  const uploadRes = await fetch(`${REPLICATE_BASE}/files`, {
    method: "POST",
    headers: auth, // 不手动设 Content-Type，由 fetch 自动附加 multipart boundary
    body: form,
  });
  if (!uploadRes.ok) {
    const t = await uploadRes.text();
    throw new Error(`Replicate 文件上传失败 ${uploadRes.status}: ${t.slice(0, 500)}`);
  }
  const uploadJson = await uploadRes.json();
  const fileUrl = uploadJson?.urls?.get;
  if (!fileUrl) throw new Error("Replicate 未返回文件 URL");

  // 2. 创建预测任务（请求体里的 model 可临时覆盖配置；优先用 modelVersion，否则自动解析模型最新版本）
  //    注意：Replicate 已弃用 /models/{owner}/{name}/predictions 路由，创建预测必须用 /v1/predictions + version
  const reqModel = requestedMode === "replicate" ? body.model : undefined;
  const [reqOwner, reqName] = reqModel ? reqModel.split("/") : [];
  const owner = reqOwner || rep.owner || "tencent";
  const name = reqName || rep.name || "hunyuan3d-2";
  let version = body.modelVersion || rep.modelVersion;
  if (!version) {
    const mRes = await fetch(`${REPLICATE_BASE}/models/${owner}/${name}`, { headers: auth });
    if (!mRes.ok) {
      const t = await mRes.text();
      throw new Error(`获取模型 ${owner}/${name} 版本失败 ${mRes.status}: ${t.slice(0, 300)}`);
    }
    const mJson = await mRes.json();
    version = mJson?.latest_version?.id;
    if (!version) throw new Error(`模型 ${owner}/${name} 未找到可用版本`);
  }
  const predUrl = `${REPLICATE_BASE}/predictions`;
  const predBody = { version, input: { image: fileUrl } };
  console.log(`  🚀 图片转3D: 创建 Replicate 预测 ${owner}/${name}`);
  const predRes = await fetch(predUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(predBody),
  });
  if (!predRes.ok) {
    const t = await predRes.text();
    // 余额不足（402）：给出中文指引，避免暴露原始英文报错
    if (predRes.status === 402) {
      throw new Error(
        "Replicate 余额不足：请到 https://replicate.com/account/billing 绑定支付方式并充值，" +
          "等待几分钟后重试。当前图片转3D功能需要在 Replicate 上消耗额度。"
      );
    }
    throw new Error(`Replicate 预测创建失败 ${predRes.status}: ${t.slice(0, 500)}`);
  }
  const pred = await predRes.json();
  const predId = pred.id;
  if (!predId) throw new Error("Replicate 未返回预测 ID");

  // 3. 轮询任务状态（最长 8 分钟），复用 providers 的 pollTask
  let result = pred;
  const isTerminal = s => s === "succeeded" || s === "failed" || s === "canceled";
  if (!isTerminal(result.status)) {
    await pollTask({
      deadline: Date.now() + IMAGE_TO_3D_TIMEOUTS.replicate,
      timeoutMsg: "Replicate 任务超时（8 分钟）",
      intervalMs: 4000,
      checkStatus: async () => {
        const pr = await fetch(`${REPLICATE_BASE}/predictions/${predId}`, { headers: auth });
        if (!pr.ok) throw new Error(`Replicate 状态查询失败 ${pr.status}`);
        result = await pr.json();
        const detail = result.error ? " - " + JSON.stringify(result.error) : "";
        return {
          done: result.status === "succeeded",
          failed: isTerminal(result.status),
          error: `Replicate 任务失败: ${result.status}${detail}`,
        };
      },
    });
  }
  if (result.status !== "succeeded") {
    const detail = result.error ? " - " + JSON.stringify(result.error) : "";
    throw new Error(`Replicate 任务失败: ${result.status}${detail}`);
  }

  // 4. 解析输出（TripoSR 返回单个 glb 文件 URL；兼容数组/对象）
  const out = result.output;
  let glbUrl = null;
  if (typeof out === "string") glbUrl = out;
  else if (Array.isArray(out)) glbUrl = typeof out[0] === "string" ? out[0] : out[0]?.url;
  else if (out && typeof out === "object") glbUrl = out.url || out.mesh || out.model;
  if (!glbUrl) throw new Error("Replicate 输出中未找到 GLB 文件 URL");

  // 5. 下载 GLB
  console.log("  ⬇️ 图片转3D: 下载生成的 GLB...");
  const glbRes = await fetch(glbUrl);
  if (!glbRes.ok) throw new Error(`GLB 下载失败 ${glbRes.status}`);
  const glbBuffer = Buffer.from(await glbRes.arrayBuffer());

  console.log(`  ✅ 图片转3D 完成 (${(glbBuffer.length / 1024).toFixed(1)} KB)`);
  return { glbBuffer, manifest: { total_parts: 0, parts: [] } };
}

// ── 临时任务文件生命周期（本地两条路线共用） ──────────

function createLocalJob(deps) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    image: deps.path.join(deps.uploadDir, `img3d-${id}.png`),
    output: deps.path.join(deps.uploadDir, `img3d-${id}.glb`),
    manifest: deps.path.join(deps.uploadDir, `img3d-${id}.json`),
  };
}

async function cleanupJob(deps, job) {
  await Promise.all(
    [job.image, job.output, job.manifest].map(f => deps.fs.promises.unlink(f).catch(() => {}))
  );
}

/**
 * 读回本地推理产物（GLB + manifest）并清理临时目录。
 * manifest 缺失或非法时回落 { total_parts: 0, parts: [] }，清理必定执行；
 * TripoSR 真重建与 Blender 可拆解重建两条本地路线的回读逻辑逐字相同。
 */
export async function readLocalJobResult(deps, job) {
  const glbBuffer = await deps.fs.promises.readFile(job.output);
  let manifest = { total_parts: 0, parts: [] };
  if (deps.fs.existsSync(job.manifest)) {
    try {
      manifest = JSON.parse(await deps.fs.promises.readFile(job.manifest, "utf-8"));
    } catch { /* 用默认 manifest */ }
  }

  await cleanupJob(deps, job);
  return { glbBuffer, manifest };
}
