// 乐高 / 原生 外观切换按钮（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「乐高 / 原生 外观切换」块：#style-toggle 按钮。初值读
// localStorage("quest3-model-style")（缺省 "native"）；切换时调用注入的
// applyModelStyle（src/model-style.js 工厂实例）、回写存储、更新按钮文案
// 与 lego 类，并放一段 300ms 旋转动画。按钮缺失时静默跳过。
export function setupStyleToggle({ applyModelStyle }) {
  const styleToggle = document.getElementById("style-toggle");

  if (styleToggle) {
    let modelStyle = localStorage.getItem("quest3-model-style") || "native";
    applyModelStyle(modelStyle);
    styleToggle.textContent = modelStyle === "lego" ? "🧱 乐高风格" : "🛠️ 原生风格";
    styleToggle.classList.toggle("lego", modelStyle === "lego");

    styleToggle.addEventListener("click", () => {
      modelStyle = modelStyle === "lego" ? "native" : "lego";
      applyModelStyle(modelStyle);
      localStorage.setItem("quest3-model-style", modelStyle);
      styleToggle.textContent = modelStyle === "lego" ? "🧱 乐高风格" : "🛠️ 原生风格";
      styleToggle.classList.toggle("lego", modelStyle === "lego");
      styleToggle.style.transform = "rotate(360deg) scale(1.05)";
      setTimeout(() => {
        styleToggle.style.transform = "";
      }, 300);
    });
  }
}
