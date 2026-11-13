# 空文件清理归档 2026-11-14

以下文件为 0 字节且全仓无引用（含构建入口、CopyPlugin、测试、服务端路由），从 git 跟踪中移除，原件保留在本目录供恢复。

- `model-viewer.html`（0 字节）
- `vendor/three-mesh-bvh/core/build/sortUtils.js`（0 字节）

## 取证

- `model-viewer.html`：0 字节；webpack 只以 `./index.html` 为模板，CopyPlugin 不复制它；无任何代码/路由/测试引用（rg 全仓 0 命中）。
- `vendor/three-mesh-bvh/core/build/sortUtils.js`：0 字节；同目录真实实现为 `sortUtils.generated.js` 与 `sortUtils_indirect.generated.js`，`buildTree.js` 只 import 这两个 `.generated.js`，空文件是上游打包产物残留。
