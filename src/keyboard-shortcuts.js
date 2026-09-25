// 键盘快捷键（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「键盘快捷键」块：document keydown 分发（输入框内忽略）——
// →/← 相对当前步进、空格 爆炸/合体、r 复位、a 自动旋转（同步 checkbox 与
// controls）、f 聚焦当前部件、h 收起/展开侧栏、s 截图；另挂 autoRotateCheck
// 的 change 回写 controls.autoRotate。explodeCtl / controls / autoRotateCheck / exportPanel
// 均为稳定 const 引用直接传入；displayedStep 是会重赋值的 let，经
// getDisplayedStep() 惰性读取（与原文件闭包语义一致）。
export function setupKeyboardShortcuts({
  explodeCtl,
  controls,
  autoRotateCheck,
  exportPanel,
  getDisplayedStep,
  toggleSidebar,
}) {
  document.addEventListener("keydown", e => {
    // 忽略在输入框中的按键
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        explodeCtl.goToStep(getDisplayedStep() + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        explodeCtl.goToStep(getDisplayedStep() - 1);
        break;
      case " ":
        e.preventDefault();
        explodeCtl.toggleExplode();
        break;
      case "r":
      case "R":
        e.preventDefault();
        explodeCtl.goToStep(0);
        break;
      case "a":
      case "A":
        e.preventDefault();
        autoRotateCheck.checked = !autoRotateCheck.checked;
        controls.autoRotate = autoRotateCheck.checked;
        break;
      case "f":
      case "F":
        e.preventDefault();
        explodeCtl.focusCurrentPart();
        break;
      case "h":
      case "H":
        e.preventDefault();
        if (typeof toggleSidebar === "function") toggleSidebar();
        break;
      case "s":
      case "S":
        e.preventDefault();
        exportPanel.exportScreenshot();
        break;
    }
  });

  autoRotateCheck.addEventListener("change", e => {
    controls.autoRotate = e.target.checked;
  });
}
