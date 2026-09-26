// 步骤描述淡入动画（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「步骤描述淡入动画」块：updateStepDescAnimation 与模块级
// lastStepDesc（上次展示过的文案）。文案发生变化时先把 animation 置 none、
// void 读 offsetHeight 触发重排，再设 fadeInUp 0.5s ease-out，使每次换
// 步骤都重新播放淡入；文案未变则什么都不做。stepDescEl 由 main.js 传入
// （与 stepUi 的解构同一引用），缺失时静默返回。
export function createStepDescAnimation({ stepDescEl }) {
  let lastStepDesc = "";
  function updateStepDescAnimation() {
    if (!stepDescEl) return;

    const currentDesc = stepDescEl.textContent;
    if (currentDesc !== lastStepDesc) {
      stepDescEl.style.animation = "none";
      // 触发重排
      void stepDescEl.offsetHeight;
      stepDescEl.style.animation = "fadeInUp 0.5s ease-out";
      lastStepDesc = currentDesc;
    }
  }
  return { updateStepDescAnimation };
}
