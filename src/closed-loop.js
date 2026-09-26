// 全自动闭环：云端生成 → 导入 Blender 实时场景 → 读回（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的「全自动闭环」段：waitForBlenderAddon、handleGenToBlender
// （POST /api/gen-to-blender）、handleBlenderExport（GET /api/blender/export），
// 以及只在这三者之间共享的 lastImportedObject——grep 确认它没有任何外部读者，
// 整段搬走即可，状态随之封闭在新模块内。
//
// DI / 接缝（createClosedLoop 工厂，与仓库既有 createStaticServer /
//   createAIConfigHandlers 同构）：
//   · sendJSON / saveGeneratedModel / callBlenderMcp / launchBlenderApp 来自
//     server.js 的响应工具与接线，注入闭包；
//   · generateImageTo3D 也注入：它是本段唯一直接触网/拉起子进程的一步，
//     与 createAIConfigHandlers({ callAI }) 同理，否则测试只能连真实云端；
//   · IMAGE_TO_3D_DEPS / UPLOAD_DIR 是服务器级配置（前者依赖 BLENDER_PATH 与
//     os.tmpdir()），注入而非各自重建，保证与 /api/split 等路由共用同一份；
//   · rootDir 是调用方的仓库根（server.js 传自己的 __dirname）。原实现在这里
//     用 __dirname 算前端可取的相对 URL，本模块位于 src/ 下，若直接写 __dirname
//     会多出一级 ".." 使 modelUrl 变成 /../models/...，故显式注入；
//   · AI_CONFIG 直接 import（live binding，loadAIConfig 整体重赋值后本模块看到
//     新值，与 src/ai-call.js 同一套前提）；readBody / elapsedSeconds /
//     getCORSHeaders 同理，零胶水。
import fs from "fs";
import path from "path";
import { readBody } from "./body.js";
import { AI_CONFIG } from "./ai-config.js";
import { elapsedSeconds, getCORSHeaders } from "./server-utils.js";

// ── 全自动闭环：云端生成 → 导入 Blender 实时场景 → 读回 ──────────

// 依赖全部带名注入，便于测试用假 sendJSON / 假 MCP 客户端驱动整条链路。
export function createClosedLoop({
  sendJSON,
  generateImageTo3D,
  callBlenderMcp,
  launchBlenderApp,
  saveGeneratedModel,
  IMAGE_TO_3D_DEPS,
  UPLOAD_DIR,
  rootDir,
}) {

// 记录最近一次由本服务器导入 Blender 的对象名，供「读回」默认使用。
let lastImportedObject = null;

/**
 * 等待 Blender MCP addon(9876) 就绪；autoLaunch 为真时先尝试拉起 Blender GUI。
 * @returns {Promise<boolean>} 是否就绪
 */
async function waitForBlenderAddon({ autoLaunch = true, timeoutMs = 30_000 } = {}) {
  const probe = async () => {
    try {
      await callBlenderMcp("get_addon_status", {}, 2000);
      return true;
    } catch {
      return false;
    }
  };
  if (await probe()) return true;
  if (!autoLaunch) return false;
  try {
    launchBlenderApp();
  } catch {
    /* 拉不起来就继续轮询 */
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    if (await probe()) return true;
  }
  return false;
}

/**
 * POST /api/gen-to-blender
 * Body: { image: "data:image/...;base64,...", deploy?: "tripo"|"meshy"|"hyper3d", name?, autoLaunch? }
 * 全自动：云端生成 GLB → 落盘 → 导入 Blender 实时场景 → 返回导入对象与场景信息。
 */
async function handleGenToBlender(req, res) {
  const startTime = Date.now();
  try {
    const body = await readBody(req, { maxSize: 25 * 1024 * 1024 });
    const imageDataUrl = body.image;
    if (!imageDataUrl || !imageDataUrl.startsWith("data:image/")) {
      sendJSON(res, 400, { success: false, error: "缺少有效的图片数据（image 字段应为 data URL）" });
      return;
    }
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(imageDataUrl);
    if (!match) {
      sendJSON(res, 400, { success: false, error: "图片 data URL 格式错误" });
      return;
    }
    const imageBase64 = match[2];
    // 只允许三家云端 provider（历史默认 tripo），其余值一律按 tripo 处理
    const mode = ["meshy", "tripo", "hyper3d"].includes(body.deploy) ? body.deploy : "tripo";

    // 1. 云端生成 GLB（统一走图片转3D 调度器，与 /api/image-to-3d 同一实现）
    const out = await generateImageTo3D({
      mode,
      body,
      imageBase64,
      mime: match[1],
      config: AI_CONFIG,
      deps: IMAGE_TO_3D_DEPS,
    });

    // 2. 落盘（持久化，便于后续拆解/复现）
    const savedPath = saveGeneratedModel(out.glbBuffer, `${mode}-to-blender`);
    // 供前端直接取回展示的相对 URL（静态服务托管 models/generated/）
    const modelUrl = "/" + path.relative(rootDir, savedPath).split(path.sep).join("/");

    // 3. 确保 Blender MCP addon 就绪（必要时自动拉起 Blender GUI）
    const ready = await waitForBlenderAddon({ autoLaunch: body.autoLaunch !== false });
    if (!ready) {
      sendJSON(res, 502, {
        success: false,
        savedPath,
        modelUrl,
        error:
          "Blender MCP addon 未就绪（9876 未监听）。请打开 Blender 并在侧栏点击「Connect to MCP server」后重试。",
      });
      return;
    }

    // 4. 导入 Blender 实时场景
    const name = body.name || `${mode}_model`;
    const imported = await callBlenderMcp("import_glb_from_file", { filepath: savedPath, name }, 120_000);
    if (!imported || imported.succeed === false) {
      sendJSON(res, 502, { success: false, savedPath, error: (imported && imported.error) || "导入 Blender 失败" });
      return;
    }
    lastImportedObject = imported.name || name;

    // 5. 回传场景信息
    let scene = null;
    try {
      scene = await callBlenderMcp("get_scene_info", {}, 10_000);
    } catch {
      /* 非致命：场景信息拿不到也视为导入成功 */
    }

    sendJSON(res, 200, {
      success: true,
      elapsed: elapsedSeconds(startTime),
      savedPath,
      modelUrl,
      imported,
      scene,
    });
  } catch (err) {
    sendJSON(res, err.status || 500, { success: false, error: err.message });
  }
}

/**
 * GET /api/blender/export?name=<对象名>
 * 从 Blender 实时场景导出指定对象为 GLB（默认导出最近一次导入的对象），二进制回传。
 */
async function handleBlenderExport(req, res, url) {
  let name = url.searchParams.get("name") || lastImportedObject;

  // 无显式对象名时，回退到 Blender 当前激活对象 / 场景首个网格对象，
  // 使「从 Blender 读回」在用户未先执行「生成并发送」时也能使用。
  if (!name) {
    try {
      const pick = await callBlenderMcp(
        "execute_code",
        {
          code:
            "import bpy; a=bpy.context.active_object; " +
            "mesh=[o.name for o in bpy.data.objects if o.type=='MESH']; " +
            "print((a.name if (a and a.type=='MESH') else (mesh[0] if mesh else '')))",
        },
        10_000,
      );
      const picked = String((pick && pick.result) || "").trim();
      if (picked) name = picked;
    } catch {
      /* 忽略探测错误，交给下方 400 处理 */
    }
  }

  if (!name) {
    sendJSON(res, 400, {
      success: false,
      error: "Blender 场景中尚无可导出的网格对象，请先在 Blender 中创建或导入对象后再读回",
    });
    return;
  }
  const exportPath = path.join(UPLOAD_DIR, `export-${Date.now()}.glb`);
  try {
    const result = await callBlenderMcp("export_object_glb", { name, filepath: exportPath }, 120_000);
    if (!result || result.succeed === false) {
      sendJSON(res, 502, { success: false, error: (result && result.error) || "从 Blender 导出失败" });
      return;
    }
    if (!fs.existsSync(exportPath)) {
      sendJSON(res, 502, { success: false, error: "导出文件不存在" });
      return;
    }
    const buf = fs.readFileSync(exportPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": buf.length,
      "X-Object-Name": encodeURIComponent(name),
      ...getCORSHeaders(),
    });
    res.end(buf);
  } catch (err) {
    sendJSON(res, 502, { success: false, error: err.message });
  } finally {
    try {
      fs.unlinkSync(exportPath);
    } catch {
      /* 文件不存在则忽略 */
    }
  }
}

  return { handleGenToBlender, handleBlenderExport };
}
