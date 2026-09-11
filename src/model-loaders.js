/**
 * STL / URDF 模型加载器。
 *
 * 从 main.js 提取。二者需要读写场景状态（customModelGroup / customModelParts）
 * 并回调 UI 与统一收尾流程，因此这些依赖由调用方通过 deps 注入，
 * 使本模块不直接引用 main.js 的模块级变量。
 *
 * @typedef {object} LoaderDeps
 * @property {(msg: string, type?: string) => void} showStatus
 * @property {() => void} clearCustomModelGroup
 * @property {(fileName: string, opts?: object) => void} finalizeCustomModelLoad
 * @property {import("three").Group} customModelGroup
 * @property {Array} customModelParts
 */

import {
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";

import { calculateExplodePos } from "./explode-geometry.js";
import { assignQuest3PartNames, mergePartsToQuest3 } from "./quest3-parts.js";
import { isQuest3Model } from "./utils.js";

// 动态导入 STLLoader（懒加载，避免计入首屏包）
let STLLoader = null;
async function loadSTLLoader() {
  if (!STLLoader) {
    const module = await import("three/examples/jsm/loaders/STLLoader.js");
    STLLoader = module.STLLoader;
  }
  return STLLoader;
}

/**
 * 解析并加载 STL 模型（单部件）
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} fileName
 * @param {LoaderDeps} deps
 */
export async function loadSTLModel(arrayBuffer, fileName, deps) {
  const {
    showStatus,
    clearCustomModelGroup,
    finalizeCustomModelLoad,
    customModelGroup,
    customModelParts,
  } = deps;
  try {
    showStatus("📦 正在解析 STL 模型...", "info");

    const STLLoaderClass = await loadSTLLoader();
    const loader = new STLLoaderClass();
    const geometry = loader.parse(arrayBuffer);

    // 清除之前的自定义模型
    clearCustomModelGroup();

    // 居中几何体
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const center = box.getCenter(new Vector3());
    geometry.translate(-center.x, -center.y, -center.z);

    // 计算缩放使模型适配视图
    const size = box.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? 2.0 / maxDim : 1.0;
    geometry.scale(scale, scale, scale);

    // 创建材质和 mesh
    const material = new MeshStandardMaterial({
      color: 0x808080,
      metalness: 0.3,
      roughness: 0.7,
    });
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = fileName;

    // 计算部件中心和爆炸方向
    const partBox = new Box3().setFromObject(mesh);
    const partCenter = partBox.getCenter(new Vector3());

    customModelParts.push({
      mesh,
      homePos: new Vector3(0, 0, 0),
      explodePos: new Vector3(0, 2, 0),
      homeRot: new Euler(0, 0, 0),
      explodeRot: new Euler(0, 0, 0),
      name: fileName, // 稍后由命名步骤覆盖
      partCenter: partCenter.clone(),
      stepIndex: 1,
    });

    customModelGroup.add(mesh);

    // ========== 命名 ==========
    if (isQuest3Model(fileName)) {
      // Quest 3 模型：使用 Quest 3 原始部位名称
      const stlBox = new Box3().setFromObject(mesh);
      const stlNames = assignQuest3PartNames(customModelParts, stlBox);
      customModelParts[0].name = stlNames[0];
      customModelParts[0].mesh.userData = { name: stlNames[0] };
      customModelParts[0].mesh.name = stlNames[0];
    } else {
      // 非 Quest 3 模型：使用文件名
      customModelParts[0].name = fileName;
      customModelParts[0].mesh.userData = { name: fileName };
      customModelParts[0].mesh.name = fileName;
    }

    // 统一收尾：隐藏默认模型、生成步骤、适配相机、回到合体
    finalizeCustomModelLoad(fileName, { modelType: "STL", adjustExplode: false });
    showStatus(
      "✅ STL 模型加载完成（单部件）\n💡 提示: 启动 Blender 后端可获得自动拆解",
      "success"
    );

    console.log(`✅ STL 模型加载完成：${fileName}`);
  } catch (err) {
    console.error("STL 加载错误:", err);
    showStatus(`❌ STL 加载失败: ${err.message}`, "error");
  }
}

/**
 * 解析并加载 URDF 模型（按 link 生成部件，Quest 3 模型按 15 部位聚类合并）
 * @param {string} urdfText
 * @param {string} fileName
 * @param {LoaderDeps} deps
 */
export async function loadURDFModel(urdfText, fileName, deps) {
  const {
    showStatus,
    clearCustomModelGroup,
    finalizeCustomModelLoad,
    customModelGroup,
    customModelParts,
  } = deps;
  try {
    showStatus("🔍 正在解析 URDF 结构...", "info");

    // 解析 URDF XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(urdfText, "text/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      throw new Error("URDF XML 解析错误");
    }

    // 提取所有 links
    const linkEls = doc.querySelectorAll("link");
    if (linkEls.length === 0) {
      throw new Error("URDF 中未找到任何 link");
    }

    // 提取所有 joints（建立父子关系）
    const jointEls = doc.querySelectorAll("joint");
    const jointMap = {}; // child_link_name -> joint info
    jointEls.forEach(joint => {
      const jointType = joint.getAttribute("type") || "fixed";
      const parent = joint.querySelector("parent")?.getAttribute("link");
      const child = joint.querySelector("child")?.getAttribute("link");
      const origin = joint.querySelector("origin");
      const originXYZ = origin?.getAttribute("xyz")?.trim().split(/\s+/).map(parseFloat) || [
        0, 0, 0,
      ];
      const originRPY = origin?.getAttribute("rpy")?.trim().split(/\s+/).map(parseFloat) || [
        0, 0, 0,
      ];
      const jointName = joint.getAttribute("name") || "joint";
      if (child) {
        jointMap[child] = {
          parent,
          child,
          type: jointType,
          xyz: originXYZ,
          rpy: originRPY,
          name: jointName,
        };
      }
    });

    // ── 辅助函数：从 xyz + rpy 构建 4×4 变换矩阵 ──
    function makeTransform(xyz, rpy) {
      const m = new Matrix4();
      const pos = new Vector3(xyz[0], xyz[1], xyz[2]);
      const euler = new Euler(rpy[0], rpy[1], rpy[2], "ZYX");
      const quat = new Quaternion().setFromEuler(euler);
      m.compose(pos, quat, new Vector3(1, 1, 1));
      return m;
    }

    // ── 递归计算每个 link 的世界变换矩阵 ──
    const linkWorldMatrix = {};
    function computeLinkWorldMatrix(linkName) {
      if (linkWorldMatrix[linkName]) return linkWorldMatrix[linkName];
      if (!jointMap[linkName]) {
        linkWorldMatrix[linkName] = new Matrix4();
        return linkWorldMatrix[linkName];
      }
      const joint = jointMap[linkName];
      const parentWorld = computeLinkWorldMatrix(joint.parent);
      const jointTransform = makeTransform(joint.xyz, joint.rpy);
      const world = new Matrix4().multiplyMatrices(parentWorld, jointTransform);
      linkWorldMatrix[linkName] = world;
      return world;
    }

    // 预计算所有 link 的世界变换
    linkEls.forEach(linkEl => {
      const name = linkEl.getAttribute("name");
      if (name) computeLinkWorldMatrix(name);
    });

    // 清除之前的自定义模型
    clearCustomModelGroup();

    // ── 为每个 link 创建 mesh，变换烘焙到几何体 ──
    const splitParts = [];
    let partIndex = 0;

    linkEls.forEach(linkEl => {
      const linkName = linkEl.getAttribute("name") || `link_${partIndex}`;

      // 获取 visual geometry 信息
      const visual = linkEl.querySelector("visual");
      const geometryEl = visual?.querySelector("geometry");
      const meshEl = geometryEl?.querySelector("mesh");
      const meshFile = meshEl?.getAttribute("filename") || "";

      // 获取 visual origin
      const visOrigin = visual?.querySelector("origin");
      const visXYZ = visOrigin?.getAttribute("xyz")?.trim().split(/\s+/).map(parseFloat) || [
        0, 0, 0,
      ];
      const visRPY = visOrigin?.getAttribute("rpy")?.trim().split(/\s+/).map(parseFloat) || [
        0, 0, 0,
      ];

      // 获取 box/cylinder/sphere 尺寸
      const boxEl = geometryEl?.querySelector("box");
      const cylEl = geometryEl?.querySelector("cylinder");
      const sphereEl = geometryEl?.querySelector("sphere");

      // 创建几何体
      let geometry;
      if (boxEl) {
        const size = boxEl.getAttribute("size")?.trim().split(/\s+/).map(parseFloat) || [
          0.1, 0.1, 0.1,
        ];
        geometry = new BoxGeometry(size[0] || 0.1, size[1] || 0.1, size[2] || 0.1);
      } else if (cylEl) {
        const radius = parseFloat(cylEl.getAttribute("radius")) || 0.05;
        const length = parseFloat(cylEl.getAttribute("length")) || 0.1;
        geometry = new CylinderGeometry(radius, radius, length, 32);
        geometry.rotateX(Math.PI / 2); // URDF 圆柱沿 Z 轴
      } else if (sphereEl) {
        const radius = parseFloat(sphereEl.getAttribute("radius")) || 0.05;
        geometry = new SphereGeometry(radius, 32, 24);
      } else {
        geometry = new BoxGeometry(0.08, 0.08, 0.08);
      }

      // 计算 visual 的世界变换矩阵 = link世界 × visual origin
      const linkWorld = linkWorldMatrix[linkName] || new Matrix4();
      const visLocal = makeTransform(visXYZ, visRPY);
      const visWorld = new Matrix4().multiplyMatrices(linkWorld, visLocal);

      // 烘焙世界变换到几何体（与 GLB 一致）
      geometry.applyMatrix4(visWorld);

      // 创建材质
      const hue = (partIndex * 137.5) % 360;
      const color = new Color().setHSL(hue / 360, 0.6, 0.5);
      const material = new MeshStandardMaterial({
        color,
        metalness: 0.3,
        roughness: 0.6,
      });

      // mesh 归零（变换已烘焙到几何体）
      const mesh = new Mesh(geometry, material);
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = linkName;
      mesh.userData = { name: linkName, isURDF: true, meshFile };

      splitParts.push({ mesh, name: linkName, isOriginal: true });
      partIndex++;
    });

    // ========== 计算模型中心，将几何体居中 ==========
    const modelBox = new Box3();
    for (const part of splitParts) {
      const partBox = new Box3().setFromObject(part.mesh);
      modelBox.union(partBox);
    }
    const modelCenter = modelBox.getCenter(new Vector3());

    for (const part of splitParts) {
      part.mesh.geometry.translate(-modelCenter.x, -modelCenter.y, -modelCenter.z);
    }

    // ========== Quest 3 模型：按 15 部位聚类合并 ==========
    const isQ3URDF = isQuest3Model(fileName);
    if (isQ3URDF && splitParts.length > 15) {
      showStatus("🔧 Quest 3 模型：按 15 部位聚类合并...", "info");
      const merged = mergePartsToQuest3(splitParts, modelBox);
      splitParts.length = 0;
      splitParts.push(...merged);
      console.log(`✅ Quest 3 URDF 合并完成：${splitParts.length} 个部件`);
    }

    // ========== 创建部件数据 ==========
    for (let i = 0; i < splitParts.length; i++) {
      const mesh = splitParts[i].mesh;

      // 计算部件中心（相对于模型中心，即原点）
      const partBox = new Box3().setFromObject(mesh);
      const partCenter = partBox.getCenter(new Vector3());

      // 爆炸方向：从模型中心指向部件中心
      const explodePos = calculateExplodePos(partCenter, i, splitParts.length);

      customModelParts.push({
        mesh,
        homePos: new Vector3(0, 0, 0),
        explodePos,
        homeRot: new Euler(0, 0, 0),
        explodeRot: new Euler(0, 0, 0),
        name: splitParts[i].name,
        partCenter: partCenter.clone(),
        stepIndex: 1,
      });

      customModelGroup.add(mesh);
    }

    // ========== 按距离中心排序（外层先拆）==========
    customModelParts.sort((a, b) => b.partCenter.length() - a.partCenter.length());

    // ========== 分配步骤索引 ==========
    const partCount = customModelParts.length;
    const groupCount = Math.min(Math.max(Math.ceil(partCount / 3), 2), 6);
    const partsPerGroup = Math.ceil(partCount / groupCount);

    // 重新计算包围盒（已居中）
    const centeredBoxURDF = new Box3();
    for (const part of customModelParts) {
      centeredBoxURDF.union(new Box3().setFromObject(part.mesh));
    }

    // ========== 命名 ==========
    if (isQ3URDF) {
      // Quest 3 模型：使用 Quest 3 原始 15 部位名称
      const quest3NamesURDF = assignQuest3PartNames(customModelParts, centeredBoxURDF);
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        part.name = quest3NamesURDF[i];
        part.mesh.userData = { name: part.name, isURDF: true };
        part.mesh.name = part.name;
      });
    } else {
      // 非 Quest 3 模型：使用 URDF link 原始名称
      customModelParts.forEach((part, i) => {
        part.stepIndex = Math.min(Math.floor(i / partsPerGroup) + 1, groupCount);
        part.mesh.userData = { name: part.name, isURDF: true };
        part.mesh.name = part.name;
      });
    }

    // 统一收尾：隐藏默认模型、生成步骤、适配相机、回到合体
    finalizeCustomModelLoad(fileName, { modelType: "URDF", adjustExplode: true });

    const meshNote =
      partCount > 0 && splitParts[0]?.mesh?.userData?.meshFile
        ? `\n⚠️ 注意: URDF 引用的 mesh 文件 (${splitParts[0].mesh.userData.meshFile}) 需单独上传\n当前使用占位几何体`
        : "";
    showStatus(`✅ URDF 解析完成：${partCount} 个 link（部件）${meshNote}`, "success");

    console.log(`✅ URDF 模型加载完成：${partCount} 个部件`);
  } catch (err) {
    console.error("URDF 加载错误:", err);
    showStatus(`❌ URDF 解析失败: ${err.message}`, "error");
  }
}
