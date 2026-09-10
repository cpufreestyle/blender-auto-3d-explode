/**
 * Quest 3 部位命名与几何合并（纯逻辑模块）。
 *
 * 从 main.js 提取：仅依赖 three、./explode-geometry.js 与 ./geometry-split.js，
 * 不引用 scene / camera / modelGroup 等模块级渲染状态。
 */

import { Box3, Mesh, MeshStandardMaterial, Vector3 } from "three";

import { mergeGeometries } from "./explode-geometry.js";
import { extractFacesToGeometry } from "./geometry-split.js";

// ===== Quest 3 原始 15 部位名称及归一化位置模板 =====
// 从共享配置文件 quest3_config.json 加载，回退到内置默认值
// 坐标系: X=左右 Y=上下 Z=前后, 归一化到 [-1, 1]
// 模型包围盒: X[-1.25,1.25] Y[-0.575,1.6] Z[-0.64,0.72]
// 中心=(0, 0.5125, 0.04) 半幅=(1.25, 1.0875, 0.68)
let QUEST3_PART_TEMPLATES = [
  { name: "主机身", pos: [0.0, -0.47, -0.06] },
  { name: "前面板", pos: [0.0, -0.47, 0.75] },
  { name: "面罩海绵", pos: [0.0, -0.47, -0.87] },
  { name: "左透镜模组", pos: [-0.42, -0.43, -0.24] },
  { name: "右透镜模组", pos: [0.42, -0.43, -0.24] },
  { name: "左透镜", pos: [-0.42, -0.43, -0.56] },
  { name: "右透镜", pos: [0.42, -0.43, -0.56] },
  { name: "主板", pos: [0.0, -0.43, -0.13] },
  { name: "左摄像头", pos: [-0.6, -0.31, 0.94] },
  { name: "右摄像头", pos: [0.6, -0.31, 0.94] },
  { name: "中置摄像头", pos: [0.0, -0.21, 0.94] },
  { name: "下置追踪摄像头", pos: [0.0, -0.79, 0.82] },
  { name: "左头带臂", pos: [-1.0, -0.47, -0.06] },
  { name: "右头带臂", pos: [1.0, -0.47, -0.06] },
  { name: "头带", pos: [0.0, 0.45, -0.59] },
];

// 异步加载共享配置文件，覆盖内置默认值
fetch("quest3_config.json")
  .then(r => r.json())
  .then(cfg => {
    if (cfg.parts && cfg.parts.length > 0) {
      QUEST3_PART_TEMPLATES = cfg.parts;
      console.log(`📋 已加载 quest3_config.json (${cfg.parts.length} 个部位)`);
    }
  })
  .catch(() => {
    console.log("📋 使用内置 Quest 3 配置（quest3_config.json 不可用）");
  });

/**
 * 根据部件空间位置，将检测到的部件匹配到 Quest 3 原始 15 部位名称
 * 使用贪心最近邻匹配算法：计算所有 部件-模板 对的加权距离，
 * 按距离升序贪心分配，确保全局最优近似。
 *
 * @param {Array} parts  - customModelParts 数组，每个元素含 partCenter
 * @param {Box3} modelBox - 已居中的模型包围盒
 * @returns {string[]} 与 parts 等长的名称数组
 */
export function assignQuest3PartNames(parts, modelBox) {
  if (parts.length === 0) return [];

  const size = modelBox.getSize(new Vector3());
  const halfExtents = new Vector3(
    Math.max(size.x / 2, 0.001),
    Math.max(size.y / 2, 0.001),
    Math.max(size.z / 2, 0.001)
  );

  // 将每个部件的中心位置归一化到 [-1, 1]
  const normalizedCenters = parts.map(part => {
    return new Vector3(
      part.partCenter.x / halfExtents.x,
      part.partCenter.y / halfExtents.y,
      part.partCenter.z / halfExtents.z
    );
  });

  // 计算所有 部件-模板 对的加权距离
  const pairs = [];
  for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
    const tpl = QUEST3_PART_TEMPLATES[t];
    for (let p = 0; p < parts.length; p++) {
      const nc = normalizedCenters[p];
      const dx = nc.x - tpl.pos[0];
      const dy = nc.y - tpl.pos[1];
      const dz = nc.z - tpl.pos[2];
      // 加权距离：X、Z 权重 1.0（左右/前后更可靠），Y 权重 0.7（高度可能因头带比例变化）
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      pairs.push({ templateIdx: t, partIdx: p, dist });
    }
  }

  // 按距离升序排列，贪心匹配
  pairs.sort((a, b) => a.dist - b.dist);

  const usedParts = new Set();
  const usedTemplates = new Set();
  const assignments = new Array(parts.length).fill(null);

  for (const pair of pairs) {
    if (usedParts.has(pair.partIdx) || usedTemplates.has(pair.templateIdx)) continue;
    usedParts.add(pair.partIdx);
    usedTemplates.add(pair.templateIdx);
    assignments[pair.partIdx] = QUEST3_PART_TEMPLATES[pair.templateIdx].name;
  }

  // 未匹配到 Quest 3 模板的部件使用通用名称
  let extraIdx = 1;
  for (let i = 0; i < parts.length; i++) {
    if (!assignments[i]) {
      assignments[i] = `附加部件${extraIdx++}`;
    }
  }

  console.log(
    "🏷️ Quest 3 部件名称匹配结果:",
    parts.map((p, i) => ({
      name: assignments[i],
      center: p.partCenter.toArray().map(v => v.toFixed(2)),
    }))
  );

  return assignments;
}

/**
 * 将拆解后的多个部件按 Quest 3 原始 15 部位模板聚类合并
 * 把属于同一 Quest 3 区域的部件几何体合并为一个 mesh
 *
 * @param {Array} splitParts - autoSplitModel 返回的数组，每项含 mesh
 * @param {Box3} modelBox - 已居中的模型包围盒
 * @returns {Array} 合并后的 splitParts（最多 15 个），每项已含 Quest 3 名称
 */
export function mergePartsToQuest3(splitParts, modelBox) {
  if (splitParts.length === 0) return splitParts;

  const size = modelBox.getSize(new Vector3());
  const halfExtents = new Vector3(
    Math.max(size.x / 2, 0.001),
    Math.max(size.y / 2, 0.001),
    Math.max(size.z / 2, 0.001)
  );

  // 为每个 splitPart 找最近的 Quest 3 模板
  const groups = {}; // templateIdx -> [splitParts indices]
  for (let p = 0; p < splitParts.length; p++) {
    const mesh = splitParts[p].mesh;
    mesh.updateMatrixWorld(true);
    const box = new Box3().setFromObject(mesh);
    const center = box.getCenter(new Vector3());

    // 归一化到 [-1, 1]
    const nx = center.x / halfExtents.x;
    const ny = center.y / halfExtents.y;
    const nz = center.z / halfExtents.z;

    let bestT = 0,
      bestDist = Infinity;
    for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
      const tpl = QUEST3_PART_TEMPLATES[t];
      const dx = nx - tpl.pos[0];
      const dy = ny - tpl.pos[1];
      const dz = nz - tpl.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestT = t;
      }
    }

    if (!groups[bestT]) groups[bestT] = [];
    groups[bestT].push(p);
  }

  console.log(`🏷️ Quest 3 聚类: ${splitParts.length} 个部件 -> ${Object.keys(groups).length} 组`);

  // 对每组合并几何体
  const mergedParts = [];
  for (const tStr of Object.keys(groups)) {
    const t = parseInt(tStr);
    const indices = groups[t];
    const name = QUEST3_PART_TEMPLATES[t].name;

    if (indices.length === 1) {
      // 只有一个部件，直接使用
      const part = splitParts[indices[0]];
      part.name = name;
      mergedParts.push(part);
    } else {
      // 合并多个几何体
      const meshes = indices.map(i => splitParts[i].mesh);
      const geometries = meshes.map(m => {
        m.updateMatrixWorld(true);
        const geo = m.geometry.clone();
        geo.applyMatrix4(m.matrixWorld);
        return geo;
      });
      const mergedGeo = mergeGeometries(geometries);
      // 使用第一个 mesh 的材质
      const firstMesh = meshes[0];
      const material = Array.isArray(firstMesh.material)
        ? firstMesh.material[0]
        : firstMesh.material;
      const newMesh = new Mesh(mergedGeo, material);
      newMesh.position.set(0, 0, 0);
      newMesh.rotation.set(0, 0, 0);
      newMesh.scale.set(1, 1, 1);
      newMesh.matrixAutoUpdate = true;
      newMesh.matrix.identity();
      newMesh.castShadow = true;
      newMesh.receiveShadow = true;
      newMesh.name = name;
      newMesh.userData = { name };
      mergedParts.push({ mesh: newMesh, name, isOriginal: false });
    }
  }

  return mergedParts;
}

/**
 * 直接将模型几何体按面分配到 Quest 3 原始 15 个区域
 * 不经过"先拆后合"，而是对每个三角面计算其归一化中心，
 * 分配到最近的 Quest 3 模板区域，保证 15 个部位都有几何体。
 *
 * @param {Group} model - gltf.scene
 * @returns {Array} splitParts 数组，恰好 15 个（跳过完全空的）
 */
export function splitModelToQuest3Regions(model) {
  // 1. 收集所有 mesh，烘焙世界变换到几何体
  const allGeometries = [];
  const allMaterials = [];
  model.traverse(child => {
    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      child.updateMatrixWorld(true);
      const geo = child.geometry.clone();
      geo.applyMatrix4(child.matrixWorld);
      allGeometries.push(geo);
      const mat = Array.isArray(child.material) ? child.material[0] : child.material;
      allMaterials.push(mat);
    }
  });

  if (allGeometries.length === 0) return [];

  // 2. 计算整体包围盒，用于归一化
  const bbox = new Box3();
  for (const geo of allGeometries) {
    geo.computeBoundingBox();
    bbox.union(geo.boundingBox);
  }
  const center = bbox.getCenter(new Vector3());
  const size = bbox.getSize(new Vector3());
  const halfExtents = new Vector3(
    Math.max(size.x / 2, 0.001),
    Math.max(size.y / 2, 0.001),
    Math.max(size.z / 2, 0.001)
  );

  // 3. 居中所有几何体
  for (const geo of allGeometries) {
    geo.translate(-center.x, -center.y, -center.z);
  }

  // 4. 为每个面分配到最近的 Quest 3 模板
  //    templateIdx -> [{geo, faces}]
  const templateFaces = Array.from({ length: QUEST3_PART_TEMPLATES.length }, () => ({
    faces: [],
    material: null,
  }));

  const tmpCenter = new Vector3();
  const tmpV = new Vector3();

  for (let gi = 0; gi < allGeometries.length; gi++) {
    const geo = allGeometries[gi];
    const pos = geo.attributes.position;
    const index = geo.index;
    const faceCount = index ? index.count / 3 : pos.count / 3;

    for (let f = 0; f < faceCount; f++) {
      // 计算三角面中心的归一化坐标
      tmpCenter.set(0, 0, 0);
      for (let v = 0; v < 3; v++) {
        const srcIdx = index ? index.getX(f * 3 + v) : f * 3 + v;
        tmpV.fromBufferAttribute(pos, srcIdx);
        tmpCenter.add(tmpV);
      }
      tmpCenter.divideScalar(3);

      const nx = tmpCenter.x / halfExtents.x;
      const ny = tmpCenter.y / halfExtents.y;
      const nz = tmpCenter.z / halfExtents.z;

      // 找最近的 Quest 3 模板
      let bestT = 0,
        bestDist = Infinity;
      for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
        const tpl = QUEST3_PART_TEMPLATES[t];
        const dx = nx - tpl.pos[0];
        const dy = ny - tpl.pos[1];
        const dz = nz - tpl.pos[2];
        const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
        if (dist < bestDist) {
          bestDist = dist;
          bestT = t;
        }
      }

      templateFaces[bestT].faces.push({ geoIndex: gi, faceIndex: f, nx, ny, nz });
      if (!templateFaces[bestT].material) {
        templateFaces[bestT].material = allMaterials[gi];
      }
    }
  }

  // 4.5. 面重分配：对于没有分配到任何面的空模板，
  //      从最近的已占用模板中「借取」距离空模板最近的面。
  //      这解决了透镜/透镜模组、主板/主机身等位置过近导致的面被「抢走」问题。
  for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
    if (templateFaces[t].faces.length > 0) continue;

    const emptyPos = QUEST3_PART_TEMPLATES[t].pos;

    // 找到距离空模板最近的已占用模板
    let bestSourceT = -1,
      bestSourceDist = Infinity;
    for (let s = 0; s < QUEST3_PART_TEMPLATES.length; s++) {
      if (s === t || templateFaces[s].faces.length === 0) continue;
      const sPos = QUEST3_PART_TEMPLATES[s].pos;
      const dx = emptyPos[0] - sPos[0];
      const dy = emptyPos[1] - sPos[1];
      const dz = emptyPos[2] - sPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy * 0.7 + dz * dz);
      if (dist < bestSourceDist) {
        bestSourceDist = dist;
        bestSourceT = s;
      }
    }

    if (bestSourceT === -1) continue;

    // 按到空模板的距离升序排列源模板的所有面
    const sourceFaces = templateFaces[bestSourceT].faces;
    sourceFaces.sort((a, b) => {
      const da = Math.sqrt(
        (a.nx - emptyPos[0]) ** 2 + (a.ny - emptyPos[1]) ** 2 * 0.7 + (a.nz - emptyPos[2]) ** 2
      );
      const db = Math.sqrt(
        (b.nx - emptyPos[0]) ** 2 + (b.ny - emptyPos[1]) ** 2 * 0.7 + (b.nz - emptyPos[2]) ** 2
      );
      return da - db;
    });

    // 借取最近的 15% 面（至少 5 个，最多 50%）
    const stealCount = Math.max(
      5,
      Math.min(Math.floor(sourceFaces.length * 0.15), Math.floor(sourceFaces.length * 0.5))
    );
    const stolenFaces = sourceFaces.splice(0, stealCount);
    templateFaces[t].faces = stolenFaces;
    if (!templateFaces[t].material && templateFaces[bestSourceT].material) {
      templateFaces[t].material = templateFaces[bestSourceT].material;
    }

    console.log(
      `🔄 面重分配: "${QUEST3_PART_TEMPLATES[t].name}" 从 "${QUEST3_PART_TEMPLATES[bestSourceT].name}" 借取 ${stealCount} 个面`
    );
  }

  // 5. 为每个模板创建 mesh
  const splitParts = [];
  for (let t = 0; t < QUEST3_PART_TEMPLATES.length; t++) {
    const tf = templateFaces[t];
    if (tf.faces.length === 0) continue;

    const name = QUEST3_PART_TEMPLATES[t].name;

    // 收集属于这个模板的所有面，按源几何体分组
    const byGeo = new Map();
    for (const { geoIndex, faceIndex } of tf.faces) {
      if (!byGeo.has(geoIndex)) byGeo.set(geoIndex, []);
      byGeo.get(geoIndex).push(faceIndex);
    }

    // 提取面到新几何体
    const geometries = [];
    for (const [gi, faceIndices] of byGeo) {
      const srcGeo = allGeometries[gi];
      const newGeo = extractFacesToGeometry(srcGeo, faceIndices);
      if (newGeo && newGeo.attributes.position.count > 0) {
        geometries.push(newGeo);
      }
    }

    if (geometries.length === 0) continue;

    const mergedGeo = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
    const material = tf.material || new MeshStandardMaterial({ color: 0x888888 });
    const mesh = new Mesh(mergedGeo, material);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.matrixAutoUpdate = true;
    mesh.matrix.identity();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    mesh.userData = { name };

    splitParts.push({ mesh, name, isOriginal: false });
  }

  console.log(`🏷️ Quest 3 区域切割: ${splitParts.length} 个部件`);
  return splitParts;
}
