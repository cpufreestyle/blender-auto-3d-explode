// 3D 打印可打印性预检（纯函数模块）
//
// 背景：GLB 导出给的是「看得见的几何」，但 3D 打印切片软件（Bambu Studio /
// PrusaSlicer / Cura）对输入的要求比可视化严格得多——它要的是**水密实体**：
// 每个三角形边必须被恰好两个三角形共享，切片时才能沿 Z 轴求出闭合轮廓。
// 本项目产出的模型有三类常见不打印源：
//
//   1. 拆解产生的碎面：autoSplitModel 按连通分量/材质/平面切分，切口处会留下
//      开放边（一个零件从中间切开，剖面就是开放的）；
//   2. 退化三角形：零面积面（重复顶点 / 三点共线）会让切片器的三角化抖动，
//      部分实现直接报错；
//   3. 尺度不明：STL 没有单位字段，Blender 默认 1 单位 = 1 米，而打印要的是
//      毫米——2 米的 Quest 3 头显送进切片软件会被当成巨型件。
//
// 设计取舍：
//   · 只做静态几何分析，不尝试修复；导出层（print-export.js）在此基础上对平面切口做自动封盖——复用本模块导出的焊接与边统计（WELD_TOLERANCE / countEdges / weldPositions），保证「预检看到的开放边」和「封盖修的开放边」是同一套拓扑。其余问题（非流形边等）仍是 Blender 3D-Print Toolbox 的职责
//   · 边邻接统计用排序顶点对做键，避免哈希浮点坐标；
//   · 焊接容差与 geometry-split.js 的 weldVertices 默认值一致（1e-4），
//     但**不**复用那个函数——它同时搬运 normal/uv/groups，而这里只需要顶点
//     合并，依赖它会让「改焊接行为影响拆解」这种跨模块耦合出现。

import { Box3, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3 } from "three";

// 切片软件的主流构建体积（毫米）。只作提示用：超出不等于不能打，
// 模型可以缩放或分件，所以这条是 warning 而非 error。
export const BUILD_VOLUMES = {
  bambu_x1c: { label: "Bambu Lab X1C / P1", size: [256, 256, 256] },
  bambu_a1: { label: "Bambu Lab A1 / A1 mini", size: [256, 256, 256] },
  prusa_mk4: { label: "Prusa MK4 / CORE One", size: [250, 210, 220] },
  ender3: { label: "Creality Ender-3 / K1", size: [220, 220, 250] },
};

// 默认按 Bambu X1C 比对——项目在 Windows 上的目标机是 A1 mini（256³）
export const DEFAULT_BUILD_VOLUME = "bambu_x1c";

// 顶点焊接容差。与 geometry-split.js 的 weldVertices 默认值对齐：
// 接缝处重复顶点的间距通常远大于此，而真实几何细节通常远小于此。
export const WELD_TOLERANCE = 1e-4;

// 退化三角形判定阈值（面积平方）。三个共线/重复点构成的三角形面积为 0，
// 但浮点累加会给出极小非零值，所以用平方量纲避免开方。
export const DEGENERATE_AREA_SQ = 1e-12;

/**
 * 边邻接统计。
 *
 * 水密（manifold & watertight）的判定：每条无向边恰好被两个三角形引用。
 * 用排序后的顶点对做键，使 (a,b) 与 (b,a) 归为同一条边。
 *
 * 注意：统计前必须先焊接顶点，否则同一个几何位置因为拆解时的顶点复制
 * 会被当成不同顶点，接缝处的边全部记为「只有 1 个三角形」——开放边的
 * 数量会远大于真实值。
 *
 * @param {BufferGeometry} geometry 已焊接的几何体
 * @returns {{edgeCount:number, openEdges:number, nonManifoldEdges:number,
 *            boundaryVertices:Set<number>, edgeUse:Map<string,number>}}
 */
export function countEdges(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const edgeUse = new Map();

  for (let i = 0; i + 2 < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const tri = [a, b, c];
    for (let e = 0; e < 3; e++) {
      const p = tri[e];
      const q = tri[(e + 1) % 3];
      // 排序键：小索引在前，保证无向边唯一
      const key = p < q ? p + "_" + q : q + "_" + p;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  const boundaryVertices = new Set();
  for (const [key, n] of edgeUse) {
    if (n === 1) {
      openEdges++;
      // 开放边的两个端点都是边界顶点——切片器在这里无法闭合轮廓
      const [p, q] = key.split("_");
      boundaryVertices.add(Number(p));
      boundaryVertices.add(Number(q));
    } else if (n > 2) {
      nonManifoldEdges++;
    }
  }

  return {
    edgeCount: edgeUse.size,
    openEdges,
    nonManifoldEdges,
    boundaryVertices,
    edgeUse,
  };
}

/**
 * 顶点焊接（仅合并位置，不搬运 normal/uv/groups）。
 *
 * 与 geometry-split.js 的 weldVertices 同算法思路，但输出只保留 position 与
 * index：可打印性分析只关心拓扑，法线和 UV 是渲染关注点。
 *
 * @param {BufferGeometry} geometry
 * @param {number} tolerance
 * @returns {BufferGeometry}
 */
export function weldPositions(geometry, tolerance = WELD_TOLERANCE) {
  const pos = geometry && geometry.attributes ? geometry.attributes.position : null;
  if (!pos || pos.count === 0) return new BufferGeometry();
  if (!(tolerance > 0)) return geometry.clone();

  const srcIndex = geometry.index;
  const kept = [];
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
          const key = (bx + dx) * 73856093 ^ (by + dy) * 19349663 ^ (bz + dz) * 83492791;
          const bucket = buckets.get(key);
          if (!bucket) continue;
          for (const j of bucket) {
            const dxp = x - kept[j * 3];
            const dyp = y - kept[j * 3 + 1];
            const dzp = z - kept[j * 3 + 2];
            if (dxp * dxp + dyp * dyp + dzp * dzp <= tolSq) {
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

    const id = kept.length / 3;
    kept.push(x, y, z);
    remap[i] = id;
    const key = bx * 73856093 ^ by * 19349663 ^ bz * 83492791;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(id);
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(kept, 3));
  if (srcIndex) {
    const next = new Uint32Array(srcIndex.count);
    for (let i = 0; i < srcIndex.count; i++) next[i] = remap[srcIndex.getX(i)];
    out.setIndex(new Uint32BufferAttribute(next, 1));
  } else {
    const next = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) next[i] = remap[i];
    out.setIndex(new Uint32BufferAttribute(next, 1));
  }
  return out;
}

// 三角形面积（叉积模长的一半）。与 split-manifest.js 的 surfaceArea 同一公式，
// 但这里逐面判定而不是累加——需要单独数退化面。
function triangleArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * 单个部件的可打印性分析。
 *
 * @param {Object} part 形如 { mesh: THREE.Mesh, name?: string, index?: number }
 * @param {Object} [options]
 * @param {string} [options.buildVolume] BUILD_VOLUMES 的键
 * @param {number} [options.scaleToMm] 场景单位 -> 毫米的换算（默认 1000，
 *        即 Blender/GLTF 默认的 1 单位 = 1 米）
 * @returns {Object} 分析结果（见 analyzePrintability 的返回结构）
 */
export function analyzePart(part, options = {}) {
  const buildKey = options.buildVolume || DEFAULT_BUILD_VOLUME;
  const build = BUILD_VOLUMES[buildKey] || BUILD_VOLUMES[DEFAULT_BUILD_VOLUME];
  const scale = options.scaleToMm === undefined ? 1000 : options.scaleToMm;

  const empty = {
    name: part && part.name ? part.name : "未命名部件",
    index: part && typeof part.index === "number" ? part.index : null,
    triangles: 0,
    watertight: false,
    openEdges: 0,
    nonManifoldEdges: 0,
    degenerateTriangles: 0,
    boundaryVertices: 0,
    sizeMm: [0, 0, 0],
    volumeMm3: 0,
    surfaceAreaMm2: 0,
    fitsBuildVolume: true,
    issues: ["几何体为空或缺少 position 属性"],
  };

  const geometry = part && part.mesh && part.mesh.geometry ? part.mesh.geometry : null;
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return empty;

  const pos = geometry.attributes.position;
  const index = geometry.index;
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  if (triCount === 0) {
    return { ...empty, issues: ["没有三角形"] };
  }

  // 1. 焊接后做边邻接统计
  const welded = weldPositions(geometry);
  const edges = countEdges(welded);

  // 2. 退化面统计（在原始几何上做，焊接会合并重复顶点从而「修掉」退化面，
  //    但那是拓扑修复不是用户决策——必须如实报告原网格有多少退化面）
  let degenerate = 0;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const count = index ? index.count : pos.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const area = triangleArea(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    if (area * area < DEGENERATE_AREA_SQ) degenerate++;
  }

  // 3. 尺寸与体积（含单位换算）
  const box = new Box3().setFromBufferAttribute(pos);
  const sizeScene = box.getSize(new Vector3());
  const sizeMm = [sizeScene.x * scale, sizeScene.y * scale, sizeScene.z * scale];

  // 体积：散度定理（有向体积之和）。对非水密网格结果无物理意义，
  // 但仍作为「用料估算」输出，页面标注清楚。
  let volume = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    volume += (a.x * (b.y * c.z - b.z * c.y)
      - a.y * (b.x * c.z - b.z * c.x)
      + a.z * (b.x * c.y - b.y * c.x)) / 6;
  }
  volume = Math.abs(volume) * scale * scale * scale;

  // 表面积
  let surface = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    surface += triangleArea(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  surface *= scale * scale;

  const watertight = edges.openEdges === 0 && edges.nonManifoldEdges === 0;
  const fits = sizeMm.every((d, i) => d <= build.size[i]);

  const issues = [];
  if (!watertight) {
    // 两条独立 push，不用 if/else：一个「T 型相接」的夹具会同时踩中两类问题，
    // 折叠成一条文案会让用户只看到其中一个，修完一个另一个才冒出来。
    if (edges.openEdges > 0) {
      issues.push(`有 ${edges.openEdges} 条开放边（未封闭），切片无法闭合轮廓`);
    }
    if (edges.nonManifoldEdges > 0) {
      issues.push(`有 ${edges.nonManifoldEdges} 条非流形边（被 3+ 个面共享）`);
    }
  }
  if (degenerate > 0) {
    issues.push(`有 ${degenerate} 个退化三角形（零面积面）`);
  }
  if (!fits) {
    const over = sizeMm
      .map((d, i) => (d > build.size[i] ? `${["X", "Y", "Z"][i]} ${Math.round(d)}>${build.size[i]}` : null))
      .filter(Boolean)
      .join("、");
    issues.push(`超出 ${build.label} 构建体积（${over} mm），需缩放或分件`);
  }

  return {
    name: part && part.name ? part.name : "未命名部件",
    index: part && typeof part.index === "number" ? part.index : null,
    triangles: triCount,
    watertight,
    openEdges: edges.openEdges,
    nonManifoldEdges: edges.nonManifoldEdges,
    degenerateTriangles: degenerate,
    boundaryVertices: edges.boundaryVertices.size,
    sizeMm: sizeMm.map(d => Math.round(d * 100) / 100),
    volumeMm3: Math.round(volume * 100) / 100,
    surfaceAreaMm2: Math.round(surface * 100) / 100,
    fitsBuildVolume: fits,
    issues,
  };
}

/**
 * 整模型的可打印性分析。
 *
 * @param {Array<Object>} parts 形如 [{ mesh, name, index }]
 * @param {Object} [options] 同 analyzePart
 * @returns {Object} { parts, summary, buildVolume }
 */
export function analyzePrintability(parts, options = {}) {
  const buildKey = options.buildVolume || DEFAULT_BUILD_VOLUME;
  const build = BUILD_VOLUMES[buildKey] || BUILD_VOLUMES[DEFAULT_BUILD_VOLUME];

  if (!Array.isArray(parts) || parts.length === 0) {
    return {
      parts: [],
      summary: {
        total: 0, watertight: 0, problematic: 0,
        totalTriangles: 0, totalVolumeMm3: 0, ready: false,
      },
      buildVolume: buildKey,
      buildLabel: build.label,
      issues: ["没有可分析的部件"],
    };
  }

  const analyzed = parts.map(p => analyzePart(p, options));
  const watertight = analyzed.filter(p => p.watertight && p.issues.length === 0);
  const problematic = analyzed.filter(p => !p.watertight || p.issues.length > 0);

  return {
    parts: analyzed,
    summary: {
      total: analyzed.length,
      watertight: watertight.length,
      problematic: problematic.length,
      totalTriangles: analyzed.reduce((s, p) => s + p.triangles, 0),
      totalVolumeMm3: Math.round(analyzed.reduce((s, p) => s + p.volumeMm3, 0) * 100) / 100,
      ready: problematic.length === 0,
    },
    buildVolume: buildKey,
    buildLabel: build.label,
    issues: [],
  };
}
