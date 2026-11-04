// 连通分量核心算法（纯函数，无 three / DOM 依赖）。
//
// 与 geometry-split.js 的 splitByConnectedComponents 共享同一套 UnionFind 语义：
// 按「三角形三条边连接顶点」归并分量；本文件抽出序列化边界（typed array 进、
// 分量分组出），供 Web Worker 与 Node 单测共用，是 Worker 化拆分（three-mesh-bvh
// ParallelMeshBVHWorker 的分层范式：core 纯函数 + worker 壳 + 客户端）的第一层。
//
// 序列化约定：
//   输入 position 为 Float32Array(x,y,z ...)，index 为 Uint32Array（可能为 null，
//   非索引几何用顶点序号即面序号）；
//   输出 components 为按面数降序的分量数组，每项 { faceCount, faces: Uint32Array }，
//   其中 faces 为该分量包含的三角形索引（0 起），小分量过滤阈值与
//   splitByConnectedComponents 相同（默认 < 12 面并入杂项分量，见 SMALL_FACE_LIMIT）。

export const SMALL_FACE_LIMIT = 12;

/**
 * 计算几何体的连通分量分组（三角形索引级，不构建新几何体）。
 * @param {Float32Array} position 顶点坐标（xyz 连续）
 * @param {Uint32Array|Uint16Array|null} index 三角形索引；null 表示非索引几何
 * @param {object} [options]
 * @param {number} [options.smallFaceLimit=12] 小分量过滤阈值，小于该面数的分量并入杂项
 * @param {() => void} [options.onProgress] 每处理一个三角形后的进度回调（Worker 内用）
 * @returns {{ components: Array<{faceCount: number, faces: Uint32Array}>, misc: Uint32Array }}
 */
export function computeConnectedComponents(position, index, options = {}) {
  const smallFaceLimit = options.smallFaceLimit ?? SMALL_FACE_LIMIT;
  const onProgress = options.onProgress || null;
  const vertexCount = position.length / 3;
  if (vertexCount === 0) return { components: [], misc: new Uint32Array(0) };

  const faceCount = index ? index.length / 3 : vertexCount / 3;
  if (faceCount === 0) return { components: [], misc: new Uint32Array(0) };

  // UnionFind（与 src/utils.js 相同的路径压缩实现；此处内联以保持零依赖，
  // Worker 端与主线程端语义一致，避免两份 three 实例的模块边界问题）
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const reportEvery = Math.max(1, Math.floor(faceCount / 100));
  for (let f = 0; f < faceCount; f++) {
    const v0 = index ? index[f * 3] : f * 3;
    const v1 = index ? index[f * 3 + 1] : f * 3 + 1;
    const v2 = index ? index[f * 3 + 2] : f * 3 + 2;
    union(v0, v1);
    union(v1, v2);
    union(v2, v0);
    if (onProgress && f % reportEvery === 0) onProgress(f, faceCount);
  }

  // 按根节点分组面
  const componentFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    const v0 = index ? index[f * 3] : f * 3;
    const root = find(v0);
    let arr = componentFaces.get(root);
    if (!arr) {
      arr = [];
      componentFaces.set(root, arr);
    }
    arr.push(f);
  }

  // 面数降序；大分量单独成组，小分量并入杂项（与既有实现一致）
  const sorted = [...componentFaces.entries()].sort((a, b) => b[1].length - a[1].length);
  const components = [];
  const misc = [];
  for (const [, faces] of sorted) {
    if (faces.length >= smallFaceLimit) {
      components.push({ faceCount: faces.length, faces: Uint32Array.from(faces) });
    } else {
      misc.push(...faces);
    }
  }
  return { components, misc: Uint32Array.from(misc) };
}

