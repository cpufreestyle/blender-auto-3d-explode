// AI 配置存储与配置路由（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的「AI 配置存储」段：AI_CONFIG 默认值（模型清单取自
// src/provider-models.js 单一来源）+ 落盘加载（与默认值深合并，避免缺
// 字段崩溃）+ 首次使用自动探测本地 LLM + probeAuth / PROVIDER_PROBES
// （只读鉴权探测，不消耗额度）+ /api/ai-config GET·POST、/api/ai-test、
// /api/test-provider 四个 handler。
//
// AI_CONFIG 以 let 导出：server.js 的 callAI / handleSplit / 图片转3D
// 编排等消费方经 ESM live binding 读到最新值（POST 保存后整体换新对象）。
//
// DI / 接缝：
//   - createAIConfigHandlers({ readBody, sendJSON, callAI })：四个 handler
//     闭包捕获这三个 server.js 函数（handleAITest 经 callAI 调 AI，运行期
//     才调用，故早于 callAI 声明处创建实例也安全）；
//   - loadAIConfig(filePath = CONFIG_FILE)：文件路径可传（测试指向临时
//     文件；setConfigFilePath 改全局默认）。默认路径为 server.js 同级的
//     ai-config.json，故本模块用 __dirname/.. 定位。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MODELS } from "./provider-models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AI 配置存储
 */
export let AI_CONFIG = {
  provider: 'openai',
  openai: { key: '', model: DEFAULT_MODELS.openai },
  anthropic: { key: '', model: DEFAULT_MODELS.anthropic },
  ollama: { url: 'http://localhost:11434', model: DEFAULT_MODELS.ollama },
  lmstudio: { url: 'http://localhost:1234/v1', model: DEFAULT_MODELS.lmstudio },
  stepfun: { key: '', model: DEFAULT_MODELS.stepfun },
  nvidia: { key: '', model: DEFAULT_MODELS.nvidia, base_url: 'https://integrate.api.nvidia.com/v1' },
  // Kimi（月之暗面 / Moonshot AI）— OpenAI 兼容接口；默认最新旗舰 kimi-k3（原生 1M 上下文）
  kimi: { key: '', model: 'kimi-k3', longContext: false },
  // 生成的三维模型完成后是否自动用 Blender GUI 打开显示（默认关闭，避免每次生成都弹出 Blender 窗口）
  openInBlender: false,
  // 拆解时是否用 VLM 给每个部件标注语义名称（默认关闭；开启需同时配置 vlm provider/model 及对应 provider 的 API Key）
  semanticLabel: false,
  // 图片转 3D：mode=local 调用本地 TripoSR 真重建（scripts/triposr_infer.py，离线推理，需先 bash scripts/setup_triposr.sh）；
  //          mode=replicate 走 Replicate 云端（token/owner/name/modelVersion）
  replicate: {
    mode: 'local',
    // 本地真重建（TripoSR）参数
    mcResolution: 256,
    bakeTexture: false,
    removeBg: false,
    device: 'auto',
    textureResolution: 2048,
    token: '',
    owner: 'tencent',
    name: 'hunyuan3d-2',
    modelVersion: ''
  },
  // 图片转 3D 第三方云端提供商（Meshy / Tripo / Hyper3D-Rodin）的 API Key 配置。
  // mode 可直接设为 "meshy" / "tripo" / "hyper3d" 来走对应云端（与 MCP tools 一致）。
  providers: {
    meshy: { apiKey: '' },
    tripo: { apiKey: '', model: 'v3.1-20260211' },
    hyper3d: { apiKey: '', mode: 'MAIN_SITE' },
  },
};

// 加载保存的配置（与默认值深度合并，避免缺字段导致崩溃）
export let CONFIG_FILE = path.join(__dirname, "..", "ai-config.json");

// 测试接缝：把配置文件指向临时路径（默认值为仓库根 ai-config.json）
export function setConfigFilePath(p) {
  CONFIG_FILE = p;
}

export function loadAIConfig(filePath = CONFIG_FILE) {
  try {
    if (fs.existsSync(filePath)) {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      AI_CONFIG = {
        ...AI_CONFIG,
        ...loaded,
        openai: { ...AI_CONFIG.openai, ...(loaded.openai || {}) },
        anthropic: { ...AI_CONFIG.anthropic, ...(loaded.anthropic || {}) },
        ollama: { ...AI_CONFIG.ollama, ...(loaded.ollama || {}) },
        lmstudio: { ...AI_CONFIG.lmstudio, ...(loaded.lmstudio || {}) },
        stepfun: { ...AI_CONFIG.stepfun, ...(loaded.stepfun || {}) },
        nvidia: { ...AI_CONFIG.nvidia, ...(loaded.nvidia || {}) },
        kimi: { ...AI_CONFIG.kimi, ...(loaded.kimi || {}) },
        replicate: { ...AI_CONFIG.replicate, ...(loaded.replicate || {}) },
        providers: { ...AI_CONFIG.providers, ...(loaded.providers || {}) },
      };
      console.log('  ✅ AI 配置已加载');
    }
  } catch (err) {
    console.log('  ⚠️  无法加载 AI 配置:', err.message);
  }
}

// ── 首次使用：自动探测本地 LLM 作为默认 provider ──
// 若当前 provider 可用（本地 ollama/lmstudio，或已配置 Key 的云端）则不动；
// 否则探测 ollama/lmstudio，命中即用，避免「首次打开就要求填 API Key」。
export async function autoDetectProvider() {
  const keyed = (p) => !!(AI_CONFIG[p] && (AI_CONFIG[p].key || AI_CONFIG[p].apiKey));
  const cur = AI_CONFIG.provider;
  const curUsable = cur === "ollama" || cur === "lmstudio" || keyed(cur);
  if (curUsable) return;
  const probes = [
    { name: "ollama", url: (AI_CONFIG.ollama?.url || "http://localhost:11434") + "/api/tags" },
    { name: "lmstudio", url: (AI_CONFIG.lmstudio?.url || "http://localhost:1234/v1/models") },
  ];
  for (const p of probes) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(p.url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        AI_CONFIG.provider = p.name;
        console.log(`  🤖 未配置可用 provider，已自动选用本地 ${p.name}`);
        return;
      }
    } catch { }
  }
}

/**
 * 轻量探测某个需要鉴权的端点：
 *   - 2xx         → 鉴权通过（key 有效）
 *   - 401/403     → 鉴权失败（key 无效）
 *   - 其它/网络错 → 无法确定（避免误报无效，提示用生成验证）
 * 都不发起真正生成，不消耗额度。
 */
async function probeAuth(method, url, headers, body) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "invalid", message: `API Key 无效（HTTP ${res.status}）`, httpStatus: res.status };
    }
    if (res.ok) {
      return { status: "valid", message: `API Key 有效（HTTP ${res.status}）`, httpStatus: res.status };
    }
    return {
      status: "uncertain",
      message: `无法静态校验（HTTP ${res.status}），建议直接生成一次验证`,
      httpStatus: res.status,
    };
  } catch (err) {
    return { status: "uncertain", message: `无法连接（${err.name === "AbortError" ? "超时" : err.message}），建议直接生成验证`, httpStatus: 0 };
  }
}

// 各厂商的只读/鉴权探测（不消耗额度）
const PROVIDER_PROBES = {
  meshy: (key) =>
    probeAuth("GET", "https://api.meshy.ai/openapi/v1/image-to-3d", {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    }),
  tripo: (key) =>
    probeAuth("GET", "https://openapi.tripo3d.ai/v3/tasks", {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    }),
  // Rodin status 需要 subscription_key，但鉴权失败会返回 401；用占位 key 即可区分「key 是否有效」
  hyper3d: (key) =>
    probeAuth(
      "POST",
      "https://hyperhuman.deemos.com/api/v2/status",
      { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      { subscription_key: "00000000-0000-0000-0000-000000000000" }
    ),
};

export function createAIConfigHandlers({ readBody, sendJSON, callAI }) {

  /**
   * 获取 AI 配置
   */
  function handleAIConfigGet(req, res) {
    // 返回配置（隐藏 API Key）
    const safeConfig = {
      // 是否已保存过配置文件：用于前端判断「首次使用」引导
      saved: fs.existsSync(CONFIG_FILE),
      // 是否已配置 Replicate Token（不泄露明文，仅供前端决定默认部署方式）
      replicateConfigured: Boolean(AI_CONFIG.replicate && AI_CONFIG.replicate.token),
      provider: AI_CONFIG.provider,
      openai: { ...AI_CONFIG.openai, key: AI_CONFIG.openai.key ? '***' : '' },
      anthropic: { ...AI_CONFIG.anthropic, key: AI_CONFIG.anthropic.key ? '***' : '' },
      ollama: AI_CONFIG.ollama,
      lmstudio: AI_CONFIG.lmstudio,
      stepfun: { ...AI_CONFIG.stepfun, key: AI_CONFIG.stepfun.key ? '***' : '' },
      nvidia: { ...AI_CONFIG.nvidia, key: AI_CONFIG.nvidia.key ? '***' : '' },
      kimi: { ...AI_CONFIG.kimi, key: AI_CONFIG.kimi.key ? '***' : '' },
      replicate: {
        mode: AI_CONFIG.replicate?.mode || 'local',
        mcResolution: AI_CONFIG.replicate?.mcResolution ?? 256,
        bakeTexture: AI_CONFIG.replicate?.bakeTexture ?? false,
        removeBg: AI_CONFIG.replicate?.removeBg ?? false,
        device: AI_CONFIG.replicate?.device || 'auto',
        token: (AI_CONFIG.replicate?.token) ? '***' : '',
        owner: AI_CONFIG.replicate?.owner || 'tencent',
        name: AI_CONFIG.replicate?.name || 'hunyuan3d-2',
        modelVersion: AI_CONFIG.replicate?.modelVersion || '',
      },
      providers: {
        meshy: { apiKey: (AI_CONFIG.providers?.meshy?.apiKey) ? '***' : '' },
        tripo: { apiKey: (AI_CONFIG.providers?.tripo?.apiKey) ? '***' : '' },
        hyper3d: { apiKey: (AI_CONFIG.providers?.hyper3d?.apiKey) ? '***' : '' },
      },
      // 图片转3D 的 VLM 视觉模型路线（无 Key，仅 provider/model）
      vlm: AI_CONFIG.vlm ? { provider: AI_CONFIG.vlm.provider, model: AI_CONFIG.vlm.model } : undefined,
      openInBlender: AI_CONFIG.openInBlender !== false,
      // 拆解时是否用 VLM 标注部件语义（默认关闭）
      semanticLabel: AI_CONFIG.semanticLabel === true,
    };
    sendJSON(res, 200, safeConfig);
  }

  /**
   * 保存 AI 配置
   */
  function handleAIConfigPost(req, res) {
    readBody(req, { maxSize: 10 * 1024 })
      .then(config => {
        // 保留现有的 API Key（新值为空或脱敏占位 '***' 时视为未修改）
        if (config.openai && (!config.openai.key || config.openai.key === '***')) {
          config.openai.key = AI_CONFIG.openai.key;
        }
        if (config.anthropic && (!config.anthropic.key || config.anthropic.key === '***')) {
          config.anthropic.key = AI_CONFIG.anthropic.key;
        }
        if (config.stepfun && (!config.stepfun.key || config.stepfun.key === '***')) {
          config.stepfun.key = AI_CONFIG.stepfun.key;
        }
        if (config.nvidia && (!config.nvidia.key || config.nvidia.key === '***')) {
          config.nvidia.key = AI_CONFIG.nvidia.key;
        }
        // 保留现有的 Kimi Token（脱敏值 '***' 或空都视为未修改）
        if (config.kimi) {
          const existingKimi = (AI_CONFIG.kimi || {}).key || '';
          if (!config.kimi.key || config.kimi.key === '***') {
            config.kimi.key = existingKimi;
          }
        }
        // 保留现有的 Replicate Token（脱敏值 '***' 或空都视为未修改）
        if (config.replicate) {
          const existing = (AI_CONFIG.replicate || {}).token || '';
          if (!config.replicate.token || config.replicate.token === '***') {
            config.replicate.token = existing;
          }
        }
        // 保留现有的第三方提供商 API Key（脱敏值 '***' 或空都视为未修改）
        if (config.providers) {
          for (const p of ['meshy', 'tripo', 'hyper3d']) {
            const existing = (AI_CONFIG.providers?.[p] || {}).apiKey || '';
            if (!config.providers[p]) config.providers[p] = {};
            if (!config.providers[p].apiKey || config.providers[p].apiKey === '***') {
              config.providers[p].apiKey = existing;
            }
          }
        }

        AI_CONFIG = { ...AI_CONFIG, ...config };

        // 保存到文件
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(AI_CONFIG, null, 2));

        sendJSON(res, 200, { success: true, message: '配置已保存' });
      })
      .catch(err => {
        sendJSON(res, 400, { success: false, error: err.message });
      });
  }

  /**
   * 测试 AI 连接
   */
  async function handleAITest(req, res) {
    try {
      const body = await readBody(req, { maxSize: 10 * 1024 });
      const prompt = body.prompt || 'Hello';

      // 根据配置调用相应的 AI
      const result = await callAI(prompt);

      sendJSON(res, 200, { success: true, result });
    } catch (err) {
      sendJSON(res, 500, { success: false, error: err.message });
    }
  }


  /**
   * POST /api/test-provider  { provider, apiKey }
   * 校验某家 3D 生成厂商 API Key 是否有效（只读探测，不生成）
   */
  async function handleProviderTest(req, res) {
    try {
      const body = await readBody(req, { maxSize: 10 * 1024 });
      const provider = body.provider;
      const apiKey = (body.apiKey || "").trim();
      const probe = PROVIDER_PROBES[provider];
      if (!probe) {
        sendJSON(res, 400, { status: "invalid", message: `未知提供商: ${provider}` });
        return;
      }
      if (!apiKey) {
        sendJSON(res, 400, { status: "invalid", message: "API Key 为空" });
        return;
      }
      const result = await probe(apiKey);
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 500, { status: "uncertain", message: err.message });
    }
  }

  return {
    handleAIConfigGet,
    handleAIConfigPost,
    handleAITest,
    handleProviderTest,
  };
}

