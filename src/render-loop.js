// 渲染循环与视口响应（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 尾部的「响应窗口大小」与「渲染循环」两块：
//   - resize：监听 window resize，按 window.innerWidth / innerHeight 重算
//     camera.aspect、updateProjectionMatrix 并 renderer.setSize。刻意不重设
//     pixelRatio——初值只在 createSceneSetup 里按低功耗/桌面设一次；
//   - animate：requestAnimationFrame 自递归。后台标签页直接 return：浏览器
//     虽已节流 rAF，这里再兜一层，省掉 updateExplodedView、粒子旋转与整帧
//     render；前台时先跑 explodeCtl.updateExplodedView(now)，再按可见性转
//     环境粒子（缓慢自转），最后 controls.update() 与 renderer.render；
//   - 进厂即 requestAnimationFrame(animate) 开跑。
//
// DI 接缝：camera / renderer / scene / controls / explodeCtl / particlesMesh
// 均为本模块早先创建的稳定 const 引用，直接传入；window / document /
// requestAnimationFrame 走全局（与 theme-toggle / keyboard-shortcuts 同一
// 约定，测试用 Object.defineProperty 装到 globalThis 上）。

export function createRenderLoop({
  camera,
  renderer,
  scene,
  controls,
  explodeCtl,
  particlesMesh,
}) {
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ===== 渲染循环 =====
  function animate(now) {
    requestAnimationFrame(animate);
    // 后台标签页不做任何计算与渲染（浏览器已节流 rAF，这里再兜一层）
    if (document.hidden) return;
    explodeCtl.updateExplodedView(now);

    // 粒子动画（缓慢旋转）— 仅在可见时更新
    if (particlesMesh && particlesMesh.visible) {
      particlesMesh.rotation.y = now * 0.00005;
      particlesMesh.rotation.x = now * 0.00003;
    }

    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}
