// 授课模式：投影 / 讲台上只留 3D 视图与教学控件，把 AI 生成、上传、配置入口整块收起。
//
// 借鉴 driver.js（26.9k★ MIT）「只留当前焦点」的思路：导览时把注意力收到一件事上。
// 区别是这里收的是整节课的注意力——焦点不是某个按钮，而是模型本身。
// 同理可参考 intro.js 的单向引导：学生机打开链接时最怕 zh 满屏生成面板，
// 收起后首屏就是「步骤 3/7：取下前面板」，认知成本最低。
//
// 收起手段复用仓库既有的 .hidden（style.css:644，display:none !important），
// 不新增 CSS：每个目标元素只是加/减一个类，退出时逐个还原，可逆且可测。

export const TEACHING_HIDE_SELECTORS = [
  "#ai-paint-panel",
  "#upload-panel",
  "#open-config-btn",
  "#blender-banner",
  ".hint",
];
export const TEACHING_STORAGE_KEY = "quest3-teaching-mode";
export const TEACHING_BODY_CLASS = "teaching-mode";

/**
 * 建立授课模式开关。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.btn 开关按钮；缺省时仍会按存储值恢复状态
 * @param {string[]} deps.hideSelectors 授课时要收起的选择器
 * @param {Storage} deps.storage 记忆载体（localStorage；测试可注入假实现）
 * @param {string} deps.storageKey 存储键
 */
export function setupTeachingMode({
  btn = null,
  hideSelectors = TEACHING_HIDE_SELECTORS,
  storage = null,
  storageKey = TEACHING_STORAGE_KEY,
} = {}) {
  let enabled = false;

  function readStored() {
    try {
      return storage ? storage.getItem(storageKey) === "1" : false;
    } catch (e) {
      return false; // 隐私模式 / 配额满：不记忆，但不该因此崩
    }
  }

  function writeStored() {
    try {
      if (storage) storage.setItem(storageKey, enabled ? "1" : "0");
    } catch (e) {
      /* 同上：记不住就算了 */
    }
  }

  function paintBtn() {
    if (!btn) return;
    btn.classList.toggle("active", enabled);
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
    btn.textContent = enabled ? "🎓 退出授课" : "🎓 授课模式";
    btn.title = enabled
      ? "退出授课模式，显示 AI 生成 / 上传等全部面板（T）"
      : "授课模式：只留 3D 视图与教学控件（T）";
  }

  // 收起前的原状。#blender-banner 常态就是 .hidden（未检测到 Blender 时也不显示），
  // 一刀切地减类会把它「还」出来，所以收起前先记住原状，还原时按原状决定去不去类。
  const preHidden = new Map();

  // direction: 1 收起 / 0 还原。两个方向都遍历全部目标，避免只收不还漏掉后来新加的面板。
  function applyHidden(direction) {
    for (const selector of hideSelectors) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(selector);
      } catch (e) {
        continue; // 选择器写错时不该让整个开关失灵
      }
      for (const el of nodes) {
        if (direction === 1) {
          if (!preHidden.has(el)) preHidden.set(el, el.classList.contains("hidden"));
          el.classList.add("hidden");
        } else if (preHidden.get(el) === false) {
          el.classList.remove("hidden");
        }
      }
    }
    if (direction === 0) preHidden.clear();
  }

  function setEnabled(next) {
    enabled = !!next;
    applyHidden(enabled ? 1 : 0);
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle(TEACHING_BODY_CLASS, enabled);
    }
    paintBtn();
    writeStored();
    return enabled;
  }

  // 建站即按上次的状态恢复：老师在讲台上刷新页面不该又见到满屏生成面板
  setEnabled(readStored());

  if (btn) btn.addEventListener("click", () => setEnabled(!enabled));

  return {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    toggle: () => setEnabled(!enabled),
    isEnabled: () => enabled,
    hideSelectors,
    storageKey,
  };
}
