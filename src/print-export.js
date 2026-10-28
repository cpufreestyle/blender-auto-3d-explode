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

import { Box3, Mesh, Vector3 } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

// 场景单位 -> 毫米。与 print-analyze.js 的默认值保持一致：Blender/GLTF
// 默认 1 单位 = 1 米，而打印要毫米。STLExporter 按场景单位输出，所以
// 缩放必须在这里做，切片软件不会替我们猜。
export const DEFAULT_SCALE_TO_MM = 1000;

/**
 * 把单个部件导出成二进制 STL。
 *
 * @param {Object} part { mesh: THREE.Mesh, name?: string, index?: number }
 * @param {Object} [options]
 * @param {Function} [options.STLExporterClass] 测试缝：默认 three 的 STLExporter
 * @param {number} [options.scaleToMm] 场景单位 -> 毫米（默认 1000）
 * @param {boolean} [options.rotateToZUp] 是否旋转到构建板朝向（默认 true）
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
  const clone = mesh.clone();
  clone.name = name;

  if (rotate) {
    // three/GLTF Y-up -> 打印 Z-up：绕 X 转 -90°，+Y 落到 +Z。
    // 用 rotation 而不是 matrix 逐项改写，clone 的 matrixAutoUpdate 保持默认。
    clone.rotation.x = -Math.PI / 2;
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

/**
 * 整模型导出：逐部件 STL。
 *
 * @param {Array<Object>} parts [{ mesh, name, index }]
 * @param {Object} [options] 同 exportPartSTL
 * @returns {Array<Object>} 导出结果数组（无效部件被跳过）
 */
export function exportModelSTL(parts, options = {}) {
  if (!Array.isArray(parts)) return [];
  return parts
    .map(p => exportPartSTL(p, options))
    .filter(Boolean);
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
