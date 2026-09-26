// 相机自动适配到模型（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的 fitCameraToModel：按模型整体包围盒计算目标点与相机距离
// （fov 正弦换算 + 0.8~20 夹取），保持当前观察方向，smooth 时经 requestAnimationFrame
// 做三次缓动过渡，否则直接落位；末尾打一条相机适配日志。
//
// 依赖注入：camera / controls 为 main.js 的稳定 const 引用，工厂创建时传入；
// requestAnimationFrame 用全局（浏览器环境；测试经 globalThis 打桩）。
import { Box3, Vector3 } from "three";

export function createCameraFitter({ camera, controls }) {
  function fitCameraToModel(modelGroup, smooth = true) {
    // 计算包围盒
    const box = new Box3().setFromObject(modelGroup);
    const center = box.getCenter(new Vector3());
    const size = new Vector3();
    box.getSize(size);

    // 计算最大尺寸
    const maxDim = Math.max(size.x, size.y, size.z);

    // 计算合适的相机距离（根据模型大小）
    const fov = camera.fov * (Math.PI / 180);
    let cameraDistance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5;

    // 设置最小/最大距离限制
    cameraDistance = Math.max(0.8, Math.min(cameraDistance, 20));

    // 设置相机目标位置
    const targetPos = new Vector3(center.x, center.y + size.y * 0.3, center.z);
    controls.target.copy(targetPos);

    // 计算新的相机位置（保持当前角度）
    const direction = new Vector3().subVectors(camera.position, controls.target).normalize();
    const newCameraPos = targetPos.clone().add(direction.multiplyScalar(cameraDistance));

    if (smooth) {
      // 平滑过渡
      const startPos = camera.position.clone();
      const startTarget = controls.target.clone();
      let progress = 0;

      function animateCamera() {
        progress += 0.03;
        if (progress >= 1) {
          camera.position.copy(newCameraPos);
          controls.target.copy(targetPos);
          return;
        }

        // 使用缓动函数
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        camera.position.lerpVectors(startPos, newCameraPos, easeProgress);
        controls.target.lerpVectors(startTarget, targetPos, easeProgress);

        requestAnimationFrame(animateCamera);
      }
      animateCamera();
    } else {
      camera.position.copy(newCameraPos);
      controls.target.copy(targetPos);
    }

    console.log("📐 相机适配:", {
      center: `(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`,
      size: `(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)})`,
      maxDim: maxDim.toFixed(2),
      cameraDistance: cameraDistance.toFixed(2),
    });
  }

  return { fitCameraToModel };
}
