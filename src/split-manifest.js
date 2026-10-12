// 部件级可交换清单（split manifest）
//
// 背景：autoSplitModel 的产出是「three 对象数组」，只在内存里活着——刷新页面、
// 换设备、想把同一套拆解结果交给别的工具（数据驱动 UI / 离线重放 / CI 断言）
// 都得重新跑一遍拆分。本模块把拆分结果降为纯数据：
//
//   {
//     version: 1, model: "...", totalParts: 4,
//     bounds: { min:[..], max:[..] },
//     parts: [ { index, name, isOriginal, triangles,
//               bounds:{min,max}, centroid:[x,y,z],
//               explodePos:[x,y,z], volume, surfaceArea } ]
//   }
//
// 设计取舍：
//   · 只存几何摘要，不存顶点。manifest 是索引与元数据，不是模型副本；
//   · 所有数值保留完整精度，由消费方决定显示位数——截断在这里做的话，
//     离线重放会与原模型产生可见偏差；
//   · explodePos 直接复用 calculateExplodePos，保证 manifest 里的爆炸方向
//     与屏幕上看到的是同一个算法，不会出现「重放后部件飞向别处」；
//   · 输入非法（非数组、mesh 无 position）逐项跳过并在 summary.skipped 记账，
//     不抛错——manifest 是诊断信息，为它中断主流程不值得。

import { Box3, Vector3 } from "three";
import { calculateExplodePos } from "./explode-geometry.js";

export const MANIFEST_VERSION = 1;

function vecToArray(v) {
  return [v.x, v.y, v.z];
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// 单个 mesh 的三角形数：索引几何按 index.count/3，非索引按 position.count/3
function triangleCount(mesh) {
  const geo = mesh.geometry;
  if (!geo || !geo.attributes || !geo.attributes.position) return 0;
  if (geo.index) return Math.floor(geo.index.count / 3);
  return Math.floor(geo.attributes.position.count / 3);
}

// 表面积：累加每个不退化三角形的面积。退化（零面积）面天然贡献 0，
// 不需要单独判断，但要防 NaN 传播——一个坏顶点会让总和变 NaN，
// 此时回退 0，让调用方至少拿到一个可用的数字。
function surfaceArea(geo) {
  const pos = geo.attributes.position;
  if (!pos) return 0;
  const index = geo.index;
  const count = index ? index.count : pos.count;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  let total = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    total += ab.cross(ac).length() / 2;
  }
  return Number.isFinite(total) ? total : 0;
}

// 体积：按「有向四面体和」算，对封闭网格给出真实体积，对开放网格给出
// 一个确定值（取决于缝的位置，不随运行变化）。manifest 需要的是稳定可比，
// 不是物理精确——所以这里用散度定理的直接实现，不做封闭性修补。
function meshVolume(geo) {
  const pos = geo.attributes.position;
  if (!pos) return 0;
  const index = geo.index;
  const count = index ? index.count : pos.count;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let total = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    total += a.dot(b.cross(c)) / 6;
  }
  return Number.isFinite(total) ? Math.abs(total) : 0;
}

function boundsOf(mesh) {
  const box = new Box3().setFromObject(mesh);
  if (!box || box.isEmpty()) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min: vecToArray(box.min), max: vecToArray(box.max) };
}

/**
 * 把 autoSplitModel 的产出转成可序列化 manifest。
 *
 * @param {Array<{mesh, name, isOriginal}>} parts autoSplitModel 的返回值
 * @param {object} [options]
 * @param {string} [options.model] 模型名，写进 manifest 便于人工辨认
 * @param {object} [options.camera] 传入后按 calculateExplodePos 同参计算爆炸位置
 * @returns {object} manifest；inputs 非法时返回 { version, totalParts: 0, parts: [] }
 */
export function buildSplitManifest(parts, options = {}) {
  const { model = "", camera = null } = options;
  const empty = () => ({
    version: MANIFEST_VERSION,
    model,
    totalParts: 0,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    parts: [],
    summary: { skipped: 0, reasons: [] },
  });

  if (!Array.isArray(parts) || parts.length === 0) return empty();

  const out = [];
  const reasons = [];
  let skipped = 0;

  // 整体包围盒：与 autoSplitModel 命名用的是同一个汇总范围，
  // 这样 manifest 的 bounds 与部件命名所依据的坐标系一致。
  const modelBox = new Box3();
  for (const part of parts) {
    if (part && part.mesh && part.mesh.geometry && part.mesh.geometry.attributes.position) {
      const b = new Box3().setFromObject(part.mesh);
      if (!b.isEmpty()) modelBox.union(b);
    }
  }

  const center = new Vector3();
  modelBox.getCenter(center);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || !part.mesh || !part.mesh.geometry || !part.mesh.geometry.attributes.position) {
      skipped++;
      reasons.push(`index ${i}: 缺 mesh 或 position 属性`);
      continue;
    }
    const geo = part.mesh.geometry;
    const box = new Box3().setFromObject(part.mesh);
    if (box.isEmpty()) {
      skipped++;
      reasons.push(`index ${i}: 包围盒为空`);
      continue;
    }
    const centroid = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());

    // 爆炸位置：与屏幕上一致。calculateExplodePos 需要相机；没有相机时退化为
    // 「沿质心方向外扩一格」。
    //
    // 方向取「质心相对整体中心」而不是相对模型原点：整体中心已经扣除模型的
    // 整体偏移，剩下的正是这个部件在装配体里的偏心方向——单部件在 x=4 时
    // 得到 (1,0,0)，不会被自己的位置抵消成零向量。
    // 单部件（或部件恰好压在整体中心上）时该向量为零，此时整体包围盒仍是
    // 有效信息：沿整体尺寸最大的那一轴外扩，至少保证 manifest 里的位置与
    // 「看得见的分离方向」同向，且是个确定值。
    let explodePos;
    if (camera) {
      explodePos = calculateExplodePos(centroid, i, parts.length, camera);
    } else {
      const dir = centroid.clone().sub(center);
      if (dir.lengthSq() < 1e-12) {
        const ms = modelBox.getSize(new Vector3());
        const axis = ms.x >= ms.y && ms.x >= ms.z ? "x" : ms.y >= ms.z ? "y" : "z";
        dir.set(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
      }
      dir.normalize();
      explodePos = centroid.clone().add(dir.multiplyScalar(Math.max(size.x, size.y, size.z)));
    }

    out.push({
      index: out.length,
      name: part.name || `部件${i + 1}`,
      isOriginal: Boolean(part.isOriginal),
      triangles: triangleCount(part.mesh),
      volume: round6(meshVolume(geo)),
      surfaceArea: round6(surfaceArea(geo)),
      bounds: { min: vecToArray(box.min), max: vecToArray(box.max) },
      size: vecToArray(size),
      centroid: vecToArray(centroid),
      explodePos: vecToArray(explodePos),
    });
  }

  return {
    version: MANIFEST_VERSION,
    model,
    totalParts: out.length,
    bounds: {
      min: modelBox.isEmpty() ? [0, 0, 0] : vecToArray(modelBox.min),
      max: modelBox.isEmpty() ? [0, 0, 0] : vecToArray(modelBox.max),
    },
    parts: out,
    summary: { skipped, reasons },
  };
}

/**
 * manifest → 紧凑 JSON 文本。用于下载 / 复制 / 落盘。
 * 单独抽一层是为了将来换格式（比如 msgpack）只改这里。
 */
export function serializeSplitManifest(manifest, indent = 2) {
  return JSON.stringify(manifest, null, indent);
}

/**
 * 从 JSON 文本还原 manifest。解析失败或结构不符时返回 null，
 * 由调用方决定提示——重放路径上「给个明确失败」比「拿到半个对象」好。
 */
export function parseSplitManifest(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.parts)) return null;
  if (typeof obj.totalParts !== "number") return null;
  return obj;
}
