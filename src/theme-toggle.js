// 主题切换（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「主题切换」块：#theme-toggle 按钮 + .ui-overlay 亮/暗主题。
// 初值读 localStorage("quest3-theme")；点击切换 light-theme 类、回写存储、
// 更新按钮图标（☀️/🌙）并放一段 300ms 旋转动画。任一元素缺失时静默跳过。
// uiOverlay 由 main.js 传入：createARPreview 等主模块逻辑共用同一引用。
export function setupThemeToggle({ uiOverlay }) {
  const themeToggle = document.getElementById("theme-toggle");

  if (themeToggle && uiOverlay) {
    // 检查本地存储的主题设置
    const savedTheme = localStorage.getItem("quest3-theme");
    if (savedTheme === "light") {
      uiOverlay.classList.add("light-theme");
      themeToggle.textContent = "☀️";
    }

    themeToggle.addEventListener("click", () => {
      uiOverlay.classList.toggle("light-theme");
      const isLight = uiOverlay.classList.contains("light-theme");

      // 保存主题设置
      localStorage.setItem("quest3-theme", isLight ? "light" : "dark");

      // 更新按钮图标
      themeToggle.textContent = isLight ? "☀️" : "🌙";

      // 添加切换动画
      themeToggle.style.transform = "rotate(360deg) scale(1.2)";
      setTimeout(() => {
        themeToggle.style.transform = "";
      }, 300);
    });
  }
}
