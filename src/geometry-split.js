// 几何体拆分工具 — 从 main.js 抽出（L2 模块化试点）。
//
// 本模块为「纯函数」：仅依赖 THREE、src/utils.js 的 UnionFind / generatePartName，
// 不引用 main.js 的共享状态（scene/camera/parts/questGroup 等），因此可独立复用与测试。
// 与 main.js 共用同一个 "three" 裸导入实例（ESM 按解析路径缓存，材质/几何类型一致）。

import { Box3, BufferGeometry, Float32BufferAttribute, Mesh, Uint32BufferAttribute, Vector3 } from "three";
import { UnionFind, generatePartName as _generatePartName } from "./utils.js";

// 从几何体中提取指定面，创建新的非索引几何体
export function extractFacesToGeometry(geometry, faceIndices) {
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const index = geometry.index;
  const hasIndex = !!index;

  const newPositions = [];
  const newNormals = norm ? [] : null;
  const newUVs = uv ? [] : null;

  for (const f of faceIndices) {
    for (let v = 0; v < 3; v++) {
      const srcIdx = hasIndex ? index.getX(f * 3 + v) : f * 3 + v;
      newPositions.push(pos.getX(srcIdx), pos.getY(srcIdx), pos.getZ(srcIdx));
      if (norm) newNormals.push(norm.getX(srcIdx), norm.getY(srcIdx), norm.getZ(srcIdx));
      if (uv) newUVs.push(uv.getX(srcIdx), uv.getY(srcIdx));
    }
  }

  const newGeo = new BufferGeometry();
  newGeo.setAttribute("position", new Float32BufferAttribute(newPositions, 3));
  if (newNormals) newGeo.setAttribute("normal", new Float32BufferAttribute(newNormals, 3));
  if (newUVs) newGeo.setAttribute("uv", new Float32BufferAttribute(newUVs, 2));
  return newGeo;
}

// 按连通分量拆分几何体（将单个 mesh 拆成多个独立部件）
export function splitByConnectedComponents(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const vertexCount = pos.count;
  if (vertexCount === 0) return [];

  const uf = new UnionFind(vertexCount);

  // 连接共享面的顶点
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      uf.union(index.getX(i), index.getX(i + 1));
      uf.union(index.getX(i + 1), index.getX(i + 2));
      uf.union(index.getX(i + 2), index.getX(i));
    }
  } else {
    for (let i = 0; i < vertexCount; i += 3) {
      uf.union(i, i + 1);
      uf.union(i + 1, i + 2);
      uf.union(i + 2, i);
    }
  }

  // 按根节点分组面
  const componentFaces = new Map();
  const faceCount = index ? index.count / 3 : vertexCount / 3;

  for (let f = 0; f < faceCount; f++) {
    const v0 = index ? index.getX(f * 3) : f * 3;
    const root = uf.find(v0);
    if (!componentFaces.has(root)) componentFaces.set(root, []);
    componentFaces.get(root).push(f);
  }

  // 按面数降序排列，过滤太小的分量（< 12 个面）
  const sorted = [...componentFaces.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([, faces]) => faces.length >= 12);

  // 为每个分量创建新几何体
  const results = [];
  for (const [, faces] of sorted) {
    const newGeo = extractFacesToGeometry(geometry, faces);
    if (newGeo) results.push(newGeo);
  }

  // 如果有被过滤掉的小分量，合并成一个大分量
  const smallFaces = [];
  for (const [, faces] of [...componentFaces.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([, faces]) => faces.length < 12)) {
    smallFaces.push(...faces);
  }
  if (smallFaces.length >= 3) {
    const newGeo = extractFacesToGeometry(geometry, smallFaces);
    if (newGeo) results.push(newGeo);
  }

  return results;
}

// 按材质组拆分
export function splitByMaterialGroups(geometry) {
  if (!geometry.groups || geometry.groups.length <= 1) return [];
  const results = [];

  for (const group of geometry.groups) {
    const faceStart = Math.floor(group.start / 3);
    const faceCount = Math.floor(group.count / 3);
    const faces = [];
    for (let f = faceStart; f < faceStart + faceCount; f++) faces.push(f);
    if (faces.length > 0) {
      const newGeo = extractFacesToGeometry(geometry, faces);
      if (newGeo) results.push({ geometry: newGeo, materialIndex: group.materialIndex || 0 });
    }
  }
  return results;
}

// 空间切分（按包围盒最长轴均分）
export function splitSpatially(geometry, material, targetParts) {
  const pos = geometry.attributes.position;
  const box = new Box3().setFromBufferAttribute(pos);
  const size = new Vector3();
  box.getSize(size);

  const maxAxis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  const axisSize = size[maxAxis];
  if (axisSize < 0.001) return [];

  const getter = maxAxis === "x" ? "getX" : maxAxis === "y" ? "getY" : "getZ";
  const index = geometry.index;
  const faceCount = index ? index.count / 3 : pos.count / 3;
  const results = [];

  for (let i = 0; i < targetParts; i++) {
    const minBound = box.min[maxAxis] + (i / targetParts) * axisSize;
    const maxBound = box.min[maxAxis] + ((i + 1) / targetParts) * axisSize;
    const faces = [];

    for (let f = 0; f < faceCount; f++) {
      const v0 = index ? index.getX(f * 3) : f * 3;
      const val = pos[getter](v0);
      if (val >= minBound && (i === targetParts - 1 ? val <= maxBound : val < maxBound)) {
        faces.push(f);
      }
    }

    if (faces.length >= 3) {
      const newGeo = extractFacesToGeometry(geometry, faces);
      if (newGeo) results.push(newGeo);
    }
  }
  return results;
}

// generatePartName 适配层：将 Box3 转换为 utils.js 需要的 {center, size} 格式
export function generatePartName(index, position, bbox) {
  const center = bbox.getCenter(new Vector3());
  const size = bbox.getSize(new Vector3());
  return _generatePartName(index, position, { center, size });
}

// ===== 顶点焊接 =====
// 按位置距离焊接重复顶点，消除「接缝顶点重复」导致的过拆：
// 接缝两侧各带一份同位置顶点时，splitByConnectedComponents 会把同一部件
// 误判成多个连通分量（其中不足 minFaces 的碎片还会被单独切成一个部件）。
// 焊接只合并顶点索引，面数、面顺序、groups 的索引区段都不变，
// 因此不会改动材质组路径的行为。
// attributes 的 normal/uv 取「首次出现」那一份：接缝两侧本来就各带一份法线，
// 取其一即等于原始着色结果，且结果确定不依赖哈希遍历顺序。
// tolerance <= 0 时退化为原样克隆（等同不做焊接）。
export function weldVertices(geometry, tolerance = 1e-4) {
  const pos = geometry && geometry.attributes ? geometry.attributes.position : null;
  if (!pos || pos.count === 0) return new BufferGeometry();
  if (!(tolerance > 0)) return cloneGeometry(geometry);

  const norm = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const srcIndex = geometry.index;

  const keptPos = [];
  const keptNorm = norm ? [] : null;
  const keptUv = uv ? [] : null;
  const remap = new Int32Array(pos.count);
  const buckets = new Map();
  const tolSq = tolerance * tolerance;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const bx = Math.floor(x / tolerance), by = Math.floor(y / tolerance), bz = Math.floor(z / tolerance);

    let merged = -1;
    search: for (let dx = -1; dx <= 1 && merged < 0; dx++) {
      for (let dy = -1; dy <= 1 && merged < 0; dy++) {
        for (let dz = -1; dz <= 1 && merged < 0; dz++) {
          const key = ((bx + dx) * 73856093) ^ ((by + dy) * 19349663) ^ ((bz + dz) * 83492791);
          const bucket = buckets.get(key);
          if (!bucket) continue;
          for (const j of bucket) {
            const ex = x - keptPos[j * 3];
            const ey = y - keptPos[j * 3 + 1];
            const ez = z - keptPos[j * 3 + 2];
            if (ex * ex + ey * ey + ez * ez <= tolSq) {
              merged = j;
              break search;
            }
          }
        }
      }
    }

    if (merged >= 0) {
      remap[i] = merged;
      continue;
    }

    const id = keptPos.length / 3;
    keptPos.push(x, y, z);
    if (norm) keptNorm.push(norm.getX(i), norm.getY(i), norm.getZ(i));
    if (uv) keptUv.push(uv.getX(i), uv.getY(i));
    remap[i] = id;

    const key = (bx * 73856093) ^ (by * 19349663) ^ (bz * 83492791);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(id);
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(keptPos, 3));
  if (norm) out.setAttribute("normal", new Float32BufferAttribute(keptNorm, 3));
  if (uv) out.setAttribute("uv", new Float32BufferAttribute(keptUv, 2));

  if (srcIndex) {
    const next = new Uint32Array(srcIndex.count);
    for (let i = 0; i < srcIndex.count; i++) next[i] = remap[srcIndex.getX(i)];
    out.setIndex(new Uint32BufferAttribute(next, 1));
  } else {
    const next = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) next[i] = remap[i];
    out.setIndex(new Uint32BufferAttribute(next, 1));
  }

  // groups 记的是索引区段，焊接不改面数也不改面顺序，原样搬运
  if (geometry.groups) {
    for (const g of geometry.groups) out.addGroup(g.start, g.count, g.materialIndex);
  }
  return out;
}

// 深拷贝几何体（tolerance <= 0 时 weldVertices 的返回值）
function cloneGeometry(geometry) {
  const out = new BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) {
    out.setAttribute(name, geometry.attributes[name].clone());
  }
  if (geometry.index) out.setIndex(geometry.index.clone());
  if (geometry.groups) {
    for (const g of geometry.groups) out.addGroup(g.start, g.count, g.materialIndex);
  }
  return out;
}

// ===== 窄颈切面拆分 =====
// 单个 mesh 也可能表示「焊死的装配体」：各零件之间只连着一条很细的颈，
// 拓扑上是一个连通分量，按连通分量和材质组都拆不开。
//
// 判据用「沿轴的面密度」：把每个面沿某根轴摊薄成 dA/da（等价于截面周长）。
// 面法向与轴越平行（端盖）权重越低，(1 - |n·a|) 让端盖权重恰好为 0，
// 于是盒壳中段不再因为「只有侧面穿过」被误判成细颈，
// 球体、圆柱、圆锥也都是一条平线或单边斜坡，只有真正的细颈才会在中间凹下去。
// 另外还要满足：颈部整段粗细一致（排掉一路变细的锥体、球顶），
// 且颈两侧都必须是够厚的实体（各自由至少 minBulkBins 个桶撑住），
// 于是球体、圆柱的圆头肩、贴着边缘伸出的细杆都不会被误判成颈。
// 面按质心归属一侧（不复制、不丢失），两半面数之和等于原面数。
// 压根切不开时原样返回 1 件（面数不变），调用方按「≥ 2 件才采用」忽略它即可。
export function splitByCutPlanes(geometry, options = {}) {
  const opts = { minFaces: 12, maxParts: 8, troughRatio: 0.35, maxRunFrac: 0.6, minBulkBins: 2, bins: 0, ...options };
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return [];
  if (geometry.attributes.position.count === 0) return [];

  const results = [];
  const pending = [geometry];
  while (pending.length > 0) {
    const piece = pending.shift();
    const cut = chooseCutPlane(piece, opts);
    if (cut && results.length + pending.length + 1 < opts.maxParts) {
      const [facesA, facesB] = partitionFacesByPlane(piece, cut.axis, cut.value);
      pending.push(extractFacesToGeometry(piece, facesA), extractFacesToGeometry(piece, facesB));
    } else {
      results.push(piece);
    }
  }
  return results;
}

// 在三个轴上挑出「最细的那道颈」，无解返回 null
function chooseCutPlane(geometry, opts) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const faceCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  if (faceCount < opts.minFaces * 2) return null;

  const stats = buildFaceStats(geometry, faceCount);
  const box = new Box3().setFromBufferAttribute(pos);
  const size = box.getSize(new Vector3());
  const bins = opts.bins || Math.min(64, Math.max(16, Math.round(Math.sqrt(faceCount) * 2)));

  let best = null;
  for (let axis = 0; axis < 3; axis++) {
    const axisSize = size.getComponent(axis);
    if (axisSize < 1e-6) continue;
    const lo = box.min.getComponent(axis);
    const binSize = axisSize / bins;

    // 沿轴的面密度剖面；peak <= 0 说明这根轴上全是端盖，没有可切的结构
    const density = buildAxisProfile(stats, faceCount, axis, lo, binSize, bins);
    const peak = peakInRange(density, 0, bins - 1);
    if (peak <= 0) continue;

    const minSorted = Float64Array.from(stats.faceMin[axis]).sort();
    const maxSorted = Float64Array.from(stats.faceMax[axis]).sort();

    for (let b = 1; b < bins - 1; b++) {
      const head = density[b];
      if (head <= 0 || head >= peak * 0.999) continue;
      // 实体至少要比颈部厚这么多，否则颈两侧其实一样薄
      const bulk = head / opts.troughRatio;

      // 从本桶向两侧扩展，圈出连续的薄桶（颈部本体）
      const [t0, t1] = expandTrough(density, b, bulk);

      // 颈必须整段粗细一致：圆锥、球顶这种一路变细的斜坡会被拒绝
      if (!isUniformRun(density, t0, t1)) continue;
      // 颈不能横跨大半根轴，否则更像整根细杆而不是接头
      if ((t1 - t0 + 1) / bins > opts.maxRunFrac) continue;

      const bulkLeft = peakInRange(density, 0, t0 - 1);
      const bulkRight = peakInRange(density, t1 + 1, bins - 1);
      // 颈两侧都必须是够厚的实体：峰值达到 bulk，且至少 minBulkBins 个桶真的站在
      // bulk 之上。单侧薄（穹顶肩部、锥顶/球顶、贴边的细杆）一律不当成颈，
      // 否则球体、圆柱这类「两端圆过去」的凸体会被切成碎片。
      if (bulkLeft < bulk || bulkRight < bulk) continue;
      if (countInRange(density, 0, t0 - 1, bulk) < opts.minBulkBins) continue;
      if (countInRange(density, t1 + 1, bins - 1, bulk) < opts.minBulkBins) continue;
      // 切口落在谷底桶中心：谷底才是材料最薄处，也保证同一个颈无论
      // 从哪个桶起手都得到同一个切面（不会因为扫描顺序切进实体一侧）
      const value = lo + (argminInRange(density, t0, t1) + 0.5) * binSize;

      let left = 0;
      for (let f = 0; f < faceCount; f++) if (stats.centroid[axis][f] < value) left++;
      const right = faceCount - left;
      if (left < opts.minFaces || right < opts.minFaces) continue;

      const candidate = {
        axis,
        value,
        bridges: countStraddling(minSorted, maxSorted, value),
        left,
        right,
      };
      if (!best || isBetterCut(candidate, best)) best = candidate;
    }
  }
  return best;
}

// 打分：先看切过去的面最少（越贴合缝隙越好），再看两侧越均衡越好
function isBetterCut(a, b) {
  if (a.bridges !== b.bridges) return a.bridges < b.bridges;
  return Math.min(a.left, a.right) > Math.min(b.left, b.right);
}

// dA/da 剖面：每个面按「面密度」摊进它沿轴跨过的所有桶。
// 一面长墙横跨多个桶时不会被塞进单个桶（那会造出中段空桶的梳齿伪影），
// 摊薄时按与每个桶的重叠长度精确分配（而不是整桶平摊），否则面的跨度与桶宽
// 一旦不整除，粗细均匀的直杆也会在桶边界上抖出 2 倍锯齿。
// 端盖面密度为 0，天然不计入剖面。
function buildAxisProfile(stats, faceCount, axis, lo, binSize, bins) {
  const density = new Float64Array(bins);
  const mn = stats.faceMin[axis];
  const mx = stats.faceMax[axis];
  const dens = stats.density[axis];
  for (let f = 0; f < faceCount; f++) {
    const d = dens[f];
    if (d <= 0) continue;
    const e0 = (mn[f] - lo) / binSize;
    const e1 = (mx[f] - lo) / binSize;
    let b0 = Math.floor(e0);
    let b1 = Math.floor(e1);
    if (b0 < 0) b0 = 0;
    else if (b0 >= bins) b0 = bins - 1;
    if (b1 < 0) b1 = 0;
    else if (b1 >= bins) b1 = bins - 1;
    for (let b = b0; b <= b1; b++) {
      // 面在轴上的跨度与本桶相交的长度（以桶宽为单位），乘回 binSize 得实际长度
      const from = e0 > b ? e0 : b;
      const to = e1 < b + 1 ? e1 : b + 1;
      if (to > from) density[b] += d * (to - from) * binSize;
    }
  }
  return density;
}

// 从种子桶向两侧扩展，圈出所有密度低于 bulk 的连续桶
function expandTrough(density, seed, bulk) {
  let t0 = seed;
  let t1 = seed;
  while (t0 > 0 && density[t0 - 1] < bulk) t0--;
  while (t1 < density.length - 1 && density[t1 + 1] < bulk) t1++;
  return [t0, t1];
}

// 颈部整段粗细是否一致：至少一半的桶要达到区间峰值的一半。
// 一路变细的斜坡只有头部几桶够粗，会被这条拒绝。
function isUniformRun(density, t0, t1) {
  const peak = peakInRange(density, t0, t1);
  if (peak <= 0) return false;
  let thick = 0;
  for (let i = t0; i <= t1; i++) if (density[i] >= peak * 0.5) thick++;
  return thick * 2 >= t1 - t0 + 1;
}

// 闭区间峰值
function peakInRange(density, from, to) {
  let peak = 0;
  for (let i = from; i <= to; i++) if (density[i] > peak) peak = density[i];
  return peak;
}

// 闭区间内最小值的下标。粗细一致的颈整段并列最小，此时取最靠近段中点的那一桶，
// 切口才落在颈的正中；否则并列取最左会把切口贴到颈的一端，切出 792/824 这种偏心结果。
function argminInRange(density, from, to) {
  const mid = (from + to) / 2;
  let at = from;
  for (let i = from + 1; i <= to; i++) {
    const diff = density[i] - density[at];
    if (diff < -1e-9 || (Math.abs(diff) <= 1e-9 && Math.abs(i - mid) < Math.abs(at - mid))) at = i;
  }
  return at;
}

// 闭区间内达到 threshold 的桶数
function countInRange(density, from, to, threshold) {
  let n = 0;
  for (let i = from; i <= to; i++) if (density[i] >= threshold) n++;
  return n;
}

// 每面质心 + 每面三轴 AABB + 每面三轴面密度（面积 x (1 - |n·a|) / 沿轴跨度）。
// 质心用于按切面归属两侧，AABB 跨度用于摊薄剖面与 bridges 二分，面密度用于
// 判断哪里「材料薄」。法向取三角形两边的叉乘（长度 = 2 倍面积），
// 不依赖 geometry.attributes.normal（可能缺失或与拓扑不一致）。
function buildFaceStats(geometry, faceCount) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const centroid = [new Float64Array(faceCount), new Float64Array(faceCount), new Float64Array(faceCount)];
  const faceMin = [new Float64Array(faceCount), new Float64Array(faceCount), new Float64Array(faceCount)];
  const faceMax = [new Float64Array(faceCount), new Float64Array(faceCount), new Float64Array(faceCount)];
  const density = [new Float64Array(faceCount), new Float64Array(faceCount), new Float64Array(faceCount)];

  const v = new Float64Array(9);
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) {
      const src = index ? index.getX(f * 3 + k) : f * 3 + k;
      v[k * 3] = pos.getX(src);
      v[k * 3 + 1] = pos.getY(src);
      v[k * 3 + 2] = pos.getZ(src);
    }
    const e1x = v[3] - v[0];
    const e1y = v[4] - v[1];
    const e1z = v[5] - v[2];
    const e2x = v[6] - v[0];
    const e2y = v[7] - v[1];
    const e2z = v[8] - v[2];
    // 叉乘：长度 = 2 倍三角形面积，方向 = 面法向
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);

    for (let a = 0; a < 3; a++) {
      let mn = Infinity;
      let mx = -Infinity;
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        const val = v[k * 3 + a];
        if (val < mn) mn = val;
        if (val > mx) mx = val;
        sum += val;
      }
      const na = a === 0 ? nx : a === 1 ? ny : nz;
      faceMin[a][f] = mn;
      faceMax[a][f] = mx;
      centroid[a][f] = sum / 3;
      // (|cross| - |cross·a|) / 2 = 面积 x (1 - |n·a|)，再除以跨度得到面密度
      density[a][f] = area2 < 1e-12 || mx - mn < 1e-12 ? 0 : (area2 - Math.abs(na)) / 2 / (mx - mn);
    }
  }
  return { centroid, faceMin, faceMax, density };
}

// 跨越切面的面数 = (max >= v 的面) - (min >= v 的面)，两次二分即可
function countStraddling(minSorted, maxSorted, value) {
  return countAtLeast(maxSorted, value) - countAtLeast(minSorted, value);
}

function countAtLeast(sorted, value) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
}

// 按面质心把面分成两侧（每面只归一侧，两半面数之和等于原面数）
function partitionFacesByPlane(geometry, axis, value) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const faceCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  const getter = axis === 0 ? "getX" : axis === 1 ? "getY" : "getZ";
  const a = [];
  const b = [];
  for (let f = 0; f < faceCount; f++) {
    const i0 = index ? index.getX(f * 3) : f * 3;
    const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;
    const center = (pos[getter](i0) + pos[getter](i1) + pos[getter](i2)) / 3;
    if (center < value) a.push(f);
    else b.push(f);
  }
  return [a, b];
}

// 自动拆分编排器：收集 mesh，逐级尝试越来越激进的拆分策略（从 main.js 抽取）。
// mesh 数 >= 2 时直接沿用原始 mesh（保持准确）；仅 1 个 mesh 时依次尝试
// 材质组 -> 连通分量（先焊接，消除接缝重复顶点导致的过拆）-> 窄颈切面，
// 都不适用才保留原 mesh。每一级都要求「拆出来的确实是独立零件」，
// 因此球体、实心块这类整体形状会被自然拒绝，不会被硬切成两半。
// 返回值形如 { mesh, name, isOriginal }，未命名的按整体包围盒经 generatePartName 命名。
export function autoSplitModel(model) {
  // 第一步：收集所有 mesh 及其世界变换
  const rawMeshes = [];
  model.traverse(child => {
    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      rawMeshes.push(child);
    }
  });

  // 如果 mesh 数量 >= 2，直接使用原始 mesh（保持准确）
  if (rawMeshes.length >= 2) {
    return rawMeshes.map((mesh, i) => {
      const name = mesh.name || mesh.userData.name || `部件${i + 1}`;
      return { mesh, name, isOriginal: true };
    });
  }

  // 只有一个 mesh 时，尝试按材质组或连通分量拆分（自然拆分，不强制）
  const splitParts = [];
  for (const mesh of rawMeshes) {
    const geometry = mesh.geometry;
    const material = mesh.material;

    // 尝试材质组拆分（如果模型本身有多个材质组，说明设计上就是多部件）
    const groupResults = splitByMaterialGroups(geometry);
    if (groupResults.length >= 2) {
      for (const gr of groupResults) {
        const newMesh = new Mesh(
          gr.geometry,
          Array.isArray(material) ? material[gr.materialIndex] || material[0] : material,
        );
        newMesh.matrix.copy(mesh.matrixWorld);
        newMesh.matrixAutoUpdate = false;
        splitParts.push({ mesh: newMesh, name: "", isOriginal: false });
      }
      continue;
    }

    // 尝试连通分量拆分（检测物理上分离的部件）
    // 先按位置距离焊接：接缝两侧的重复顶点会让同一部件被误判成多个分量
    // （不足 minFaces 的碎片还会被单独切成一个部件）。焊接后仍拆不动时
    // 回退到原始拓扑，结果与焊接前一致。
    let ccResults = splitByConnectedComponents(weldVertices(geometry));
    if (ccResults.length < 2) {
      ccResults = splitByConnectedComponents(geometry);
    }
    if (ccResults.length >= 2) {
      for (const ccGeo of ccResults) {
        const newMesh = new Mesh(ccGeo, material);
        newMesh.matrix.copy(mesh.matrixWorld);
        newMesh.matrixAutoUpdate = false;
        splitParts.push({ mesh: newMesh, name: "", isOriginal: false });
      }
      continue;
    }

    // 兜底：仍是一个焊死的整体时，找「材料最窄的那道颈」切开。
    // 仅在上述拆分都不适用时触发；仍是整体形状就原样返回 1 件，这里按「≥ 2 件」忽略它。
    const cutResults = splitByCutPlanes(geometry);
    if (cutResults.length >= 2) {
      for (const cutGeo of cutResults) {
        const newMesh = new Mesh(cutGeo, material);
        newMesh.matrix.copy(mesh.matrixWorld);
        newMesh.matrixAutoUpdate = false;
        splitParts.push({ mesh: newMesh, name: "", isOriginal: false });
      }
      continue;
    }

    // 无法自然拆分，保留原始 mesh（不强制空间切分，保持准确）
    splitParts.push({ mesh, name: mesh.name || "", isOriginal: true });
  }

  // 计算整体包围盒用于命名
  const bbox = new Box3();
  for (const part of splitParts) {
    const partBox = new Box3().setFromObject(part.mesh);
    bbox.union(partBox);
  }

  // 为拆分后的部件命名
  return splitParts.map((part, i) => {
    if (!part.name) {
      const pos = new Vector3();
      part.mesh.getWorldPosition(pos);
      part.name = generatePartName(i, pos, bbox);
    }
    return part;
  });
}
