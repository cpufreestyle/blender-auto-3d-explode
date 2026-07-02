# Quest 3 爆炸图 - 功能增强实施计划

**日期**：2026-06-22
**版本**：v2.0.0 Roadmap
**优先级**：P2 - 内容丰富

---

## 🎯 目标

### 1. 真实 Quest 3 模型替换
- 下载或创建高精度 Quest 3 3D 模型
- 替换当前简化版几何体
- 保持爆炸动画和交互功能

### 2. AR 预览模式
- 实现完整的 WebXR AR 功能
- 在真实环境中查看 Quest 3 模型
- 支持移动端 AR（Android/iOS）

---

## 📋 实施计划

### 阶段 1：真实 Quest 3 模型

#### 1.1 模型获取

**方案**：从 Sketchfab 或其他 3D 资源网站下载

**可能的来源**：
- Sketchfab（搜索 "Meta Quest 3"）
- CGTrader
- TurboSquid
- 官方 Meta 开发者资源

**格式要求**：
- ✅ GLB 或 GLTF（优先 GLB，更紧凑）
- ✅ 包含纹理贴图
- ✅ 合理的文件大小（< 10MB）

#### 1.2 模型预处理

**需要检查**：
- [ ] 模型是否需要简化（LOD）
- [ ] 爆炸方向是否需要手动调整
- [ ] 材质是否需要优化（减少 draw calls）
- [ ] 是否需要拆分 submesh 为独立部件

**预处理步骤**：
1. 下载模型
2. 检查模型结构（mesh 数量、材质）
3. 在 Blender 中调整：
   - 将模型居中到原点
   - 为每个部件标记名称
   - 可能需要拆分组装关系
4. 导出为优化的 GLB

#### 1.3 集成到项目

**实现方案**：
- 添加 `models/quest3-real.glb` 到项目
- 修改 `main.js`：
  - 添加默认加载真实模型的选项
  - 保留简化版作为 fallback
  - 自动检测爆炸点

**爆炸点计算**：
- 基于模型结构自动计算
- 或提供配置文件手动调整
- 保持与步骤系统兼容

---

### 阶段 2：AR 预览模式

#### 2.1 WebXR 检测

**检测逻辑**：
```javascript
if ('xr' in navigator) {
  const isSupported = await navigator.xr.isSessionSupported('immersive-ar');
}
```

**浏览器/设备支持**：
- ✅ Chrome Android（支持 WebXR）
- ✅ Safari iOS（支持 WebXR，部分功能）
- ⚠️ Chrome Desktop（不支持 AR，仅 VR）
- ❌ Firefox（部分支持）
- ❌ Safari Desktop（不支持）

#### 2.2 AR 会话管理

**核心功能**：
1. **启动 AR**
   - 点击 "AR 预览" 按钮
   - 请求 AR 权限
   - 启动 WebXR 会话

2. **模型放置**
   - 检测平面（地面/桌面）
   - 点击放置 Quest 3 模型
   - 模型锚定到现实世界

3. **交互控制**
   - 单指旋转
   - 双指缩放
   - 捏合移动

4. **光照估计**
   - 使用环境光照
   - 投射阴影（可选）

#### 2.3 UI/UX

**AR 模式 UI**：
- 顶部状态栏（退出按钮、帮助提示）
- 底部提示（"点击放置模型"、"双指缩放"）
- 加载指示器
- 权限请求说明

**fallback**：
- 不支持 AR 的设备显示提示
- 提供 "在浏览器中查看 3D 模式" 选项

---

## 🔧 技术细节

### 真实模型集成

**当前模型结构**：
```javascript
const parts = [
  { mesh, homePos, explodePos, homeRot, explodeRot, name }
];
```

**真实模型适配**：
- 方案 A：一次性替换整个模型
  - 优点：简单直接
  - 缺点：爆炸点需要重新计算

- 方案 B：并行保留两个模型
  - 优点：可切换，保留简化版
  - 缺点：增加文件大小

**推荐**：方案 B（提供切换选项）

### WebXR AR 实现

**核心 API**：
```javascript
// 检测支持
navigator.xr.isSessionSupported('immersive-ar')

// 启动会话
navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['hit-test', 'local-floor']
})

// 渲染循环
session.requestAnimationFrame(onXRFrame)

// 放置模型
const hitTest = await session.requestHitTest(...)
```

**hit-test 流程**：
1. 用户点击屏幕
2. 执行 hit-test 检测平面
3. 获取 hit matrix
4. 将模型定位到 hit point

**光照估计**：
```javascript
session.requestLightEstimate()
```

**参考实现**：
- Three.js WebXR 示例
- model-viewer 组件（Google）

---

## 📝 实施步骤

### 步骤 1：模型准备

1. 搜索并下载 Quest 3 GLB 模型
2. 检查模型质量（面数、材质）
3. 在 Blender 中预处理（如需要）
4. 添加到项目 `models/` 目录

### 步骤 2：真实模型集成

1. 添加模型加载器配置
2. 实现爆炸点自动计算
3. 添加模型切换按钮
4. 测试所有功能兼容性

### 步骤 3：WebXR 检测

1. 添加 `'xr' in navigator` 检测
2. 实现 `isSessionSupported()` 检查
3. 添加 UI 提示（支持/不支持）

### 步骤 4：AR 会话

1. 实现 `startARSession()` 函数
2. 配置 AR 会话参数
3. 设置渲染循环
4. 处理会话结束

### 步骤 5：模型放置

1. 实现 hit-test
2. 添加放置指示器
3. 实现点击放置逻辑
4. 处理放置后的交互

### 步骤 6：AR 交互

1. 实现拖拽移动
2. 实现双指缩放
3. 实现旋转手势
4. 添加触觉反馈（如支持）

### 步骤 7：光照和阴影

1. 实现光照估计
2. 调整模型光照
3. 添加阴影投射
4. 优化真实感

### 步骤 8：测试和优化

1. 在 Android Chrome 测试
2. 在 iOS Safari 测试
3. 优化性能（降低面数）
4. 修复兼容性问题

---

## 🎨 UI 设计

### AR 按钮

**位置**：步骤按钮区域

**样式**：
- 图标：📱 或 🌐
- 颜色：蓝紫渐变
- 文字："AR 预览" / "在 AR 中查看"

**状态**：
- 默认：显示
- 不支持 AR：禁用或隐藏
- AR 进行中：高亮

### AR 模式界面

**顶部栏**：
```
[退出]  AR 模式    [?]
```

**底部提示**：
```
移动手机扫描环境...
点击放置 Quest 3 模型
```

**控制提示**（首次进入）：
```
双指缩放：调整大小
单指旋转：旋转视角
双指移动：调整位置
```

---

## ⚠️ 注意事项

### 真实模型

**版权问题**：
- ⚠️ 确保模型有使用授权
- ⚠️ 避免商业用途侵权
- ⚠️ 注明模型来源

**性能考虑**：
- 真实模型可能面数很高（5万-50万面）
- 需要 LOD（细节层次）
- 需要实例化渲染
- 移动端可能卡顿

**文件大小**：
- 带纹理的 GLB 可能很大（10-50MB）
- 需要压缩纹理
- 考虑分块加载

### WebXR AR

**设备限制**：
- 仅移动设备支持
- 需要 HTTPS（Vercel ✅）
- 需要用户授权
- 部分功能需要 ARCore/ARKit

**性能优化**：
- 降低模型面数（< 10万面）
- 简化材质
- 减少实时阴影
- 优化渲染循环

**兼容性**：
- iOS Safari：需要 iOS 15+
- Android Chrome：需要 Android 7+
- 桌面浏览器：仅支持 VR，不支持 AR

---

## 📊 工作量估计

### 真实模型集成

| 任务 | 预计时间 | 难度 |
|------|---------|------|
| 搜索/下载模型 | 30-60 分钟 | ⭐⭐ |
| 模型预处理 | 1-2 小时 | ⭐⭐⭐ |
| 集成到项目 | 2-3 小时 | ⭐⭐⭐ |
| 测试调整 | 1-2 小时 | ⭐⭐⭐ |
| **总计** | **5-8 小时** | **⭐⭐⭐** |

### WebXR AR

| 任务 | 预计时间 | 难度 |
|------|---------|------|
| 基础检测和 UI | 1-2 小时 | ⭐⭐ |
| AR 会话管理 | 2-3 小时 | ⭐⭐⭐⭐ |
| 模型放置 | 2-3 小时 | ⭐⭐⭐⭐ |
| 交互控制 | 2-3 小时 | ⭐⭐⭐⭐ |
| 光照和优化 | 2-3 小时 | ⭐⭐⭐ |
| 测试调试 | 3-4 小时 | ⭐⭐⭐⭐ |
| **总计** | **12-18 小时** | **⭐⭐⭐⭐** |

---

## 🔄 备选方案

### 如果找不到免费的真实模型

**方案 A**：使用简化但更精细的模型
- 手工在 Blender 中创建
- 使用参考图构建
- 导出为 GLB

**方案 B**：从 iFixit 拆解图中手动重建
- 参考官方拆解照片
- 逐步构建各个部件
- 保持爆炸逻辑

**方案 C**：使用其他 VR 头显模型
- Quest 2、Quest Pro
- Vision Pro
- PS VR2

### 如果 WebXR 兼容性太差

**方案 A**：仅支持 Android（Chrome）
- 检测设备类型
- 只对 Chrome Android 启用

**方案 B**：提供截图和说明
- 提供静态 AR 效果图
- 引导用户下载支持的浏览器

**方案 C**：使用 WebXR Polyfill
- https://github.com/immersive-web/webxr-polyfill
- 提供部分兼容性

---

## 📚 参考资源

### 真实模型资源

- **Sketchfab**：https://sketchfab.com （搜索 "Meta Quest 3"）
- **CGTrader**：https://www.cgtrader.com
- **TurboSquid**：https://www.turbosquid.com
- **Meta 开发者**：https://developer.oculus.com/

### WebXR 参考资料

- **WebXR 设备 API**：https://immersive-web.github.io/webxr/
- **Three.js WebXR**：https://threejs.org/docs/#manual/en/introduction/WebVR-WebXR-Compatibility
- **WebXR Polyfill**：https://github.com/immersive-web/webxr-polyfill
- **AR.js**：https://ar-js-org.github.io/AR.js-Docs/
- **Google model-viewer**：https://modelviewer.dev/

### 示例项目

- Three.js WebXR 示例：https://github.com/mrdoob/three.js/tree/master/examples/webxr
- AR.js 示例：https://github.com/AR-js-org/AR.js/tree/master/three.js/examples

---

## 🎯 实施优先级

### P0（必须）
- ✅ 真实模型文件下载
- ✅ 集成到项目
- ✅ 爆炸动画适配

### P1（重要）
- ✅ WebXR 基础检测
- ✅ AR 会话管理
- ✅ 模型放置

### P2（增强）
- ⏳ 交互控制优化
- ⏳ 光照估计
- ⏳ 性能优化

### P3（完美）
- ⏳ 多模型支持
- ⏳ AR 场景保存
- ⏳ 分享功能

---

## 🚀 开始实施

**准备**：
1. 用户确认方案
2. 下载/创建 Quest 3 模型
3. 创建 `models/` 目录
4. 开始编码

**里程碑**：
- **里程碑 1**：真实模型可用
- **里程碑 2**：WebXR 基础框架
- **里程碑 3**：AR 放置功能
- **里程碑 4**：完整 AR 交互
- **里程碑 5**：测试和优化

---

**计划版本**：v1.0
**最后更新**：2026-06-22
**维护者**：Claude Code
