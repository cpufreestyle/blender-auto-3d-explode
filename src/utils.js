/**
 * 纯工具函数模块（无浏览器/Three.js 依赖）
 * 从 main.js 中提取的可独立测试的函数
 */

// ===== Union-Find 数据结构（用于连通分量分析）=====
export class UnionFind {
  constructor(size) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(x) {
    while (this.parent[x] !== x) {
      // 路径压缩
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }

  /**
   * 获取所有连通分量的根节点列表
   * @returns {number[]}
   */
  roots() {
    const set = new Set();
    for (let i = 0; i < this.parent.length; i++) {
      set.add(this.find(i));
    }
    return [...set];
  }

  /**
   * 获取指定元素所在连通分量的大小
   */
  componentSize(x) {
    const root = this.find(x);
    let count = 0;
    for (let i = 0; i < this.parent.length; i++) {
      if (this.find(i) === root) count++;
    }
    return count;
  }
}

// ===== 数学工具 =====

/**
 * 缓动函数：ease-out cubic
 * @param {number} t - 进度 [0, 1]
 * @returns {number}
 */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * 将值限制在 [min, max] 范围内
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 平滑阶梯函数（Hermite 插值）
 * 当 x < edge0 返回 0，当 x > edge1 返回 1，中间平滑过渡
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothStep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge0 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 线性插值
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ===== 字符串工具 =====

/**
 * 检查文件名是否包含 Quest 3（不区分大小写）
 * @param {string} fileName
 * @returns {boolean}
 */
export function isQuest3Model(fileName) {
  const lower = (fileName || "").toLowerCase();
  return lower.includes("quest 3") || lower.includes("quest3");
}

/**
 * 根据部件在包围盒中的位置生成方向性名称
 * @param {number} index - 部件序号
 * @param {{x: number, y: number, z: number}} position - 部件中心位置
 * @param {{min: {x: number, y: number, z: number}, max: {x: number, y: number, z: number}, center: {x: number, y: number, z: number}, size: {x: number, y: number, z: number}}} bbox - 包围盒信息
 * @returns {string}
 */
export function generatePartName(index, position, bbox) {
  const dx = position.x - bbox.center.x;
  const dy = position.y - bbox.center.y;
  const dz = position.z - bbox.center.z;

  const absX = Math.abs(dx), absY = Math.abs(dy), absZ = Math.abs(dz);
  const maxAbs = Math.max(absX, absY, absZ);

  const bboxLength = Math.sqrt(bbox.size.x ** 2 + bbox.size.y ** 2 + bbox.size.z ** 2);

  let direction;
  if (maxAbs < bboxLength * 0.05) {
    direction = "中心";
  } else if (absX === maxAbs) {
    direction = dx > 0 ? "右侧" : "左侧";
  } else if (absY === maxAbs) {
    direction = dy > 0 ? "顶部" : "底部";
  } else {
    direction = dz > 0 ? "前方" : "后方";
  }
  return `部件${index + 1}·${direction}`;
}

// ===== Base64 工具 =====

/**
 * base64 → UTF-8 字符串
 * 兼容浏览器和 Node.js 环境
 * @param {string} base64Str
 * @returns {string}
 */
export function base64ToUtf8(base64Str) {
  if (typeof atob !== "undefined") {
    // 浏览器环境
    const binaryStr = atob(base64Str);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } else {
    // Node.js 环境
    return Buffer.from(base64Str, "base64").toString("utf-8");
  }
}

// ===== 文件大小格式化 =====

/**
 * 格式化字节数为人类可读字符串
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===== GLB 二进制校验 =====

// ===== 拆解步骤计算（从 main.js 提取）=====

/**
 * 根据部件数量计算步骤分组数（纯函数）
 * 步骤数：欢迎(1) + 部件分组 + 完成(1)，最多 8 步
 * @param {number} partCount - 部件数量
 * @returns {number} 分组数（不含欢迎和完成步骤）
 */
export function computeStepGroupCount(partCount) {
  return Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);
}

/**
 * 按离中心距离降序排列部件（外层先拆）
 * 若有装配顺序，优先使用装配顺序
 * @param {Array<{name: string, homePos: {length: () => number}, partCenter?: {length: () => number}}>} parts
 * @param {string[]} [assemblyOrder] - 可选的装配顺序（名称数组）
 * @returns {Array} 排序后的部件数组
 */
export function sortPartsForDisassembly(parts, assemblyOrder) {
  if (assemblyOrder && assemblyOrder.length) {
    const orderIndex = new Map(assemblyOrder.map((n, i) => [n, i]));
    return [...parts].sort((a, b) => {
      const ia = orderIndex.has(a.name) ? orderIndex.get(a.name) : Infinity;
      const ib = orderIndex.has(b.name) ? orderIndex.get(b.name) : Infinity;
      if (ia !== ib) return ia - ib;
      const distA = (a.partCenter || a.homePos).length();
      const distB = (b.partCenter || b.homePos).length();
      return distB - distA;
    });
  }
  return [...parts].sort((a, b) => {
    const distA = (a.partCenter || a.homePos).length();
    const distB = (b.partCenter || b.homePos).length();
    return distB - distA;
  });
}

/**
 * 计算爆炸方向（纯数学，无 THREE 依赖）
 * 当部件离中心太近时，按均匀角度分布；否则沿径向向外
 * @param {{x: number, y: number, z: number}} partCenter
 * @param {number} index
 * @param {number} totalParts
 * @returns {{x: number, y: number, z: number}} 爆炸位移向量
 */
export function computeExplodeVector(partCenter, index, totalParts) {
  const distFromCenter = Math.sqrt(
    partCenter.x ** 2 + partCenter.y ** 2 + partCenter.z ** 2,
  );
  let dirX, dirY, dirZ;

  if (distFromCenter < 0.001) {
    const angle = (index / totalParts) * Math.PI * 2;
    dirX = Math.cos(angle);
    dirY = Math.sin(angle);
    dirZ = 0;
  } else {
    const inv = 1 / distFromCenter;
    dirX = partCenter.x * inv;
    dirY = partCenter.y * inv;
    dirZ = partCenter.z * inv;
  }

  const initialDist = Math.max(distFromCenter * 3, 1.0);
  return {
    x: dirX * initialDist,
    y: dirY * initialDist,
    z: dirZ * initialDist,
  };
}

// ===== GLB 二进制校验 =====

/**
 * 验证 GLB 二进制数据头部
 * @param {Uint8Array|Buffer} buffer - GLB 二进制数据
 * @returns {{valid: boolean, version?: number, length?: number, error?: string}}
 */
export function validateGLBHeader(buffer) {
  if (!buffer || buffer.length < 12) {
    return { valid: false, error: "数据太短，无法解析 GLB 头部" };
  }

  // GLB magic = 0x46546C67 ('glTF')
  const view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, 12);
  const magic = view.getUint32(0, true);

  if (magic !== 0x46546c67) {
    return { valid: false, error: `无效的 GLB magic: 0x${magic.toString(16)}` };
  }

  const version = view.getUint32(4, true);
  const length = view.getUint32(8, true);

  if (version !== 2) {
    return { valid: false, version, error: `不支持的 GLB 版本: ${version}` };
  }

  if (length !== buffer.length) {
    return { valid: false, version, length, error: `GLB 长度不匹配: 头部声明 ${length}, 实际 ${buffer.length}` };
  }

  return { valid: true, version, length };
}
