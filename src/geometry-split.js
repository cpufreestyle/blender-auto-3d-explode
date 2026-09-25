// 几何体拆分工具 — 从 main.js 抽出（L2 模块化试点）。
//
// 本模块为「纯函数」：仅依赖 THREE、src/utils.js 的 UnionFind / generatePartName，
// 不引用 main.js 的共享状态（scene/camera/parts/questGroup 等），因此可独立复用与测试。
// 与 main.js 共用同一个 "three" 裸导入实例（ESM 按解析路径缓存，材质/几何类型一致）。

import { Box3, BufferGeometry, Float32BufferAttribute, Mesh, Vector3 } from "three";
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

// 自动拆分编排器：收集 mesh，按材质组和连通分量准确拆分（从 main.js 抽取，行为不变）。
// mesh 数 >= 2 时直接沿用原始 mesh（保持准确）；仅 1 个 mesh 时依次尝试材质组、
// 连通分量两种自然拆分，都不适用则保留原 mesh（不强制空间切分）。
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
    const ccResults = splitByConnectedComponents(geometry);
    if (ccResults.length >= 2) {
      for (const ccGeo of ccResults) {
        const newMesh = new Mesh(ccGeo, material);
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
