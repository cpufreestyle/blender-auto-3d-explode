# 🧪 AR 模式测试指南

## 测试环境要求

### ✅ 必需条件

1. **设备要求**
   - Android 7.0+ 设备（推荐）
   - iOS 15+ 设备（iPhone/iPad）
   - ❌ 桌面浏览器不支持 AR

2. **浏览器要求**
   - Android: Chrome 79+
   - iOS: Safari 15+
   - ❌ Firefox（不支持 WebXR）
   - ❌ 桌面 Chrome（不支持 AR）

3. **网络要求**
   - ✅ **必须使用 HTTPS**
   - ❌ HTTP 不支持（WebXR 安全限制）
   - Vercel 自动提供 HTTPS

4. **权限要求**
   - 相机权限
   - 动作传感器权限（陀螺仪、加速度计）

---

## 📋 测试步骤

### 1. 基本检测测试

**在手机上打开**：
```
https://quest3-exploded.vercel.app
```

**预期行为**：
- ✅ 页面加载正常
- ✅ 可以看到 "📱 AR 预览" 按钮（绿色）
- ✅ 控制台看到 `WebXR AR supported: true`

**如果按钮不显示**：
```javascript
// 打开浏览器控制台（远程调试）
// Android: chrome://inspect
// iOS: Safari → 开发 → 模拟器

// 应该看到：
WebXR AR supported: true/false
```

### 2. AR 启动测试

**步骤**：
1. 点击 **"📱 AR 预览"** 按钮
2. 授予**相机权限**
3. 授予**动作传感器权限**

**预期行为**：
- ✅ 相机预览启动
- ✅ 看到摄像头画面
- ✅ Quest 3 模型出现
- ✅ 模型自动旋转

**如果失败**：
```javascript
// 控制台应该看到错误信息
// 常见错误：
Error: Permission denied
Error: WebXR not supported
Error: Session not supported
```

### 3. Hit-test 平面检测测试

**步骤**：
1. 进入 AR 模式后
2. 缓慢移动手机（上下左右扫描）
3. 观察是否有检测反馈

**预期行为**：
- ✅ 手机移动时扫描环境
- ✅ 检测到平面后模型自动放置
- ✅ 模型稳定停留在检测到的位置

**如果没有反应**：
- 尝试在光线充足的环境
- 移动手机速度放慢
- 扫描纹理丰富的平面（不要扫描纯色墙面）

### 4. 模型显示测试

**步骤**：
1. 等待模型出现
2. 观察模型状态

**预期行为**：
- ✅ 模型出现在视野中
- ✅ 模型自动旋转（缓慢）
- ✅ 模型有呼吸爆炸效果
- ✅ 模型大小适中（约手掌大小）

**检查清单**：
- [ ] 模型可见
- [ ] 模型材质正确
- [ ] 模型大小合适
- [ ] 动画流畅（60 FPS）
- [ ] 无闪烁或卡顿

### 5. AR 退出测试

**步骤**：
1. 点击 **"🚪 退出 AR"** 按钮

**预期行为**：
- ✅ AR 会话正常关闭
- ✅ 返回到普通 3D 视图
- ✅ 没有错误提示

---

## 🐛 常见问题排查

### 问题 1：AR 按钮不显示

**症状**：看不到绿色 "📱 AR 预览" 按钮

**可能原因**：
1. 桌面浏览器（不支持）
2. 浏览器版本太低
3. WebXR 被禁用
4. HTTP 而非 HTTPS

**解决**：
```bash
# 1. 检查设备
# - 必须是手机/平板
# - 不能是桌面浏览器

# 2. 检查浏览器版本
# Android: Chrome 79+
# iOS: Safari 15+

# 3. 检查 URL
# 必须是 https://
# 不能是 http://

# 4. 检查控制台
# 应该看到：WebXR AR supported: true/false
```

### 问题 2：点击 AR 按钮无反应

**症状**：点击按钮后没有任何反应

**可能原因**：
1. 权限被拒绝
2. 会话启动失败
3. 浏览器不支持

**解决**：
```javascript
// 在控制台检查：
console.log('WebXR supported:', 'xr' in navigator);
console.log('AR supported:', arSupported);
console.log('AR session:', arSession);
```

### 问题 3：相机权限被拒绝

**症状**：提示需要相机权限，但无法授予

**可能原因**：
1. 浏览器设置禁用
2. 系统权限禁用
3. HTTPS 问题

**解决**：
**Android**：
1. 设置 → Chrome → 权限 → 相机 → 允许
2. 清除 Chrome 缓存
3. 重启 Chrome

**iOS**：
1. 设置 → Safari → 相机 → 允许
2. 或：设置 → Chrome → 相机 → 允许
3. 重启 Safari/Chrome

### 问题 4：模型看不见

**症状**：进入 AR 模式，但看不到模型

**可能原因**：
1. 模型缩放太小
2. 模型在视野外
3. 平面检测失败
4. 光照太暗

**解决**：
```javascript
// 检查模型状态
console.log('AR model:', arModel);
console.log('Model visible:', arModel?.visible);
console.log('Model position:', arModel?.position);

// 尝试：
// 1. 在光线充足的环境
// 2. 扫描纹理丰富的平面
// 3. 移动手机速度放慢
```

### 问题 5：模型飞出屏幕

**症状**：模型出现在很远的地方

**可能原因**：
1. Hit-test 返回错误坐标
2. 平面检测失败

**解决**：
- 重新进入 AR 模式
- 扫描不同的平面
- 确保手机移动缓慢

### 问题 6：卡顿或低 FPS

**症状**：动画不流畅，掉帧

**可能原因**：
1. 设备性能不足
2. 后台应用太多
3. 模型太复杂

**解决**：
- 关闭后台应用
- 重启浏览器
- 使用性能更好的设备

---

## 🔍 调试工具

### 远程调试

#### Android Chrome
1. 手机开启**开发者选项**
2. 连接 USB 到电脑
3. 电脑打开 Chrome
4. 访问：`chrome://inspect`
5. 选择设备 → 检查

#### iOS Safari
1. 手机开启**开发者选项**
2. 连接 USB 到 Mac
3. Mac 打开 Safari
4. 菜单：开发 → [设备名] → 页面

### 控制台命令

```javascript
// 检查 WebXR 支持
console.log('WebXR:', 'xr' in navigator);
console.log('AR support:', arSupported);

// 检查 AR 状态
console.log('AR session:', arSession);
console.log('AR model:', arModel);
console.log('AR renderer:', arRenderer);

// 检查模型
console.log('Model visible:', arModel?.visible);
console.log('Model position:', arModel?.position);
console.log('Model scale:', arModel?.scale);

// 手动触发 AR
await startAR();

// 退出 AR
onAREnd();
```

---

## 📊 测试清单

### 基本功能
- [ ] 页面正常加载
- [ ] AR 按钮显示（绿色）
- [ ] 点击 AR 按钮
- [ ] 相机权限请求
- [ ] 进入 AR 模式
- [ ] 摄像头画面显示

### 模型显示
- [ ] Quest 3 模型出现
- [ ] 模型自动旋转
- [ ] 模型有呼吸效果
- [ ] 模型大小合适
- [ ] 材质渲染正确

### 平面检测
- [ ] Hit-test 正常工作
- [ ] 模型自动放置
- [ ] 模型稳定不动
- [ ] 不同平面都能检测

### 交互控制
- [ ] 退出 AR 按钮可用
- [ ] 点击退出返回普通模式
- [ ] 普通模式状态恢复

### 性能
- [ ] 动画流畅（60 FPS）
- [ ] 无明显卡顿
- [ ] 内存占用正常
- [ ] 无崩溃或闪退

---

## 📝 测试报告模板

```markdown
## AR 测试报告

**日期**：YYYY-MM-DD
**测试者**：姓名
**设备**：设备型号
**系统版本**：iOS/Android 版本
**浏览器**：Chrome/Safari 版本

### 测试结果

| 测试项 | 状态 | 备注 |
|--------|------|------|
| 页面加载 | ✅/❌ | |
| AR 按钮显示 | ✅/❌ | |
| 相机权限 | ✅/❌ | |
| 进入 AR | ✅/❌ | |
| 模型显示 | ✅/❌ | |
| 平面检测 | ✅/❌ | |
| 退出 AR | ✅/❌ | |

### 问题记录

1. **问题**：描述
   - **重现步骤**：
   - **预期**：
   - **实际**：
   - **截图/录屏**：

### 性能数据

- **FPS**：
- **内存占用**：
- **加载时间**：

### 其他观察

-
```

---

## 🚀 快速测试（5 分钟）

1. **手机打开** https://quest3-exploded.vercel.app
2. **检查按钮** 看到绿色 AR 按钮
3. **点击按钮** 授予相机权限
4. **扫描环境** 缓慢移动手机
5. **观察模型** 应该出现并自动放置
6. **退出 AR** 点击退出按钮

**完成！** 🎉

---

## 📚 相关文档

- [WEBXR_AR_IMPLEMENTATION.md](WEBXR_AR_IMPLEMENTATION.md) - AR 实现文档
- [AR_FEATURE_COMPLETE.md](AR_FEATURE_COMPLETE.md) - AR 功能报告
- [REAL_MODEL_AR_PLAN.md](REAL_MODEL_AR_PLAN.md) - 真实模型规划

---

**最后更新**：2026-07-04
**维护者**：Claude Code
