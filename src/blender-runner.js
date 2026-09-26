// Blender 后台任务运行时（从 server.js 抽取，行为不变）。
//
// 搬迁 server.js 的「Blender 单飞守卫」段：一个 createBlenderJobQueue 串行
// 队列 + runBlenderAIPaint / runBlenderSplit。两者都经 enqueueBlenderJob 排到
// 同一条链上，「任意时刻只有一个 --background Blender 在跑」这条约束于是在本
// 模块内闭环；GUI 窗口那一半（activeBlenderChild）不在此段，见
// src/response-utils.js 的 openInBlender。
//
// DI / 接缝（createBlenderRunner 工厂，与 createResponseUtils 同构）：
//   · blenderPath / rootDir：启动期探测到的 Blender 路径与仓库根。两个
//     blender_*.py 脚本按仓库根定位，本模块位于 src/ 下，直接用自身 __dirname
//     会少一级，故显式注入；
//   · execFile：注入 promisify 后的 execFile，测试用假实现即可断言命令行参数
//     与串行语义，不必真跑 Blender；
//   · 队列复用 src/server-utils.js 的 createBlenderJobQueue，随段内置。
import path from "path";
import { createBlenderJobQueue } from "./server-utils.js";

// ── Blender 单飞守卫 ──────────────────────────────────

export function createBlenderRunner({ blenderPath, rootDir, execFile }) {
// 确保本服务器进程同一时刻最多只持有「一个」Blender：
//   · 后台任务（拆解 / AI 绘画，均为 --background 无窗口）串行执行，互不重叠；
//   · GUI 打开前先结束上一个由本服务器拉起的 Blender，避免窗口堆叠。
// 注：常驻的 Blender MCP 宿主（用户自行启动、监听 9876）不在此管理范围内，保留不动。

const blenderJobQueue = createBlenderJobQueue();

/** 后台 Blender 任务串行器：保证任意时刻只有一个 --background Blender 在跑 */
function enqueueBlenderJob(task) {
  return blenderJobQueue.enqueue(task);
}

/**
 * 调用 Blender CLI 进行 AI 绘画（生成模型）
 */
async function runBlenderAIPaint(prompt, outputPath, manifestPath, imageFeaturesPath) {
  const scriptPath = path.join(rootDir, "blender_ai_paint.py");
  const args = [
    "--factory-startup",
    "--background",
    "--python",
    scriptPath,
    "--",
    "--prompt",
    prompt,
    "--output",
    outputPath,
    "--manifest",
    manifestPath,
  ];

  // 如果有图片特征文件，传递给 Blender
  if (imageFeaturesPath) {
    args.push("--image-features", imageFeaturesPath);
  }

  console.log(`  🎨 AI 绘画: ${blenderPath} ${args.join(" ")}`);

  // 单飞守卫：与其他后台 Blender 任务串行，确保同一时刻只跑一个
  return enqueueBlenderJob(() =>
    execFile(blenderPath, args, {
      timeout: 120_000, // 2 分钟超时
      maxBuffer: 50 * 1024 * 1024,
    })
  );
}

/**
 * 调用 Blender CLI 拆解 GLB
 */
async function runBlenderSplit(inputPath, outputPath, manifestPath, originalFileName, vlm = null) {
  const scriptPath = path.join(rootDir, "blender_split_glb.py");
  const args = [
    "--factory-startup",
    "--background",
    "--python",
    scriptPath,
    "--",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--manifest",
    manifestPath,
    "--original-filename",
    originalFileName,
  ];

  // 可选的 VLM 部件语义标注：把 provider/model 作为命令行参数传入；
  // API Key 只通过环境变量 VLM_API_KEY 安全传递（绝不出现在命令行，避免 ps 泄露）。
  let env = process.env;
  if (vlm && vlm.provider) {
    args.push("--vlm-provider", vlm.provider);
    if (vlm.model) args.push("--vlm-model", vlm.model);
    if (vlm.key) env = { ...process.env, VLM_API_KEY: vlm.key };
  }

  console.log(`  🔧 调用 Blender: ${blenderPath} ${args.join(" ")}`);

  // 单飞守卫：与其他后台 Blender 任务串行，确保同一时刻只跑一个
  return enqueueBlenderJob(() =>
    execFile(blenderPath, args, {
      timeout: 600_000, // 10 分钟超时（大模型需要更久）
      maxBuffer: 50 * 1024 * 1024,
      env,
    })
  );
}

  return { runBlenderAIPaint, runBlenderSplit };
}
