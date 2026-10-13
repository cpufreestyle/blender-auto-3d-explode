// manifest 离线重放（split manifest replay）
//
// 背景：manifest 是几何摘要而非顶点副本（见 src/split-manifest.js 的设计取舍），
// 所以重放还原的是「布局与拆解关系」，不是精确网格。本模块把这份数据变成
// 可交互的三维场景：每个部件用它的包围盒代理，按 progress 在「装配位」与
// 「爆炸位」之间插值。
//
// 三个导出：
//   · replayPlan(manifest)      —— 纯数据：把 manifest 转成带插值端点的计划；
//   · replayPartTransforms(...)  —— 纯函数：给定进度求每个部件的位置；
//   · createReplayScene(...)     —— three 工厂：建场景/相机/控制器/代理网格。
//
// 拆分的目的：前两个不碰 three 的对象图，可以在 Node 里对数值与边界做完整
// 断言；第三个只负责把前两者的结果画出来。

import { Box3, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { inspectManifestVersion } from "./manifest-version.js";

// 进度钳制：外部传入 0..1 之外的值时按边界处理，而不是让部件飞出场景。
export function clampProgress(p) {
  const n = Number(p);
  // NaN 回 0：它不是「很小」而是「没有意义」，当成 0 至少是装配位这个安全态。
  // ±Infinity 走 Math.min/max 的钳制——Infinity 是「超过 1」的极端形式，
  // 落到上界比落到下界更符合直觉。
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function toVec3(a, fallback = [0, 0, 0]) {
  // 不是数组时整体用 fallback；是数组但短于 3 项时逐项补 fallback——
  // size: [2,3] 应该得到 (2,3,0)，而不是被整体丢弃成单位盒，
  // 否则「只写了两个维度」会静默变成一个完全不同的尺寸。
  if (!Array.isArray(a)) return new Vector3(fallback[0], fallback[1], fallback[2]);
  const pick = (i) => {
    const raw = a[i];
    const n = Number(raw);
    if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) {
      return fallback[i];
    }
    return n;
  };
  return new Vector3(pick(0), pick(1), pick(2));
}

// 部件是否可用：有名字、有非空包围盒。manifest 的 summary.skipped 已经
// 拦掉过一批坏件，但重放要能直接吃「手写或别处生成」的 manifest，
// 所以这里再独立判一次——两个模块的容错不互相依赖。
function usablePart(part) {
  if (!part || typeof part !== "object") return false;
  if (!Array.isArray(part.centroid) || part.centroid.length < 3) return false;
  if (!Array.isArray(part.explodePos) || part.explodePos.length < 3) return false;
  return true;
}

/**
 * manifest -> 重放计划（纯数据）。
 *
 * @param {object} manifest parseSplitManifest 的产物或等价对象
 * @returns {{model:string, totalParts:number, bounds:object,
 *           parts:Array<{index,name,isOriginal,from:Vector3,to:Vector3,
 *                         size:Vector3,triangles:number,volume:number}>,
 *           skipped:number, reasons:string[]}}
 *   manifest 不可用时返回 totalParts 0 的计划，不抛错。
 */
export function replayPlan(manifest) {
  const empty = {
    model: "",
    totalParts: 0,
    bounds: { min: new Vector3(), max: new Vector3() },
    parts: [],
    skipped: 0,
    reasons: [],
    versionStatus: "unsupported",
  };
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.parts)) {
    return Object.assign(empty, { reasons: ["manifest 不是对象或缺 parts 数组"] });
  }

  // 版本协商：不兼容时直接返回空计划，并把原因写进 reasons。
  // 放在这里而不是只让调用方检查，是因为「按错误语义解析出来的计划」比
  // 「没有计划」更危险——前者看起来能用，实际每个字段的含义都可能已经变了。
  const ver = inspectManifestVersion(manifest);
  if (!ver.supported) {
    return Object.assign(empty, {
      reasons: [ver.message],
      versionStatus: ver.status,
    });
  }

  const parts = [];
  const reasons = [];
  let skipped = 0;
  for (let i = 0; i < manifest.parts.length; i++) {
    const p = manifest.parts[i];
    if (!usablePart(p)) {
      skipped++;
      reasons.push(`index ${i}: 缺 centroid 或 explodePos`);
      continue;
    }
    parts.push({
      index: parts.length,
      name: typeof p.name === "string" && p.name ? p.name : `部件${i + 1}`,
      isOriginal: Boolean(p.isOriginal),
      from: toVec3(p.centroid),
      to: toVec3(p.explodePos),
      size: toVec3(p.size, [1, 1, 1]),
      triangles: Number(p.triangles) || 0,
      volume: Number(p.volume) || 0,
    });
  }

  const min = toVec3(manifest.bounds && manifest.bounds.min);
  const max = toVec3(manifest.bounds && manifest.bounds.max);
  if (max.x < min.x || max.y < min.y || max.z < min.z) {
    reasons.push("manifest.bounds 的 min/max 顺序异常，已按零体积处理");
  }

  return {
    model: typeof manifest.model === "string" ? manifest.model : "",
    totalParts: parts.length,
    versionStatus: ver.status,
    bounds: { min, max },
    parts,
    skipped,
    reasons,
  };
}

/**
 * 给定进度求每个部件的目标位置（纯函数）。
 *
 * 线性插值：progress 0 = 装配位，1 = 爆炸位。用线性而不是缓动，是因为
 * 进度条本身就是时间的函数，缓动应该由调用方在把 progress 喂进来之前做——
 * 在这里做会让「同一进度对应两个位置」，拖拽滑块时无法复现。
 *
 * @param {object} plan replayPlan 的产物
 * @param {number} progress 0..1，范围外按边界钳制
 * @returns {Vector3[]} 与 plan.parts 等长、同序的位置数组
 */
export function replayPartTransforms(plan, progress) {
  const t = clampProgress(progress);
  if (!plan || !Array.isArray(plan.parts)) return [];
  return plan.parts.map((p) => new Vector3().lerpVectors(p.from, p.to, t));
}

/**
 * 建重放场景（three 工厂）。
 *
 * 每个部件一个 Box3 代理网格：按 plan.parts[i].size 建盒，位置由
 * replayPartTransforms 给出。颜色按 index 均匀分布在色相环上，相邻部件
 * 不撞色——拆解视图里「分清谁是谁」比真实材质更重要。
 *
 * 注入面（测试用）：BoxGeometry / renderer / 其余 three 类。生产中恒为真类。
 *
 * @returns {{group:Group, setProgress:(n:number)=>void, dispose:()=>void,
 *           partMeshes:Mesh[]}}
 */
export function createReplayScene({
  plan,
  BoxGeometry,
  materialFactory,
} = {}) {
  if (!plan || !Array.isArray(plan.parts)) {
    throw new Error("createReplayScene 需要 replayPlan 的产物");
  }
  if (typeof BoxGeometry !== "function") {
    throw new Error("createReplayScene 需要注入 BoxGeometry");
  }

  const group = new Group();
  const partMeshes = [];
  const disposables = [];

  const makeMat =
    typeof materialFactory === "function"
      ? materialFactory
      : (hue) => new MeshStandardMaterial({
          color: new Color().setHSL(hue, 0.55, 0.55),
          roughness: 0.45,
          metalness: 0.05,
        });

  plan.parts.forEach((p, i) => {
    const hue = plan.parts.length <= 1 ? 0.58 : i / plan.parts.length;
    const mat = makeMat(hue);
    const geo = new BoxGeometry(
      Math.max(p.size.x, 1e-6),
      Math.max(p.size.y, 1e-6),
      Math.max(p.size.z, 1e-6),
    );
    const mesh = new Mesh(geo, mat);
    mesh.name = p.name;
    mesh.position.copy(p.from);
    mesh.userData.partIndex = p.index;
    mesh.userData.partName = p.name;
    group.add(mesh);
    partMeshes.push(mesh);
    disposables.push(geo, mat);
  });

  function setProgress(n) {
    const positions = replayPartTransforms(plan, n);
    partMeshes.forEach((m, i) => {
      if (positions[i]) m.position.copy(positions[i]);
    });
  }

  function dispose() {
    for (const d of disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    partMeshes.length = 0;
    group.clear();
  }

  return { group, partMeshes, setProgress, dispose };
}

