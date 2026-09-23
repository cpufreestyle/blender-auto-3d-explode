/**
 * WebXR AR 预览（从 main.js 抽取，行为不变）。
 *
 * 原 main.js 底部的 AR 块：8 个模块级 ar* 状态 + 检测/按钮/会话启停/初始化 5 个函数，
 * 外加 DOMContentLoaded 引导。AR 全程只与主场景「共享几何体/材质」地克隆模型，不 dispose，
 * 因此对主模块的依赖收敛为 7 个常量引用（container / uiOverlay / questGroup / parts /
 * controls / renderer / camera，均为 const、不会重赋值）与 three 的 5 个类。
 *
 * 这里用工厂函数 createARPreview(deps) 收拢：ar* 状态从模块级变为闭包状态，
 * deps 以参数注入，主模块只保留「页面加载后检测 AR」的引导代码。
 */

import {
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";

export function createARPreview({ container, uiOverlay, questGroup, parts, controls, renderer, camera }) {
  // ===== WebXR AR 预览 =====
  let arSession = null;
  let arButton = null;
  let arSupported = false;
  let arHitTestSource = null;
  let arModelPlaced = false;
  let arEnding = false; // 防止 onAREnd 重入
  let arRenderer = null; // AR 专用渲染器（结束时释放 WebGL 上下文）
  let arScene = null; // AR 独立场景
  let arQuestGroup = null; // 模型的 AR 克隆（几何体/材质与主场景共享，禁止 dispose）

  // 检测 WebXR AR 支持
  async function checkARSupport() {
    if (!("xr" in navigator)) {
      console.log("WebXR not supported");
      return false;
    }

    try {
      const isSupported = await navigator.xr.isSessionSupported("immersive-ar");
      arSupported = isSupported;
      console.log("WebXR AR supported:", isSupported);
      return isSupported;
    } catch (err) {
      console.error("Error checking AR support:", err);
      return false;
    }
  }

  // 显示/隐藏 AR 按钮
  function updateARButton() {
    if (arButton) {
      if (arSupported && !arSession) {
        arButton.style.display = "inline-block";
        arButton.disabled = false;
        arButton.title = "在 AR 中预览 Quest 3";
      } else {
        arButton.style.display = "none";
      }
    }
  }

  // 启动 AR 会话
  async function startAR() {
    if (!arSupported) {
      alert(
        "您的设备不支持 AR 功能\n\n支持的设备：\n- Android Chrome\n- iOS Safari 15+\n\n请确保使用 HTTPS 访问。",
      );
      return;
    }

    try {
      // 请求 AR 会话
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test", "local-floor"],
        optionalFeatures: ["dom-overlay", "light-estimation"],
        domOverlay: { root: document.body },
      });

      arSession = session;

      // 更新按钮状态
      if (arButton) {
        arButton.textContent = "🚪 退出 AR";
        arButton.classList.add("active");
      }

      // 隐藏 UI 面板
      if (uiOverlay) {
        uiOverlay.style.display = "none";
      }

      // 设置 AR 渲染器
      arRenderer = new WebGLRenderer({
        antialias: true,
        alpha: true,
        logarithmicDepthBuffer: true,
      });
      arRenderer.setPixelRatio(window.devicePixelRatio);
      arRenderer.setSize(window.innerWidth, window.innerHeight);
      arRenderer.xr.enabled = true;
      arRenderer.xr.setReferenceSpaceType("local-floor");

      // 替换画布：移除原有 canvas，添加 AR 渲染器的 canvas
      container.innerHTML = "";
      container.appendChild(arRenderer.domElement);

      // 创建 AR 场景
      arScene = new Scene();

      // 添加灯光
      const arAmbientLight = new AmbientLight(0xffffff, 0.6);
      arScene.add(arAmbientLight);
      const arDirLight = new DirectionalLight(0xffffff, 0.8);
      arDirLight.position.set(5, 10, 7);
      arScene.add(arDirLight);

      // 创建 Quest 3 模型的 AR 副本（clone 共享几何体/材质，结束时不可 dispose）
      arQuestGroup = questGroup.clone();
      arScene.add(arQuestGroup);

      // 调整 AR 中的模型大小
      arQuestGroup.scale.set(0.1, 0.1, 0.1);

      // 设置 AR 相机
      const arCamera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

      // 启用 hit-test：先设置 session，再初始化 hit-test source
      session.addEventListener("end", onAREnd);
      await arRenderer.xr.setSession(session);

      // 初始化 hit-test source（之前缺失，导致 getHitTestResults 始终失败）
      try {
        const viewerSpace = await session.requestReferenceSpace("viewer");
        arHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      } catch (err) {
        console.warn("Hit-test source 初始化失败，模型将放置在默认位置:", err);
      }

      // 从 AR 克隆中收集部件引用（避免修改原始场景的 mesh）
      const arParts = [];
      const cloneMeshMap = new Map();
      arQuestGroup.traverse(child => {
        if (child.isMesh && child.userData.name) {
          cloneMeshMap.set(child.userData.name, child);
        }
      });
      parts.forEach(part => {
        const clonedMesh = cloneMeshMap.get(part.name);
        if (clonedMesh) {
          arParts.push({
            mesh: clonedMesh,
            homePos: part.homePos,
            explodePos: part.explodePos,
            name: part.name,
          });
        }
      });

      // AR 渲染循环
      arRenderer.setAnimationLoop((timestamp, frame) => {
        if (frame) {
          // 获取参考空间
          const referenceSpace = arRenderer.xr.getReferenceSpace();

          // 获取 viewer 空间
          const viewerPose = frame.getViewerPose(referenceSpace);

          if (viewerPose) {
            // 更新相机
            const view = viewerPose.views[0];
            arCamera.projectionMatrix.fromArray(view.projectionMatrix);
            arCamera.matrix.fromArray(view.transform.matrix);
            arCamera.matrixWorldNeedsUpdate = true;

            // 如果模型未放置，执行 hit-test
            if (!arModelPlaced && arHitTestSource && frame.getHitTestResults) {
              const hitTestResults = frame.getHitTestResults(arHitTestSource);

              if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const hitPose = hit.getPose(referenceSpace);

                if (hitPose) {
                  arModelPlaced = true;

                  // 放置模型
                  arQuestGroup.position.setFromMatrixPosition(hitPose.transform);
                  arQuestGroup.quaternion.setFromRotationMatrix(hitPose.transform);
                }
              }
            }

            // 如果模型已放置，添加简单的爆炸效果（使用 AR 克隆的部件）
            if (arModelPlaced) {
              const time = timestamp * 0.001;
              const explodeFactor = (Math.sin(time * 0.5) + 1) * 0.3;

              // 应用爆炸变换到 AR 克隆的部件（而非原始场景的部件）
              arParts.forEach((part, index) => {
                const delay = index * 0.05;
                const factor = Math.max(0, Math.min(1, (explodeFactor - delay) * 2));

                part.mesh.position.lerpVectors(part.homePos, part.explodePos, factor * 0.5);
              });
            }

            // 自动旋转
            if (controls.autoRotate && arModelPlaced) {
              arQuestGroup.rotation.y += 0.005;
            }
          }

          arRenderer.render(arScene, arCamera);
        }
      });

      console.log("AR session started");
    } catch (err) {
      console.error("Failed to start AR:", err);
      alert(
        "启动 AR 失败：" +
          err.message +
          "\n\n请确保：\n1. 使用 HTTPS\n2. 设备支持 AR\n3. 授予相机权限",
      );
      onAREnd();
    }
  }

  // 结束 AR 会话
  function onAREnd() {
    // 防止重入（'end' 事件可能在此函数执行过程中触发）
    if (arEnding) return;
    arEnding = true;

    try {
      if (arHitTestSource) {
        arHitTestSource.cancel();
        arHitTestSource = null;
      }
      if (arSession) {
        arSession.end();
        arSession = null;
      }
      arModelPlaced = false;
    } catch (err) {
      console.error("结束 AR 会话时出错:", err);
    }

    // 释放 AR 专用渲染资源（几何体/材质与主场景共享，此处只释放 WebGL 上下文）
    if (arRenderer) {
      arRenderer.setAnimationLoop(null);
      arRenderer.dispose();
      arRenderer.forceContextLoss();
      arRenderer.domElement?.remove();
      arRenderer = null;
    }
    arScene = null;
    arQuestGroup = null;

    // 恢复主渲染器画布（renderer 从未销毁，直接重新挂载即可，无需整页刷新）
    container.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    // 恢复 UI
    if (uiOverlay) uiOverlay.style.display = "";
    if (arButton) {
      arButton.textContent = "📱 AR 预览";
      arButton.classList.remove("active");
    }
    updateARButton();

    // 'end' 事件稍后会再次触发本函数，此时各资源已置空，幂等无副作用
    arEnding = false;
  }

  // 初始化 AR
  async function initAR() {
    const supported = await checkARSupport();

    if (supported) {
      arButton = document.getElementById("ar-btn");
      if (arButton) {
        // 绑定 AR 按钮事件（之前在模块顶层绑定，但此时 arButton 尚为 null，导致事件从未绑定）
        arButton.addEventListener("click", () => {
          if (arSession) {
            onAREnd();
          } else {
            startAR();
          }
        });
      }
      updateARButton();
    }
  }
  return { initAR };
}
