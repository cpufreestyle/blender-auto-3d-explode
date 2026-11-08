/**
 * AR 锚定助手（纯函数，与 ar-damper.js 同层的薄封装）。
 *
 * WebXR Anchors（immersive-ar 的 optionalFeatures "anchors"）：hit-test 放置后
 * 用 XRAnchor 把模型钉在真实表面上——参考空间重定位后 getPose(anchor.anchorSpace)
 * 会给出修正位姿，模型跟着锚走而不是留在过期的 local-floor 坐标里。
 *
 * 位姿提取用 Matrix4.fromArray + decompose：XR 的 transform.matrix 是 16 元
 * 列主序浮点数组（无 .elements），three 的 setFromMatrixPosition 只吃 Matrix4。
 *
 * 三层降级：浏览器不支持 createAnchor / 会话没启用 anchors / getPose 暂不可用，
 * 都返回 null，调用方保持 hit-test 放置的既有行为（不抛错、不白屏）。
 *
 * 测试：tests/ar-anchor-test.mjs（假 XR 对象真实驱动，无需真机）。
 */

import { Matrix4, Quaternion, Vector3 } from "three";

/** hit.createAnchor 是否可用（旧浏览器/未启用 anchors 时不存在） */
export function anchorSupported(hit) {
  return typeof hit?.createAnchor === "function";
}

/** 从 hit 创建锚；不支持时返回 null（不抛错）。返回 Promise<XRAnchor>。 */
export function createAnchorFromHit(hit) {
  if (!anchorSupported(hit)) return null;
  return hit.createAnchor();
}

// 复用临时矩阵，避免每帧分配
const _m = new Matrix4();

/**
 * 读取锚的当前位姿并分解出位置与旋转。
 * 返回 { position: Vector3, quaternion: Quaternion }，任何环节缺失返回 null。
 */
export function anchorGoalPose(frame, anchor, referenceSpace) {
  if (!anchor || !frame?.getPose) return null;
  if (!anchor.anchorSpace) return null;
  const pose = frame.getPose(anchor.anchorSpace, referenceSpace);
  const arr = pose?.transform?.matrix;
  if (!arr || arr.length < 16) return null;
  _m.fromArray(arr);
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  _m.decompose(position, quaternion, scale);
  return { position, quaternion };
}
