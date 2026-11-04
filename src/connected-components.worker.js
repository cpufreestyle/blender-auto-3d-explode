// 连通分量 Worker 壳（three-mesh-bvh ParallelMeshBVHWorker 范式的第二层）。
//
// 协议：接收 { position, index } typed array（transferable），回传
// { components, misc } —— 分量数组每项 { faceCount, faces }，faces 为 Uint32Array。
// 仅做计算不做几何构建（构建需要 three，主线程做，见 geometry-split.js 的
// splitByConnectedComponentsAsync）。
import { computeConnectedComponents } from "./connected-components-core.js";

self.onmessage = e => {
  const { position, index } = e.data;
  try {
    const result = computeConnectedComponents(position, index);
    // 结果 buffers transfer 回主线程：分量数据只走一趟，不经过结构化克隆拷贝
    const transferList = result.components.map(c => c.faces.buffer);
    transferList.push(result.misc.buffer);
    self.postMessage({ result }, transferList);
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
};

