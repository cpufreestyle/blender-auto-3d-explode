// 连通分量 Worker 客户端（three-mesh-bvh ParallelMeshBVHWorker 范式的第三层）。
//
// 设计要点（对照 three-mesh-bvh WorkerBase）：
//   - running 标志：同一时刻只跑一个任务，重入直接抛错；
//   - dispose：terminate + 置空引用；
//   - Worker 构造失败（file:// 下、旧浏览器、Node 测试环境）返回 null 而非抛错，
//     调用方回退同步实现 —— 主线程永不因 Worker 不可用而拆分失败。
//
// 输入 typed array 会被 transfer 走（neutered），调用方不得复用；如需保留原
// 几何体数据，先 slice。与 three-mesh-bvh 的 ParallelMeshBVHWorker 相同约定。

import { computeConnectedComponents } from "./connected-components-core.js";

/**
 * 创建连通分量 Worker 客户端。Worker 不可用时返回 null。
 * @returns {{ generate(geometryLike): Promise, dispose(): void, running: boolean } | null}
 */
export function createConnectedComponentsWorker() {
  let worker = null;
  try {
    worker = new Worker(new URL("./connected-components.worker.js", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.warn("Connected components worker unavailable, falling back to sync:", err?.message);
    return null;
  }

  let running = false;

  function generate({ position, index, transfer = true }) {
    if (running) return Promise.reject(new Error("ConnectedComponentsWorker: Already running job."));
    running = true;

    const posBuf = position.buffer;
    const idxBuf = index ? index.buffer : null;
    const transferList = transfer ? [posBuf, idxBuf].filter(Boolean) : [];

    return new Promise((resolve, reject) => {
      worker.onmessage = e => {
        running = false;
        worker.onmessage = null;
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve(e.data.result);
        }
      };
      worker.onerror = e => {
        running = false;
        worker.onmessage = null;
        reject(new Error(e.message || "Connected components worker error"));
      };
      worker.postMessage({ position, index }, transferList);
    });
  }

  function dispose() {
    worker.terminate();
    worker = null;
    running = false;
  }

  return { generate, dispose, get running() { return running; } };
}

