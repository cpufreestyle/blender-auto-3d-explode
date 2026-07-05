# 🎉 Quest 3 爆炸拆解 3D 视图 - v1.5.0 发布说明

**发布日期**：2026-07-05
**版本**：v1.5.0
**主题**：AR 功能与自定义模型 Bug 修复

---

## 📋 版本概述

v1.5.0 是一个**Bug 修复版本**，重点修复了 WebXR AR 预览功能和自定义模型加载中的多个严重问题。本次更新解决了 AR 按钮无法点击、模型无法放置、AR 渲染污染原始场景、自定义模型双重缩放等 7 个 Bug，显著提升了 AR 体验的可用性和自定义模型的准确性。

---

## 🐛 Bug 修复

### 🔴 严重修复（3 个）

#### 1. AR 按钮点击事件从未绑定

**文件**：`main.js`

**问题**：
AR 按钮的事件监听器在模块顶层通过 `if (arButton)` 判断绑定，但此时 `arButton` 为 `null`（因为 `initAR()` 是异步函数，尚未执行完成），导致条件判断为 false，事件监听器从未绑定。**AR 按钮完全无法点击。**

**修复**：
将事件绑定移入 `initAR()` 函数中，在 `arButton = document.getElementById('ar-btn')` 赋值之后立即绑定点击事件。

```javascript
// 修复前（模块顶层，arButton 为 null）
if (arButton) {
  arButton.addEventListener('click', ...);
}

// 修复后（在 initAR 内部，arButton 已赋值）
async function initAR() {
  const supported = await checkARSupport();
  if (supported) {
    arButton = document.getElementById('ar-btn');
    if (arButton) {
      arButton.addEventListener('click', () => { ... });
    }
    updateARButton();
  }
}
```

---

#### 2. AR hit-test source 从未初始化

**文件**：`main.js`

**问题**：
`arHitTestSource` 声明为 `null` 后从未通过 `session.requestHitTestSource()` 初始化。导致渲染循环中 `frame.getHitTestResults(null)` 始终失败，**AR 模型永远无法放置到真实表面**。

**修复**：
在 `arRenderer.xr.setSession(session)` 之后，正确初始化 hit-test source：

```javascript
// 初始化 hit-test source
const viewerSpace = await session.requestReferenceSpace('viewer');
arHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
```

同时在渲染循环中添加 null 检查：`if (arHitTestSource && frame.getHitTestResults)`。

---

#### 3. AR 渲染循环修改了原始场景的 mesh

**文件**：`main.js`

**问题**：
AR 中通过 `questGroup.clone()` 创建了克隆模型，但渲染循环中使用 `parts.forEach(...)` 修改的是**原始场景**的 mesh 引用，而非克隆的 mesh。导致：
- AR 爆炸动画无效（修改了不可见的原始 mesh）
- **污染了原始 3D 场景**（退出 AR 后原始模型位置错乱）

**修复**：
通过遍历 `arQuestGroup` 建立 `cloneMeshMap`，创建 `arParts` 数组引用克隆的 mesh，在 AR 渲染循环中使用 `arParts` 而非 `parts`：

```javascript
const arParts = [];
const cloneMeshMap = new Map();
arQuestGroup.traverse((child) => {
  if (child.isMesh && child.userData.name) {
    cloneMeshMap.set(child.userData.name, child);
  }
});
parts.forEach((part) => {
  const clonedMesh = cloneMeshMap.get(part.name);
  if (clonedMesh) {
    arParts.push({ mesh: clonedMesh, homePos: part.homePos, explodePos: part.explodePos, name: part.name });
  }
});
```

---

### 🟡 中等修复（4 个）

#### 4. renderer.domElement 无效赋值 + 未使用变量

**文件**：`main.js`

**问题**：
`renderer.domElement = arRenderer.domElement` 无法实际改变 WebGL 渲染目标（该属性在构造时固定），是无意义的赋值。同时 `canvas`、`sessionSpace`、`arHitMatrix` 变量声明后未使用。

**修复**：
移除无效赋值行和所有未使用变量，清理代码。

---

#### 5. 渲染循环中的 console.log 性能问题

**文件**：`main.js`

**问题**：
`updateExplodedView()` 每帧执行（约 60 FPS），其中包含 2 处 `console.log`（含对象序列化）。加载自定义模型后每帧都输出大量日志，**严重拖慢渲染性能**。

**修复**：
移除渲染循环中的所有调试日志。

---

#### 6. onAREnd 潜在递归与未捕获异常

**文件**：`main.js`

**问题**：
session 的 `end` 事件监听器调用 `onAREnd()`，而 `onAREnd()` 内部又调用 `arSession.end()`，可能导致重入。调用已结束 session 的 `end()` 可能抛异常。

**修复**：
- 添加 `arEnding` 防重入标志
- 用 `try-catch` 包裹清理逻辑
- 正确取消 hit-test source：`arHitTestSource.cancel()`

---

#### 7. 自定义模型 autoScale 双重缩放

**文件**：`main.js`

**问题**：
`homePos` 被手动 `multiplyScalar(autoScale)` 缩放，而 `customModelGroup.scale` 又缩放了所有子节点位置，导致位置被双重缩放（实际缩放 \( autoScale^2 \) 倍）。`explodePos` 重计算时也未除以组缩放因子，导致爆炸距离异常。

**修复**：
- 移除手动缩放 `homePos` 的循环（组缩放已自动处理子节点位置）
- 在重计算 `explodePos` 时将 `smartDist` 除以 `groupScale` 转换为局部空间距离

---

## 📊 统计

```
Bug 修复: 7 个
  - 严重: 3 个（AR 按钮事件、hit-test 初始化、AR 渲染污染）
  - 中等: 4 个（无效赋值、性能日志、AR 递归、双重缩放）
代码变更: +69/-54 行
影响文件: 1 个（main.js）
```

---

## 🎯 升级指南

### 从 v1.4.0 升级

```bash
git pull origin main
```

无需安装新依赖，直接使用即可。

---

## 🔗 相关链接

- **GitHub 仓库**：https://github.com/cpufreestyle/quest3-exploded
- **问题反馈**：https://github.com/cpufreestyle/quest3-exploded/issues
- **完整变更日志**：[CHANGELOG.md](CHANGELOG.md)

---

**🎉 感谢使用 Quest 3 爆炸拆解 3D 视图 v1.5.0！**
