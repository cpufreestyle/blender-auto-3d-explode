# WebXR AR 功能实现文档

**日期**：2026-06-22
**版本**：v1.2.0-alpha
**状态**：✅ 基础实现完成

---

## ✨ 已实现功能

### 1. WebXR 检测

**检测逻辑**：
```javascript
if ('xr' in navigator) {
  const isSupported = await navigator.xr.isSessionSupported('immersive-ar');
}
```

**支持情况**：
- ✅ Chrome Android（支持）
- ✅ Safari iOS 15+（支持）
- ⚠️ Chrome Desktop（不支持 AR）
- ❌ Firefox（部分支持）

### 2. AR 按钮

**位置**：步骤按钮区域

**功能**：
- ✅ 自动检测设备是否支持 AR
- ✅ 仅在支持 AR 的设备上显示
- ✅ 点击启动 AR 会话
- ✅ AR 中显示"退出 AR"按钮

**样式**：
- 绿蓝渐变背景（#00d4aa → #00b894）
- 手机图标 (📱)
- 悬停效果 + 发光阴影

### 3. AR 会话管理

**启动流程**：
1. 检测 WebXR 支持
2. 请求 AR 权限
3. 配置会话参数
4. 创建 AR 渲染器
5. 开始 AR 渲染循环

**会话配置**：
```javascript
{
  requiredFeatures: ['hit-test', 'local-floor'],
  optionalFeatures: ['dom-overlay', 'light-estimation'],
  domOverlay: { root: document.body }
}
```

**必需功能**：
- `hit-test`：平面检测和放置
- `local-floor`：地面参考系

**可选功能**：
- `dom-overlay`：DOM 元素覆盖层
- `light-estimation`：环境光照估计

### 4. 模型放置（Hit-test）

**流程**：
1. 用户移动手机扫描环境
2. 执行 hit-test 检测平面
3. 检测到平面后自动放置模型
4. 模型锚定到现实世界坐标

**当前实现**：
- ✅ 自动检测平面
- ✅ 检测到后自动放置
- ⚠️ 没有放置指示器

**待改进**：
- [ ] 添加可见的放置指示器
- [ ] 允许用户点击手动放置
- [ ] 显示平面边界框

### 5. AR 渲染

**AR 场景配置**：
- 克隆 Quest 3 模型（`questGroup.clone()`）
- 缩放为 10%（适应真实环境）
- 自动旋转展示
- 简单的爆炸呼吸效果

**渲染循环**：
```javascript
arRenderer.setAnimationLoop((timestamp, frame) => {
  // 更新相机
  // Hit-test 检测
  // 放置模型
  // 渲染场景
});
```

**特效**：
- ✅ 自动旋转（继承普通模式的 autoRotate）
- ✅ 呼吸式爆炸效果
- ✅ 简单光照（环境光 + 平行光）

### 6. 退出 AR

**退出方式**：
- 点击"退出 AR"按钮
- 调用 `arSession.end()`
- 自动重新加载页面

**恢复流程**：
1. 结束 AR 会话
2. 清理变量
3. 重新加载页面（简单恢复）

---

## 📝 使用说明

### 用户操作流程

1. **访问页面**
   - 使用支持 AR 的设备
   - 必须使用 HTTPS（Vercel 已支持）

2. **启动 AR**
   - 点击绿色 "📱 AR 预览" 按钮
   - 授予相机权限（首次使用）

3. **放置模型**
   - 移动手机扫描周围环境
   - 系统自动检测平面
   - 检测到后自动放置 Quest 3 模型

4. **查看模型**
   - 模型会自动旋转展示
   - 有轻微的爆炸呼吸效果

5. **退出 AR**
   - 点击 "🚪 退出 AR" 按钮
   - 返回普通 3D 模式

### 支持的设备

**推荐设备**：
- ✅ Android 7+ + Chrome 79+
- ✅ iOS 15+ + Safari

**不支持**：
- ❌ 桌面浏览器（Chrome/Firefox/Safari）
- ❌ iOS 14 及以下

---

## ⚠️ 当前限制

### 1. 真实模型缺失

**问题**：
- 仍使用简化版几何体
- 没有使用真实 Quest 3 GLB 模型

**原因**：
- 未找到免费的高质量 Quest 3 GLB 文件
- 需要手动下载和集成

**影响**：
- AR 中显示的仍是简化版
- 视觉质量受限

**后续**：
- [ ] 搜索/创建真实 Quest 3 GLB 模型
- [ ] 集成到 AR 模式

### 2. 交互功能有限

**当前**：
- 只能放置和观看
- 不能手动拖拽移动
- 不能缩放/旋转

**待实现**：
- [ ] 捏合手势缩放
- [ ] 单指旋转
- [ ] 双指移动

### 3. 无放置指示器

**问题**：
- 用户不知道是否已检测到平面
- 没有视觉反馈

**待改进**：
- [ ] 添加平面检测动画
- [ ] 显示放置预览轮廓

### 4. 光照和阴影

**当前**：
- 基础光照
- 无阴影

**待优化**：
- [ ] 光照估计
- [ ] 环境阴影
- [ ] 真实感增强

---

## 🔧 技术实现

### 文件修改

**main.js**：
- 新增 ~200 行代码
- 新增函数：
  - `checkARSupport()`
  - `updateARButton()`
  - `startAR()`
  - `onAREnd()`
  - `initAR()`

**index.html**：
- 新增 AR 按钮：`<button id="ar-btn" class="step-btn ar-btn">`

**style.css**：
- 新增 AR 按钮样式（~50 行）
- 渐变背景：`linear-gradient(135deg, #00d4aa 0%, #00b894 100%)`

### WebXR API 使用

**核心 API**：
- `navigator.xr.isSessionSupported()` - 检测支持
- `navigator.xr.requestSession()` - 请求会话
- `xr.setSession()` - 绑定会话到渲染器
- `frame.getHitTestResults()` - 平面检测
- `renderer.xr.setAnimationLoop()` - AR 渲染循环

**参考文档**：
- [WebXR Device API](https://immersive-web.github.io/webxr/)
- [Three.js WebXR](https://threejs.org/docs/#manual/en/introduction/WebVR-WebXR-Compatibility)

---

## 🧪 测试方法

### 在手机上测试

**Android**：
1. 打开 Chrome
2. 访问 https://quest3-exploded.vercel.app
3. 点击 "📱 AR 预览"
4. 授予相机权限
5. 移动手机扫描平面
6. 等待模型自动放置

**iOS**：
1. 打开 Safari
2. 访问 https://quest3-exploded.vercel.app
3. 点击 "📱 AR 预览"
4. 授予相机权限
5. 移动手机扫描平面
6. 等待模型自动放置

### 在桌面测试

**预期行为**：
- AR 按钮不会显示
- 控制台输出：`WebXR not supported` 或 `WebXR AR supported: false`

---

## 🚀 下一步改进

### 立即可做

1. **添加放置指示器**
   - 显示检测到的平面边界
   - 显示放置预览轮廓
   - 点击确认放置

2. **手势交互**
   - 捏合缩放
   - 单指旋转
   - 双指拖拽

3. **优化爆炸效果**
   - 可以控制爆炸程度
   - 爆炸/合体按钮

### 中期改进

1. **真实 Quest 3 模型**
   - 下载 GLB 文件
   - 集成到 AR 模式

2. **光照估计**
   - 使用环境光照
   - 投射阴影

3. **性能优化**
   - 降低模型面数
   - 优化渲染循环
   - LOD（细节层次）

### 长期规划

1. **AR 场景保存**
   - 保存模型位置和状态
   - 下次打开恢复

2. **AR 分享**
   - 截图分享
   - AR 链接

3. **多模型支持**
   - 在 AR 中切换不同产品
   - 比较功能

---

## 📊 代码统计

```
main.js:
  + WebXR AR 支持 (~200 行)
  + 6 个新函数
  + AR 会话管理
  + Hit-test 实现

index.html:
  + AR 按钮

style.css:
  + AR 按钮样式 (~50 行)

总计: ~250 行新增代码
```

---

## 🔍 已知问题

### 问题 1：重新加载页面

**当前行为**：
退出 AR 时会重新加载整个页面

**原因**：
简化实现，避免状态不一致

**影响**：
- 丢失普通模式的当前状态
- 用户体验不佳

**后续优化**：
- 保存状态
- 平滑过渡恢复

### 问题 2：无错误处理

**当前**：
- 简单的 alert 提示
- 没有详细的错误信息

**待改进**：
- 友好的错误提示 UI
- 详细的诊断信息

### 问题 3：缺少真实模型

**影响**：
- AR 中显示简化版
- 不够真实

**解决方案**：
- 下载真实 Quest 3 GLB 模型

---

## 📚 参考资源

### 官方文档
- [WebXR Device API](https://immersive-web.github.io/webxr/)
- [WebXR Hit Test Module](https://immersive-web.github.io/hit-test/)
- [Three.js WebXR](https://threejs.org/docs/#manual/en/introduction/WebVR-WebXR-Compatibility)

### 示例项目
- [Three.js WebXR Examples](https://github.com/mrdoob/three.js/tree/master/examples/webxr)
- [AR.js](https://ar-js-org.github.io/AR.js-Docs/)
- [Google model-viewer](https://modelviewer.dev/)

### Polyfill
- [WebXR Polyfill](https://github.com/immersive-web/webxr-polyfill)
  - 用于兼容不支持 WebXR 的设备

---

**文档版本**：v1.0
**最后更新**：2026-06-22
**状态**：✅ 基础功能完成，待优化
**维护者**：Claude Code
