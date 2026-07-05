# 🐛 故障排除指南

## 问题：loader.parse is not a function

### 原因
浏览器缓存了旧版本的 JavaScript 文件。旧版本中 `loadGLTFLoader()` 返回的是类而不是实例。

### 解决方案（按推荐顺序）

#### ✅ 方案 1: 强制刷新（最快）

**Mac**:
```
Cmd + Shift + R
```

**Windows/Linux**:
```
Ctrl + Shift + R
```

或者：
1. 打开开发者工具（F12）
2. 右键点击刷新按钮 🔄
3. 选择"清空缓存并硬性重新加载"

---

#### ✅ 方案 2: 使用无痕模式

**Mac**:
- Chrome: `Cmd + Shift + N`
- Firefox: `Cmd + Shift + P`
- Safari: `Cmd + Shift + N`

**Windows**:
- Chrome/Edge: `Ctrl + Shift + N`
- Firefox: `Ctrl + Shift + P`

然后在无痕窗口中访问：
```
http://127.0.0.1:8080/
```

---

#### ✅ 方案 3: 清除浏览器缓存

**Chrome/Edge**:
1. `Cmd + Option + E` (Mac) 或 `Ctrl + Shift + Delete` (Windows)
2. 选择"缓存的图像和文件"
3. 点击"清除数据"
4. 刷新页面

**Firefox**:
1. `Cmd + Shift + Delete` (Mac) 或 `Ctrl + Shift + Delete` (Windows)
2. 选择"缓存"
3. 点击"立即清除"
4. 刷新页面

**Safari**:
1. `Cmd + Option + E`
2. 刷新页面

---

#### ✅ 方案 4: 使用清除缓存页面

访问：
```
http://127.0.0.1:8080/clear-cache.html
```

点击"🔄 硬性重新加载"按钮。

---

### 验证修复

清除缓存后，访问：
```
http://127.0.0.1:8080/debug-loader.html
```

应该看到：
- ✅ 步骤 1/4: HTTP 服务器正常
- ✅ 步骤 2/4: 下载成功 (8.2 MB)
- ✅ 步骤 3/4: GLTFLoader 已就绪
- ✅ 步骤 4/4: 解析成功

---

### 其他常见问题

#### 问题：CORS 错误

**错误信息**：
```
Access to fetch at 'file:///...' from origin 'null' has been blocked by CORS policy
```

**解决**：
- ❌ 不要直接双击 HTML 文件打开
- ✅ 必须通过 `http://127.0.0.1:8080/` 访问

#### 问题：Failed to fetch

**原因**：
- 浏览器扩展阻止（广告拦截器、隐私保护）
- 网络连接问题
- 文件太大（8.2 MB）

**解决**：
1. 禁用浏览器扩展
2. 使用无痕模式
3. 检查网络连接
4. 访问 `http://127.0.0.1:8080/test-fetch.html` 进行诊断

#### 问题：模型加载成功但看不到

**原因**：
- 默认模型和新模型重叠
- 相机位置不当
- 模型太小或太大

**解决**：
1. 旋转视角（左键拖动）
2. 缩放（滚轮）
3. 平移（右键拖动）
4. 检查是否显示了"当前模型：xxx.glb"
5. 查看控制台是否有错误

---

### 检查清单

在报告问题之前，请确认：

- [ ] 通过 `http://127.0.0.1:8080/` 访问（不是 file://）
- [ ] 已强制刷新（Cmd+Shift+R）
- [ ] 浏览器控制台（F12）没有红色错误
- [ ] 服务器正在运行（`ps aux | grep http.server`）
- [ ] 模型文件存在（`ls models/Quest3.glb`）

---

### 联系支持

如果以上方法都不行，请提供：
1. 浏览器名称和版本
2. 访问的 URL
3. 控制台（F12 → Console）的完整错误信息
4. 网络（F12 → Network）标签页的截图

---

**最后更新**: 2026-07-04
**版本**: 1.0
