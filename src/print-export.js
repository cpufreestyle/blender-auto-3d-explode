// 逐部件 STL 导出（3D 打印用）
//
// 背景：可打印性预检（print-analyze.js）只回答问题「能不能打」，这一层负责
// 把答案变成切片软件能吃的文件。STL 是事实标准：二进制格式、每个三角面 50
// 字节、80 字节头，Bambu Studio / PrusaSlicer / Cura 全部支持。
//
// 设计取舍：
//   · 用 three 官方 STLExporter 而不是自己拼二进制——它处理法线重算、
//     matrixWorld 应用、颜色剔除，自己写迟早漏一项；
//   · 打印朝向：three/GLTF 是 Y-up，构建板是 Z-up。每个部件旋转 -90° 绕 X
//     把 +Y 映射到 +Z，再平移到 XY 居中、min.z = 0 贴底——这是切片软件
//     期望的「躺在板上」的姿态；
//   · 只改 clone，绝不动现场 mesh：现场 mesh 带 homePos/explodePos，
//     爆炸动画还在跑，改了会让视图跳位。

import { Box3, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Mesh, ShapeUtils, Uint32BufferAttribute, Vector2, Vector3 } from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION } from "../vendor/three-bvh-csg/index.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { DEGENERATE_AREA_SQ, WELD_TOLERANCE, countEdges, weldPositions } from "./print-analyze.js";

// 场景单位 -> 毫米。与 print-analyze.js 的默认值保持一致：Blender/GLTF
// 默认 1 单位 = 1 米，而打印要毫米。STLExporter 按场景单位输出，所以
// 缩放必须在这里做，切片软件不会替我们猜。
export const DEFAULT_SCALE_TO_MM = 1000;

// ── 拼装定位销 ──────────────────────────────────────────────
// 尺寸按毫米注释（最终几何会被 scaleToMm 放大，所以这些是「场景单位」值，
// 与 scale=1000 时 1 单位 = 1 mm 对齐）：
export const JOIN_DEFAULTS = {
  pinDiameter: 6,       // 销直径 mm（含打印公差裕量；6mm 销对教学玩具足够结实）
  pinLength: 6,         // 销插入深度 mm
  clearance: 0.4,       // 孔径放大裕量 mm（FDM 打印孔总是收缩，0.4 让 6mm 销能徒手压入）
  minFaceSize: 10,      // 接触面至少这么宽才放销（mm）
  maxPinsPerPair: 2,    // 一对部件最多几根销（两个就能定死相对位置，多了装不进去）
};

// CSG 布尔结果会留下 ≤2e-8 的共面浮点残差（实测 BoxGeometry−Cylinder 在
// 1e-7 容差下有 8 条假开放边、1e-6 下完全水密），焊接用 1e-6。
const CSG_WELD_EPSILON = 1e-6;

// 两个部件的世界包围盒是否接触（间隙 < 2% 最大边长）。
function bboxTouch(a, b) {
  if (!a || !b) return false;
  const da = a.max.x - a.min.x, db = b.max.x - b.min.x;
  const gap = Math.max(da, db, a.max.y - a.min.y, b.max.y - a.min.y, a.max.z - a.min.z, b.max.z - b.min.z) * 0.02;
  return (
    a.min.x - gap <= b.max.x && b.min.x - gap <= a.max.x &&
    a.min.y - gap <= b.max.y && b.min.y - gap <= a.max.y &&
    a.min.z - gap <= b.max.z && b.min.z - gap <= a.max.z
  );
}

// 每轴的重叠区间；接触判断失败返回 null
function overlapAxis(a, b) {
  const overlap = (lo1, hi1, lo2, hi2) => ({ start: Math.max(lo1, lo2), end: Math.min(hi1, hi2) });
  const x = overlap(a.min.x, a.max.x, b.min.x, b.max.x);
  const y = overlap(a.min.y, a.max.y, b.min.y, b.max.y);
  const z = overlap(a.min.z, a.max.z, b.min.z, b.max.z);
  return { x, y, z };
}

/**
 * 找出所有装配位相邻的部件对，并给出销的放置位置与轴向。
 *
 * 算法：世界包围盒接触 → 求三轴重叠区间 → 哪一轴的重叠近似为 0（即两个
 * 部件「贴在一起」的界面）→ 销沿该轴穿过界面。位置在界面矩形内避开边缘，
 * 一对部件最多 maxPinsPerPair 根（1 根只能转着装，2 根才定方向）。
 *
 * @param {Array<{mesh: THREE.Mesh, name?: string}>} parts
 * @param {Object} [opts] JOIN_DEFAULTS 覆盖
 * @returns {Array<{a: number, b: number, axis: "x"|"y"|"z", axisSign: 1|-1, points: Vector3[]}>}
 *   points 是场景单位下的界面中点候选；axisSign=1 表示销从 a 指向 b。
 */
export function findJoinPairs(parts, opts = {}) {
  const o = { ...JOIN_DEFAULTS, ...opts };
  const boxes = (parts || []).map(p =>
    p && p.mesh ? new Box3().setFromObject(p.mesh) : null,
  );
  const pairs = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (!boxes[i] || !boxes[j] || boxes[i].isEmpty() || boxes[j].isEmpty()) continue;
      if (!bboxTouch(boxes[i], boxes[j])) continue;
      const ov = overlapAxis(boxes[i], boxes[j]);
      // 界面轴：重叠厚度接近 0（< 触碰容差）。可能同时有多轴贴合（角对角），
      // 取重叠面积最大的一轴，避免在细长接触面上打出一排销。
      const gapTol = 1e-3;
      const spans = { x: ov.x.end - ov.x.start, y: ov.y.end - ov.y.start, z: ov.z.end - ov.z.start };
      const axes = ["x", "y", "z"].filter(k => spans[k] < gapTol);
      if (!axes.length) continue;
      const area = k => {
        const rest = ["x", "y", "z"].filter(r => r !== k);
        return (ov[rest[0]].end - ov[rest[0]].start) * (ov[rest[1]].end - ov[rest[1]].start);
      };
      axes.sort((p, q) => area(q) - area(p));
      const axis = axes[0];
      const rest = ["x", "y", "z"].filter(r => r !== axis);
      const w = ov[rest[0]].end - ov[rest[0]].start;
      const h = ov[rest[1]].end - ov[rest[1]].start;
      // 界面太小放不下销：跳过（预检会说这个部件不宜打印，但装配不硬塞）
      const minFace = o.minFaceSize / 1000; // mm -> 场景单位（与 scale=1000 对齐）
      if (w < minFace * 2 || h < minFace * 2) continue;

      // 锘在界面内的安全圆：半径 = minFace/2，中心在剩余两轴的重叠区中心
      const cx = ov[rest[0]].start + w / 2;
      const cy = ov[rest[1]].start + h / 2;
      const axisSign = boxes[i].getCenter(new Vector3())[axis] <= boxes[j].getCenter(new Vector3())[axis] ? 1 : -1;
      const mid = { x: 0, y: 0, z: 0 };
      mid[rest[0]] = cx;
      mid[rest[1]] = cy;
      // 一对一根（放在界面中心）；两根（沿长轴对称排布，间距 = minFaceSize）
      const points = [];
      if (o.maxPinsPerPair >= 2 && Math.max(w, h) >= minFace * 4) {
        const long = rest[0];
        const off = minFace;
        const p1 = { ...mid }, p2 = { ...mid };
        p1[long] -= off;
        p2[long] += off;
        points.push(p1, p2);
      } else {
        points.push(mid);
      }
      pairs.push({
        a: i,
        b: j,
        axis,
        axisSign,
        points: points.map(pt => new Vector3(pt.x, pt.y, pt.z)),
        faceMm: [Math.round(w * 1000), Math.round(h * 1000)],
      });
    }
  }
  return pairs;
}

// 焊接 CSG 输出：共享圆环顶点在 box 组 / wall 组各有一份（数值完全一致），
// 不焊接会让 print-analyze 报假开放边。
function weldCSG(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const verts = [];
  const remap = new Uint32Array(pos.count);
  const inv = 1 / CSG_WELD_EPSILON;
  const buckets = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = Math.round(x * inv) + "," + Math.round(y * inv) + "," + Math.round(z * inv);
    let id = buckets.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(x, y, z);
      buckets.set(key, id);
    }
    remap[i] = id;
  }
  const out = geometry.clone();
  const idx = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) idx[i] = remap[index.getX(i)];
  out.setIndex(new Uint32BufferAttribute(idx, 1));
  out.setAttribute("position", new Float32BufferAttribute(verts, 3));
  return out;
}

// 销孔的负体积：圆柱沿 axis 穿过 part，中心在 pt（界面点），轴向延伸长度
// = pinLength * 2（深入 part 一半，穿出界面一半；负体积只在 part 内部起作用）。
function pinCutter(pt, axis, length, radius) {
  const geo = new CylinderGeometry(radius, radius, length, 24);
  if (axis === "x") geo.rotateZ(Math.PI / 2);
  else if (axis === "z") geo.rotateX(Math.PI / 2);
  const mesh = new Mesh(geo);
  mesh.position.copy(pt);
  return mesh;
}

/**
 * 给单个部件做「销」或「孔」的 CSG 修改（就地返回新几何，不动原几何）。
 *
 * @param {THREE.Mesh} mesh 现场部件
 * @param {Array<{pt: Vector3, axis: string}>} cuts 本次要挖的孔（世界坐标、轴）
 * @param {Array<{pt: Vector3, axis: string}>} pins 本次要加的销
 * @param {Object} opts JOIN_DEFAULTS 覆盖
 * @returns {THREE.BufferGeometry|null} null 表示无需修改
 */
export function applyJoinFeatures(mesh, cuts, pins, opts = {}) {
  const o = { ...JOIN_DEFAULTS, ...opts };
  if ((!cuts || !cuts.length) && (!pins || !pins.length)) return null;
  // 场景单位换算：JOIN_DEFAULTS 按毫米定义，几何坐标按场景单位（默认 1 单位
  // = 1 米，与 scaleToMm=1000 对齐；测试可传 scaleToMm=1 让 1 单位 = 1 mm）。
  const scale = o.scaleToMm === undefined ? 1000 : o.scaleToMm;
  const r = (o.pinDiameter / 2) / scale;
  const len = (o.pinLength * 2) / scale;
  const clearance = o.clearance / scale;

  const ev = new Evaluator();
  ev.attributes = ["position"];
  ev.useCDTClipping = true;

  // Brush 的 matrix 传递不可靠（updateMatrixWorld 会用本地变换重写），
  // 统一改为把世界变换烘进几何体，Brush 保持单位阵。返回几何是世界坐标系。
  const baseGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  let brush = new Brush(baseGeo);
  brush.updateMatrixWorld();
  brush.markUpdated();

  for (const c of cuts || []) {
    const cutter = pinCutter(c.pt, c.axis, len, r + clearance);
    cutter.updateMatrixWorld(true);
    const cb = new Brush(cutter.geometry.clone().applyMatrix4(cutter.matrixWorld));
    cb.updateMatrixWorld();
    cb.markUpdated();
    const result = ev.evaluate(brush, cb, SUBTRACTION);
    brush = new Brush(weldCSG(result.geometry));
    brush.updateMatrixWorld();
    brush.markUpdated();
  }

  for (const pn of pins || []) {
    // 销本体 = 正体积圆柱，ADDITION 并入壳体；嵌进 B 的那一半被壳体吸收，
    // 凸出的另一半 = pinLength，正好插满 A 侧的孔（孔深也是 pinLength）。
    const pinGeo = new CylinderGeometry(r, r, len, 24);
    if (pn.axis === "x") pinGeo.rotateZ(Math.PI / 2);
    else if (pn.axis === "z") pinGeo.rotateX(Math.PI / 2);
    const pin = new Mesh(pinGeo);
    // 销中心在界面上，沿 axisSign 向外偏移，让销体一半在 A 内一半伸向 B
    pin.position.copy(pn.pt);
    pin.updateMatrixWorld(true);
    const pb = new Brush(pinGeo.applyMatrix4(pin.matrixWorld));
    pb.updateMatrixWorld();
    pb.markUpdated();
    const result = ev.evaluate(brush, pb, ADDITION);
    brush = new Brush(weldCSG(result.geometry));
    brush.updateMatrixWorld();
    brush.markUpdated();
  }

  return brush.geometry;
}

// ── 切口封盖（可打印性自动修复）─────────────────────────────
// 预检（print-analyze.js）只报告不修复；但拆解切口这一类开放边可以零风险自动修掉：
// 切口剖面是平面，沿边界环补一圈封面三角形就是水密实体，不需要重网格化。非平面环、
// 非流形边、三角化/朝向自检失败一律退回原几何——宁可让用户手动修，也不悄悄导出坏几何。

// 平面度容差：环上顶点到「质心 + Newell 法线」平面的最大距离（场景单位）。拆解切口
// 实测残差在 1e-9 量级，1e-3（≈1mm @ scale 1000）只拦截真正扭曲的环。
const CAP_PLANAR_TOLERANCE = 1e-3;

const edgeKey = (p, q) => (p < q ? p + "_" + q : q + "_" + p);

/**
 * 给开放边界补封面（boundary capping）。
 *
 * 流程：焊接（与预检同容差）→ 边统计找 use===1 的边界边 → 串成边界环 → 平面度检查
 * → earcut 补封面 → 按「封面走每条边界边的方向必须与面侧相反」传播定向 → 自检
 * （水密 + 每条边两个方向各一次）。任何一步不满足都返回 null，调用方退回原几何。
 *
 * @param {THREE.BufferGeometry} geometry 任意几何（内部克隆，不改原几何）
 * @param {{weldTolerance?: number, planarTolerance?: number}} [opts]
 * @returns {THREE.BufferGeometry|null} 封盖后的索引几何；无需/无法封盖时 null
 */
export function capOpenEdges(geometry, opts = {}) {
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return null;
  const weldTol = opts.weldTolerance || WELD_TOLERANCE;
  const planarTol = opts.planarTolerance || CAP_PLANAR_TOLERANCE;
  try {
    const welded = weldPositions(geometry, weldTol);
    const edges = countEdges(welded);
    if (edges.openEdges === 0 || edges.nonManifoldEdges > 0) return null;

    const pos = welded.attributes.position;
    const index = welded.index;
    // 面侧走向：边界边被表面三角形遍历的方向（use===1 的边只被这一个面使用）
    const faceDir = new Map();
    for (let i = 0; i + 2 < index.count; i += 3) {
      const t = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      for (let e = 0; e < 3; e++) {
        const p = t[e], q = t[(e + 1) % 3];
        const key = edgeKey(p, q);
        if (edges.edgeUse.get(key) === 1 && !faceDir.has(key)) faceDir.set(key, [p, q]);
      }
    }

    // 边界环提取：每条边界边恰好属于一个环；分叉/断头/不闭合直接放弃
    const remaining = new Set([...edges.edgeUse].filter(([, n]) => n === 1).map(([k]) => k));
    const adj = new Map();
    for (const key of remaining) {
      const [p, q] = key.split("_").map(Number);
      if (!adj.has(p)) adj.set(p, new Set());
      if (!adj.has(q)) adj.set(q, new Set());
      adj.get(p).add(q);
      adj.get(q).add(p);
    }
    const loops = [];
    while (remaining.size > 0) {
      const first = remaining.values().next().value;
      const [p0, q0] = first.split("_").map(Number);
      remaining.delete(first);
      const loop = [p0, q0];
      const guard = edges.boundaryVertices.size + 2;
      for (let step = 0; loop[loop.length - 1] !== p0; step++) {
        if (step > guard) return null;
        const cur = loop[loop.length - 1];
        let next = null;
        for (const nb of adj.get(cur)) {
          if (!remaining.has(edgeKey(cur, nb))) continue;
          if (next !== null) return null; // 分叉：同一顶点挂着 3+ 条边界边
          next = nb;
        }
        if (next === null) return null; // 断头
        remaining.delete(edgeKey(cur, next));
        loop.push(next);
      }
      loop.pop(); // 去掉闭合重复的起点
      if (loop.length < 3) return null;
      loops.push(loop);
    }

    // 平面度 + Newell 法线
    const loopData = loops.map(loop => {
      const n = new Vector3();
      const c = new Vector3();
      for (let i = 0; i < loop.length; i++) {
        const vi = loop[i];
        const vj = loop[(i + 1) % loop.length];
        const px = pos.getX(vi), py = pos.getY(vi), pz = pos.getZ(vi);
        const qx = pos.getX(vj), qy = pos.getY(vj), qz = pos.getZ(vj);
        n.x += (py - qy) * (pz + qz);
        n.y += (pz - qz) * (px + qx);
        n.z += (px - qx) * (py + qy);
        c.x += px; c.y += py; c.z += pz;
      }
      if (n.lengthSq() < 1e-20) return null;
      n.normalize();
      c.multiplyScalar(1 / loop.length);
      for (const vi of loop) {
        const d = Math.abs(
          n.x * (pos.getX(vi) - c.x) + n.y * (pos.getY(vi) - c.y) + n.z * (pos.getZ(vi) - c.z),
        );
        if (d > planarTol) return null;
      }
      return { loop, normal: n, center: c };
    });
    if (loopData.some(d => !d)) return null;

    // 共面分组：嵌套环（空心管的环垫剖面）必须合成一张带洞封面，否则会封成两张
    // 重叠的圆盘。同组 = 法线平行且环质心落在同一平面内。
    const groups = [];
    for (const d of loopData) {
      const g = groups.find(g =>
        Math.abs(g.normal.dot(d.normal)) > 0.999 &&
        Math.abs(g.normal.dot(new Vector3().subVectors(d.center, g.center))) <= planarTol);
      if (g) g.loops.push(d);
      else groups.push({ normal: d.normal.clone(), center: d.center.clone(), loops: [d] });
    }

    const capTris = [];
    for (const g of groups) {
      // 投影基：避开法线最陡分量对应的轴，防止小分量投影退化
      const ref = Math.abs(g.normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
      const tu = new Vector3().crossVectors(ref, g.normal).normalize();
      const tv = new Vector3().crossVectors(g.normal, tu).normalize();
      const polys = g.loops.map(d => d.loop.map(vi => {
        const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
        return new Vector2(x * tu.x + y * tu.y + z * tu.z, x * tv.x + y * tv.y + z * tv.z);
      }));
      const areas = polys.map(poly => Math.abs(ShapeUtils.area(poly)));
      // 父环 = 包含我且面积最小的环（射线法点包含判定）
      const parent = polys.map(() => -1);
      for (let i = 0; i < polys.length; i++) {
        for (let j = 0; j < polys.length; j++) {
          if (i === j || areas[j] <= areas[i]) continue;
          if (!pointInPoly(polys[i][0], polys[j])) continue;
          if (parent[i] === -1 || areas[j] < areas[parent[i]]) parent[i] = j;
        }
      }
      const children = polys.map(() => []);
      polys.forEach((_, i) => { if (parent[i] !== -1) children[parent[i]].push(i); });
      // 偶数深度 = 外轮廓（直接子环当洞），洞里再有环则递归成新封面
      const buildCap = (ci, holes) => {
        const flatIds = [];
        for (const ring of [g.loops[ci].loop, ...holes.map(h => g.loops[h].loop)]) {
          flatIds.push(...ring);
        }
        const faces = ShapeUtils.triangulateShape(polys[ci], holes.map(h => polys[h]));
        for (const f of faces) {
          capTris.push([flatIds[f[0]], flatIds[f[1]], flatIds[f[2]]]);
        }
        for (const h of holes) if (children[h].length) buildCap(h, children[h]);
      };
      polys.forEach((_, i) => { if (parent[i] === -1) buildCap(i, children[i]); });
    }

    // 退化封面过滤：零面积耳尖会让切片器抖动；漏补的边会被最后的水密自检拦下
    const solidTris = capTris.filter(t => {
      const ax = pos.getX(t[0]), ay = pos.getY(t[0]), az = pos.getZ(t[0]);
      const bx = pos.getX(t[1]), by = pos.getY(t[1]), bz = pos.getZ(t[1]);
      const cx = pos.getX(t[2]), cy = pos.getY(t[2]), cz = pos.getZ(t[2]);
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      return nx * nx + ny * ny + nz * nz >= DEGENERATE_AREA_SQ;
    });
    if (solidTris.length === 0) return null;

    // 封面定向：耳切输出不保证与实体朝向一致。以「封面走每条边界边的方向必须与
    // 面侧相反」为种子约束（水密表面每条边两个方向各一次），沿封面共享边传播。
    const capEdgeTris = new Map();
    solidTris.forEach((t, ti) => {
      for (let e = 0; e < 3; e++) {
        const key = edgeKey(t[e], t[(e + 1) % 3]);
        if (!capEdgeTris.has(key)) capEdgeTris.set(key, []);
        capEdgeTris.get(key).push(ti);
      }
    });
    const flipped = new Uint8Array(solidTris.length);
    const decided = new Uint8Array(solidTris.length);
    for (let seed = 0; seed < solidTris.length; seed++) {
      if (decided[seed]) continue;
      const t = solidTris[seed];
      let flip = 0;
      for (let e = 0; e < 3 && !flip; e++) {
        const key = edgeKey(t[e], t[(e + 1) % 3]);
        const fd = faceDir.get(key);
        // 面侧与封面同向 → 违反「相反」约束 → 翻转
        if (fd && fd[0] === t[e] && fd[1] === t[(e + 1) % 3]) flip = 1;
      }
      decided[seed] = 1;
      flipped[seed] = flip;
      const queue = [seed];
      while (queue.length > 0) {
        const ti = queue.pop();
        const tri = solidTris[ti];
        const ordered = flipped[ti] ? [tri[0], tri[2], tri[1]] : tri;
        for (let e = 0; e < 3; e++) {
          const p = ordered[e], q = ordered[(e + 1) % 3];
          const key = edgeKey(p, q);
          if (faceDir.has(key)) {
            const fd = faceDir.get(key);
            if (fd[0] === p && fd[1] === q) return null; // 边界约束不满足
            continue;
          }
          for (const nj of capEdgeTris.get(key)) {
            if (nj === ti || decided[nj]) continue;
            const nt = solidTris[nj];
            const same = (nt[0] === p && nt[1] === q) || (nt[1] === p && nt[2] === q)
              || (nt[2] === p && nt[0] === q);
            decided[nj] = 1;
            flipped[nj] = same ? 1 : 0; // 邻居与我同向走共享边 → 翻转
            queue.push(nj);
          }
        }
      }
    }

    // 组装：原焊接表面 + 定向后的封面
    const indices = Array.from(index.array);
    for (let ti = 0; ti < solidTris.length; ti++) {
      const tri = solidTris[ti];
      if (flipped[ti]) indices.push(tri[0], tri[2], tri[1]);
      else indices.push(tri[0], tri[1], tri[2]);
    }
    const out = new BufferGeometry();
    out.setAttribute("position", new Float32BufferAttribute(Array.from(pos.array), 3));
    out.setIndex(new Uint32BufferAttribute(indices, 1));

    // 自检：封盖后的网格必须水密且每条边两个方向各一次。这一步同时兜底耳切退化、
    // 嵌套环判定失误等一切意外——不满足就整体退回原几何。
    const check = countEdges(out);
    if (check.openEdges > 0 || check.nonManifoldEdges > 0) return null;
    const dirUse = new Map();
    for (let i = 0; i + 2 < indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const p = indices[i + e], q = indices[i + ((e + 1) % 3)];
        const key = edgeKey(p, q);
        const rec = dirUse.get(key);
        if (!rec) dirUse.set(key, { n: 1, p });
        else if (rec.p === p) return null; // 同向两次：整体朝向不一致
        else rec.n++;
      }
    }
    for (const rec of dirUse.values()) {
      if (rec.n !== 2) return null;
    }
    return out;
  } catch {
    return null;
  }
}

// 射线法点包含判定（封盖嵌套环用）
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 把单个部件导出成二进制 STL。
 *
 * @param {Object} part { mesh: THREE.Mesh, name?: string, index?: number }
 * @param {Object} [options]
 * @param {Function} [options.STLExporterClass] 测试缝：默认 three 的 STLExporter
 * @param {number} [options.scaleToMm] 场景单位 -> 毫米（默认 1000）
 * @param {boolean} [options.rotateToZUp] 是否旋转到构建板朝向（默认 true）
 * @param {boolean} [options.capHoles] 是否自动封盖开放边（默认 true；封盖失败退回原几何）
 * @returns {Object} { name, filename, buffer, triangles, sizeMm }
 */
export function exportPartSTL(part, options = {}) {
  const ExporterClass = options.STLExporterClass || STLExporter;
  const scale = options.scaleToMm === undefined ? DEFAULT_SCALE_TO_MM : options.scaleToMm;
  const rotate = options.rotateToZUp !== false;

  const mesh = part && part.mesh ? part.mesh : null;
  const name = part && part.name ? part.name : "未命名部件";
  if (!mesh || !mesh.geometry || !mesh.geometry.attributes || !mesh.geometry.attributes.position) {
    return null;
  }

  // clone 共享 geometry，只覆盖 transform——现场 mesh 的 homePos/explodePos
  // 与正在跑的爆炸动画都不受影响。
  let clone = mesh.clone();
  clone.name = name;

  if (rotate) {
    // three/GLTF Y-up -> 打印 Z-up：绕 X 转 -90°，+Y 落到 +Z。
    // 用 rotation 而不是 matrix 逐项改写，clone 的 matrixAutoUpdate 保持默认。
    clone.rotation.x = -Math.PI / 2;
  }
  clone.updateMatrixWorld(true);
  // 切口封盖：拆解切口的开放边在这一步补封面（默认开启，capHoles:false 关闭）。
  // 必须在缩放前做——焊接容差/平面度阈值按场景单位定义，缩放后数值含义会变。
  // 世界变换烘进几何体后换成单位变换的 mesh，后续对位逻辑不用改。
  if (options.capHoles !== false) {
    const capped = capOpenEdges(clone.geometry.clone().applyMatrix4(clone.matrixWorld));
    if (capped) {
      const flat = new Mesh(capped);
      flat.name = clone.name;
      flat.updateMatrixWorld(true);
      clone = flat;
    }
  }
  // 缩放必须先于对位：clone 的矩阵是 T * R * S，position 在父空间生效，
  // 若等对完位再放大，原本贴底的部件会被撑到板子上下两侧（实测首顶点
  // z = -49.95 而不是 0）。
  if (scale !== 1) {
    clone.scale.setScalar(scale);
  }
  clone.updateMatrixWorld(true);

  // 平放到构建板：XY 居中、min.z = 0。Box3.setFromObject 走的是 matrixWorld，
  // 所以必须在 updateMatrixWorld 之后取，否则拿到的是旋转前的包围盒。
  const box = new Box3().setFromObject(clone);
  if (box.isEmpty()) return null;

  const center = box.getCenter(new Vector3());
  clone.position.x -= center.x;
  clone.position.y -= center.y;
  clone.position.z -= box.min.z;
  clone.updateMatrixWorld(true);

  const exporter = new ExporterClass();
  const result = exporter.parse(clone, { binary: true });
  const buffer = toArrayBuffer(result);

  // 二进制 STL 头部：80 字节（可写部件名）+ uint32 三角形数。
  const triangles = buffer.byteLength >= 84
    ? new DataView(buffer).getUint32(80, true)
    : 0;

  return {
    name,
    filename: stlFilename(name, part && part.index),
    buffer,
    triangles,
    // box 已是缩放后的世界坐标，直接就是毫米
    sizeMm: [
      Math.round((box.max.x - box.min.x) * 100) / 100,
      Math.round((box.max.y - box.min.y) * 100) / 100,
      Math.round((box.max.z - box.min.z) * 100) / 100,
    ],
  };
}

// 拼板：逐部件导出时，小件不会自己排满一块板——切片软件里手动摆 15 个件
// 很痛苦。这里用 Skyline Bottom-Left 启发式把所有件自动排进若干块「板」，
// 文件名带板号（B01-…），切片软件按名字排序时同板相邻。板间距 5mm 是
// FDM 下人工掰件的安全距离。
const PLATE_GAP_MM = 5;

/**
 * 计算拼板布局。
 *
 * @param {Array<{name:string, sizeMm:number[]}>} parts 已导出的部件（sizeMm XY 用得上）
 * @param {number[]} plateSize [宽, 深] 毫米
 * @returns {Array<{name:string, plate:number, xMm:number, yMm:number,
 *            wMm:number, dMm:number, rotated:boolean}>}
 *   xMm/yMm 是部件中心在板上的位置（毫米），plate 从 1 起。
 */
export function planPlateLayout(parts, plateSize) {
  const [pw, pd] = plateSize;
  const items = (parts || [])
    .map((p, index) => ({
      index,
      name: p.name,
      // 旋转后 Y-up → Z-up：sizeMm = [宽, 深, 高]，板面占位是前两个
      // 长边横向先摆，减少 skyline 碎片；只有放不进才转 90°
      w: p.sizeMm[0],
      d: p.sizeMm[1],
      rotated: false,
      // 进深加板间距：件与件之间永远留 PLATE_GAP_MM，紧贴后墙的那一面不用留
      //（首排 top=0），用「先加后减」的方式在最前排抵消。
      effD: p.sizeMm[1] + PLATE_GAP_MM,
    }))
    .filter(it => it.w <= pw && it.d <= pd || it.d <= pw && it.w <= pd)
    .map(it => {
      // 原始朝向放不进时转 90°
      if (it.w > pw || it.effD > pd) {
        const w = it.w; it.w = it.d; it.d = w; it.effD = it.d + PLATE_GAP_MM; it.rotated = true;
      }
      return it;
    })
    .sort((a, b) => b.effD - a.effD); // 高件先放（FFDH），skyline 更平

  const segments = [{ x: 0, width: pw, height: 0 }];
  const placed = [];
  let currentPlate = 1;

  for (const it of items) {
    let best = null; // {plate, x, top, y}
    const tryPlate = (startSeg) => {
      // 在 skyline 上找能放下 it.w 宽、高度 >= it.d 的最低位置
      for (let i = startSeg; i < segments.length; i++) {
        // 收缩窗口：从 seg i 起，宽度达到 it.w 的连续段，取最大高度
        let width = 0, maxH = 0, j = i;
        while (j < segments.length && width < it.w) {
          maxH = Math.max(maxH, segments[j].height);
          width += segments[j].width;
          j++;
        }
        if (width < it.w) break; // 后面不够宽
        const x = segments[i].x;
        if (best === null || maxH < best.top || (maxH === best.top && x < best.x)) {
          best = { seg: i, x, top: maxH };
        }
      }
    };
    tryPlate(0);
    if (best === null || best.top + it.effD > pd) {
      // 当前板放不下 → 换新板
      currentPlate++;
      segments.length = 0;
      segments.push({ x: 0, width: pw, height: 0 });
      best = { seg: 0, x: 0, top: 0 };
    }
    const x = best.x;
    const y = best.top;
    // 更新 skyline：把 [x, x+it.w] 这段抬高到 y + it.d
    let remaining = it.w, si = best.seg;
    const newSegs = [];
    // 拆分被覆盖的段
    while (remaining > 0 && si < segments.length) {
      const s = segments[si];
      const take = Math.min(s.width, remaining);
      if (s.x < x) {
        newSegs.push({ x: s.x, width: x - s.x, height: s.height });
      }
      newSegs.push({ x: Math.max(s.x, x), width: take, height: y + it.effD });
      remaining -= take;
      si++;
    }
    // 后面未覆盖的段保持
    for (; si < segments.length; si++) newSegs.push(segments[si]);
    segments.length = 0;
    segments.push(...newSegs);
    // 首排贴墙（y=0）不留间距：占位高度里预加了 gap，中心位置减回来
    const yCenter = y === 0 ? it.d / 2 : y + it.effD / 2 - PLATE_GAP_MM / 2;
    placed.push({ index: it.index, name: it.name, plate: currentPlate, xMm: x + it.w / 2, yMm: yCenter, wMm: it.w, dMm: it.d, rotated: it.rotated });
  }
  // 回排到输入顺序：调用方按下标对齐（部件名可能重复，名字对齐不可靠）
  return placed.sort((a, b) => a.index - b.index);
}

/**
 * 整模型导出：逐部件 STL。
 *
 * 默认开启装配定位销（joinFeatures !== false）：在装配位相邻部件的贴合面上
 * 自动配对加销与孔，打印出来可以直接对位拼装。原场景 mesh 不会被修改——
 * CSG 结果烘进导出副本的 geometry。
 *
 * @param {Array<Object>} parts [{ mesh, name, index }]
 * @param {Object} [options] 同 exportPartSTL，另加：
 * @param {boolean|Object} [options.joinFeatures] false 关闭；对象则覆盖 JOIN_DEFAULTS
 * @param {boolean} [options.capHoles] false 关闭切口封盖（默认开启，逐部件透传 exportPartSTL）
 * @returns {Array<Object>} 导出结果数组（无效部件被跳过）
 */
export function exportModelSTL(parts, options = {}) {
  if (!Array.isArray(parts)) return [];
  const scale = options.scaleToMm === undefined ? DEFAULT_SCALE_TO_MM : options.scaleToMm;
  const joinOpt = options.joinFeatures === undefined ? {} : options.joinFeatures;
  let decorated = parts;
  if (joinOpt !== false) {
    try {
      const pairs = findJoinPairs(parts, joinOpt);
      const cutsByPart = new Map();
      const pinsByPart = new Map();
      for (const pair of pairs) {
        for (const pt of pair.points) {
          // A 侧挖孔，B 侧加销；pair.a/pair.b 是 parts 的下标
          const cuts = cutsByPart.get(pair.a) || [];
          cuts.push({ pt, axis: pair.axis });
          cutsByPart.set(pair.a, cuts);
          const pins = pinsByPart.get(pair.b) || [];
          pins.push({ pt, axis: pair.axis });
          pinsByPart.set(pair.b, pins);
        }
      }
      // 给有销/孔的部件换上 CSG 后的独立 geometry；applyJoinFeatures 返回
      // 世界坐标几何，因此新 mesh 的变换必须全部归零，否则 exportPartSTL
      // 的 clone 会把部件变换再叠加一次。原场景 mesh 不受影响。
      decorated = parts.map((p, i) => {
        const cuts = cutsByPart.get(i);
        const pins = pinsByPart.get(i);
        if (!cuts && !pins) return p;
        const geo = applyJoinFeatures(p.mesh, cuts, pins, { scaleToMm: scale, ...joinOpt });
        // CSG 失败（空几何）时退回原样导出，宁可没有销也不要空文件
        if (!geo || !geo.attributes || !geo.attributes.position.count) return p;
        const mesh = new Mesh(geo);
        mesh.updateMatrixWorld(true);
        return { ...p, mesh, joined: true };
      });
    } catch {
      // 定位销只是增强特性，任何失败都退回无销导出
      decorated = parts;
    }
  }
  const results = decorated
    .map(p => exportPartSTL(p, options))
    .filter(Boolean);

  // 拼板排版：多件模型按目标打印机尺寸分板，文件名带板号（B01-…），
  // 切片软件里按名字排序即同板相邻；同板件的左下角位置写进 sizeMm 旁的
  // platePosMm，供想要「整板一次导完」的用户参考。
  if (options.autoPlate !== false && results.length > 1) {
    try {
      const buildKey = options.buildVolume || "bambu_x1c";
      // planPlateLayout 输入顺序与 results 一一对应（名字可能重复，按下标回填）
      const plan = planPlateLayout(
        results.map(r => ({ name: r.name, sizeMm: r.sizeMm })),
        PLATE_SIZE_MM[buildKey] || PLATE_SIZE_MM.bambu_x1c,
      );
      const plates = new Set(plan.map(pl => pl.plate));
      results.forEach((r, i) => {
        const pl = plan[i];
        if (!pl) return;
        r.plate = pl.plate;
        r.platePosMm = [Math.round(pl.xMm * 100) / 100, Math.round(pl.yMm * 100) / 100];
        r.filename = plFilename(r.name, pl.plate, i);
      });
      results.plateCount = plates.size;
    } catch {
      // 排版失败不影响导出本身
    }
  }
  return results;
}

// 拼板板面尺寸（毫米 XY），与 print-analyze.js 的 BUILD_VOLUMES 键一致
const PLATE_SIZE_MM = {
  bambu_x1c: [256, 256],
  bambu_a1: [256, 256],
  prusa_mk4: [250, 210],
  ender3: [220, 220],
};

// 带板号的文件名：B01-主机身-01.stl。同板件在切片软件的文件列表里相邻。
function plFilename(name, plate, index) {
  return "B" + String(plate).padStart(2, "0") + "-" + stlFilename(name, index);
}

/**
 * STLExporter.parse(binary:true) 在不同 three 版本返回 DataView 或 ArrayBuffer，
 * 统一成 ArrayBuffer，避免调用方到处 instanceof。
 */
function toArrayBuffer(result) {
  if (!result) return new ArrayBuffer(0);
  if (result instanceof ArrayBuffer) return result;
  if (typeof result === "object" && result.buffer instanceof ArrayBuffer) {
    return result.buffer;
  }
  return new ArrayBuffer(0);
}

/**
 * 文件名安全化：STL 没有文件名标准，但切片软件的库按名字列部件，
 * 斜杠/反斜杠会当成路径分隔符，控制字符会让部分导入器直接报错。
 */
export function stlFilename(name, index) {
  const base = String(name || "part")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim() || "part";
  const suffix = typeof index === "number" ? "-" + String(index + 1).padStart(2, "0") : "";
  return base + suffix + ".stl";
}

/**
 * 把二进制 STL 的 80 字节头写成部件名，方便在切片软件里认人。
 * 头是自由文本，写不下就截断——不能溢出，否则会吃掉三角形计数字段。
 */
export function writeSTLHeader(buffer, name) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 84) return buffer;
  const view = new DataView(buffer);
  const text = String(name || "").slice(0, 79);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < bytes.length ? bytes[i] : 0x20);
  }
  return buffer;
}
