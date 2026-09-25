// 图片上传校验（从 src/panels/ai-paint-panel.js 的 handleImageFile 提取）
// 纯函数、零依赖，因此可以在 Node 里被直接单测——提出去之前这两条判断内联在
// setupAIPaint 的闭包里，只能把整个面板起在浏览器里才能验到。

/**
 * 校验上传的文件能不能当图片用。
 *
 * 判定顺序固定为「先类型、后体积」：一个又不是图片、又超大的文件拿到的是类型
 * 文案，用户据此知道问题在类型而不在体积。
 *
 * @param {File} file 用户选中或拖放的文件
 * @returns {string|null} 不合法时返回错误文案（调用方原样显示出去），合法时
 *   返回 null
 */
export function validateImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    return "❌ 请上传图片文件";
  }

  if (file.size > 10 * 1024 * 1024) {
    return "❌ 图片不能超过 10MB";
  }

  return null;
}
