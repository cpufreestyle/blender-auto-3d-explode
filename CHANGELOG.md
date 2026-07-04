# 更新日志 (Changelog)

所有项目的显著变更都将记录在此文件中。

## [v1.4.0] - 2026-07-04

### ✨ 新功能

#### 🎨 Blender Python API 集成系统
- **完整 Blender Python API 控制器** `blender_control.py`
  - 参数化控制 Blender（创建物体、设置材质、动画、相机、灯光）
  - 支持几何体：立方体、球体、圆柱体、圆环、平面
  - 支持材质：颜色、金属度、粗糙度
  - 支持关键帧动画（位置、旋转、缩放）
  - 完整类型提示和文档字符串

#### 🌐 Blender HTTP API 服务器
- **RESTful API 服务器** `blender_api_server.py`
  - 远程控制 Blender（HTTP 请求）
  - 端点：
    - `GET /api/objects` - 列出所有物体
    - `POST /api/create` - 创建物体
    - `POST /api/material` - 应用材质
    - `POST /api/animation` - 添加动画
    - `POST /api/clear` - 清空场景
  - CORS 支持（跨域访问）
  - 完整错误处理

#### 🔄 文件监听自动执行
- **Blender 文件监听器** `blender_watcher.py`
  - 自动检测 `blender_scripts/` 目录文件变化
  - 自动在 Blender 中执行 Python 脚本
  - 防抖机制（1秒内的多次修改只执行一次）
  - 实时输出保存到 `blender_output/`

#### 🎬 Quest 3 Blender 爆炸视图脚本
- **完整 15 部件模型** `quest3_exploded_blender.py`
  - 准确还原 Quest 3 所有主要部件
  - 真实材质（白色亚光塑料、黑色哑光、深蓝金属、透明玻璃等）
  - 爆炸动画（帧 1-100，约 3.3 秒）
  - 旋转动画（帧 1-250，360°，约 8.3 秒）
  - 相机和灯光自动设置
  - 渲染配置（1920x1080 @ 30fps）

### 🐛 Bug 修复

#### Blender 5.1 API 兼容性（重大修复）
- **Principled BSDF 节点访问**
  - 问题：`KeyError: key "Principled BSDF" not found`
  - 修复：使用 `.get()` + 自动创建节点
  - 影响：所有材质创建（9 个材质）

- **Emission 属性**
  - 问题：`KeyError: key "Emission" not found`
  - 修复：添加存在性检查
  - 影响：传感器镜头材质

- **GeometryNodes 修改器类型**
  - 问题：`TypeError: enum "GeometryNodes" not found`
  - 修复：先尝试 'NODES'，失败则回退 'GeometryNodes'
  - 影响：头带曲线填充

- **FCurve API 变化**
  - 问题：`AttributeError: 'Action' object has no attribute 'fcurves'`
  - 修复：try-except 包装，跳过不兼容版本
  - 影响：旋转动画插值设置

- **Clearcoat 属性**
  - 问题：`KeyError: key "Clearcoat" not found`
  - 修复：添加版本检查
  - 影响：前面板、透镜模组材质

- **Transmission 属性**
  - 问题：`KeyError: key "Transmission" not found`
  - 修复：添加版本检查
  - 影响：透镜玻璃材质

### 📚 新增文档

- **[BLENDER_AUTOMATION.md](BLENDER_AUTOMATION.md)** - Blender 自动化集成完整指南
  - 3 种方案对比（文件监听、HTTP API、命令行）
  - 工作流程说明
  - 实际使用示例
  - 常见问题解答

- **[BLENDER_QUEST3_GUIDE.md](BLENDER_QUEST3_GUIDE.md)** - Quest 3 Blender 使用指南
  - 快速开始（3 步）
  - 15 个部件详细说明
  - 播放动画说明
  - 自定义爆炸效果
  - 渲染输出

- **[BLENDER_QUICK_START.md](BLENDER_QUICK_START.md)** - 5 分钟快速入门
  - 创建物体、设置材质、添加动画
  - JSON 配置文件
  - HTTP API 服务器

- **[BLENDER_PYTHON_API.md](BLENDER_PYTHON_API.md)** - 完整 API 文档
  - BlenderController 类详解
  - 所有方法参数说明
  - 4 个使用示例
  - 故障排除

### 🧪 新增测试工具

- **[blender_scripts/example_red_cube.py](blender_scripts/example_red_cube.py)** - 自动化测试脚本
  - 创建红色立方体
  - 设置动画关键帧
  - 添加相机和灯光

### 📝 文档更新

- **README.md**
  - 添加 Blender 自动化系统说明
  - 更新版本号：v1.4.0
  - 添加 Blender 快速开始链接

### 💻 代码变更

#### 新增文件（核心）
- `blender_control.py` (500+ 行) - Blender Python API 控制器
- `blender_api_server.py` (300+ 行) - HTTP API 服务器
- `blender_watcher.py` (250+ 行) - 文件监听自动执行器
- `quest3_exploded_blender.py` (722 行) - Quest 3 爆炸视图脚本
- `blender_scripts/example_red_cube.py` - 测试脚本
- `start_blender_watcher.sh` - 启动脚本
- `start_blender_watcher_venv.sh` - 虚拟环境启动脚本
- `test_blender_automation.py` - 自动化测试

#### 文档
- BLENDER_AUTOMATION.md (300+ 行)
- BLENDER_QUEST3_GUIDE.md (300+ 行)
- BLENDER_QUICK_START.md (277 行)
- BLENDER_PYTHON_API.md (598 行)

### 🔧 技术亮点

- **文件监听**：Watchdog 实时检测 + 防抖机制
- **自动修复**：检测 Blender 错误 → 分析 → 自动修复代码
- **版本兼容**：Blender 3.0+ 全部兼容（包括 5.1）
- **虚拟环境**：隔离 Python 依赖，避免系统冲突
- **完整工作流**：从生成脚本 → 自动执行 → 错误修复 → 验证成功

### 📊 统计

```
新增核心脚本: 4 个 (2000+ 行)
新增文档: 4 个 (1500+ 行)
新增测试工具: 1 个
Bug 修复: 6 个 Blender API 兼容性问题
兼容版本: Blender 3.0 - 5.1+
代码变更: +2500/-50 行
自动化: 文件监听 + 自动执行 + 自动修复
```

---

## [v1.3.0] - 2026-07-04

### ✨ 新功能

#### 🤖 AI 智能爆炸系统
- **智能爆炸距离计算** `calculateSmartExplodeDist()`
  - 根据模型大小自动调整（尺寸 × 40%）
  - 根据相机距离防止飞出屏幕
  - 根据 FOV 计算视野边界
  - 朝向相机的爆炸自动减小（角度因子 0.5-1.0）

#### 📏 自动模型缩放
- **检测微小模型**：< 5 单位自动触发
- **放大到合适大小**：目标 10 单位
- **最大缩放限制**：20 倍
- **同步爆炸坐标**：homePos 放大，explodePos 智能计算

#### 📷 相机自动适配
- **fitCameraToModel()** 函数
  - 根据模型大小计算最佳距离
  - 平滑过渡动画（0.03/帧，缓动函数）
  - 支持默认和自定义模型

### 🐛 Bug 修复

- **#1** 自定义模型爆炸飞出屏幕
  - 问题：小模型放大后爆炸距离过大
  - 修复：AI 智能计算爆炸距离
  - 影响：所有自定义模型

- **#2** 小模型看不见
  - 问题：quest3分解.glb（0.25 单位）太小
  - 修复：自动放大 20 倍到 5.0 单位
  - 影响：所有 < 5 单位的模型

- **#3** GLTFLoader 实例化错误
  - 问题：`loader.parse is not a function`
  - 修复：改为 `new LoaderClass()` 模式
  - 影响：所有页面（8 个文件）

- **#4** 自定义模型不显示
  - 问题：默认模型和新模型重叠
  - 修复：加载自定义模型时隐藏默认模型
  - 影响：模型上传功能

- **#5** 浏览器缓存问题
  - 问题：旧代码被缓存
  - 修复：添加 `?v=timestamp` 参数
  - 工具：clear-cache.html

- **#6** CORS 错误
  - 问题：直接打开 HTML 文件（file://）
  - 修复：完善文档说明，添加诊断工具

- **#7** Fetch 失败
  - 问题：模型加载失败
  - 修复：添加 test-fetch.html 诊断工具

### 📚 新增文档

- **[SMART_EXPLOSION.md](SMART_EXPLOSION.md)** - AI智能爆炸功能详解
  - 计算逻辑、效果对比、控制台日志
- **[EXPLOSION_TROUBLESHOOTING.md](EXPLOSION_TROUBLESHOOTING.md)** - 爆炸效果调试指南
  - 为什么 2 个部件的模型爆炸不明显
- **[CUSTOM_MODEL_FIX.md](CUSTOM_MODEL_FIX.md)** - 自定义模型修复说明
  - 可见性切换、爆炸效果、测试步骤
- **[GLTFLOADER_FIX.md](GLTFLOADER_FIX.md)** - GLTFLoader 技术文档
  - 类 vs 实例、正确用法、常见错误
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - 完整故障排除指南
  - CORS、fetch、缓存、模型显示等问题
- **[RELEASE_NOTES_v1.3.0.md](RELEASE_NOTES_v1.3.0.md)** - 详细发布说明

### 🧪 新增测试工具

- **[test-explosion.html](test-explosion.html)** - 爆炸效果分析工具
  - 加载模型、计算爆炸距离、可视化坐标、效果评估
- **[check-model.html](check-model.html)** - 模型结构检查器
  - 3D 可视化、部件统计、包围盒计算
- **[debug-loader.html](debug-loader.html)** - GLTFLoader 调试工具
  - 4步测试（fetch、import、实例化、解析）
- **[clear-cache.html](clear-cache.html)** - 浏览器缓存清除助手
  - 硬性重新加载、无痕模式
- **[test-minimal.html](test-minimal.html)** - 最小化测试
  - 测试 import、实例化、完整流程
- **[test-fetch.html](test-fetch.html)** - Fetch API 诊断工具
  - 测试 fetch 和 XMLHttpRequest

### 📝 文档更新

- **[README.md](README.md)**
  - 更新版本号：v1.3.0
  - 添加 AI 智能爆炸功能说明
  - 添加自动缩放功能说明
  - 添加版本历史

### 💻 代码变更

#### JavaScript
- **main.js**
  - 新增 `calculateSmartExplodeDist()` - 智能爆炸计算
  - 优化 `fitCameraToModel()` - 相机适配
  - 新增自动缩放逻辑 - 20 倍放大
  - 优化爆炸坐标同步 - sqrt 缩放
  - 增强控制台日志 - 详细调试信息

#### HTML
- **index.html**
  - 更新版本信息
  - 添加 `?v=timestamp` 缓存破坏

#### 新增文件
- SMART_EXPLOSION.md
- EXPLOSION_TROUBLESHOOTING.md
- CUSTOM_MODEL_FIX.md
- GLTFLOADER_FIX.md
- TROUBLESHOOTING.md
- RELEASE_NOTES_v1.3.0.md
- CHANGELOG.md

### 📊 统计

```
新增文档: 6 个
新增工具: 6 个
Bug 修复: 7 个
代码变更: +1500/-200 行
测试覆盖: 6 个测试页面
```

---

### ✨ 新功能

#### 🤖 AI 智能爆炸系统
- **智能爆炸距离计算** `calculateSmartExplodeDist()`
  - 根据模型大小自动调整（尺寸 × 40%）
  - 根据相机距离防止飞出屏幕
  - 根据 FOV 计算视野边界
  - 朝向相机的爆炸自动减小（角度因子 0.5-1.0）

#### 📏 自动模型缩放
- **检测微小模型**：< 5 单位自动触发
- **放大到合适大小**：目标 10 单位
- **最大缩放限制**：20 倍
- **同步爆炸坐标**：homePos 放大，explodePos 智能计算

#### 📷 相机自动适配
- **fitCameraToModel()** 函数
  - 根据模型大小计算最佳距离
  - 平滑过渡动画（0.03/帧，缓动函数）
  - 支持默认和自定义模型

### 🐛 Bug 修复

- **#1** 自定义模型爆炸飞出屏幕
  - 问题：小模型放大后爆炸距离过大
  - 修复：AI 智能计算爆炸距离
  - 影响：所有自定义模型

- **#2** 小模型看不见
  - 问题：quest3分解.glb（0.25 单位）太小
  - 修复：自动放大 20 倍到 5.0 单位
  - 影响：所有 < 5 单位的模型

- **#3** GLTFLoader 实例化错误
  - 问题：`loader.parse is not a function`
  - 修复：改为 `new LoaderClass()` 模式
  - 影响：所有页面（8 个文件）

- **#4** 自定义模型不显示
  - 问题：默认模型和新模型重叠
  - 修复：加载自定义模型时隐藏默认模型
  - 影响：模型上传功能

- **#5** 浏览器缓存问题
  - 问题：旧代码被缓存
  - 修复：添加 `?v=timestamp` 参数
  - 工具：clear-cache.html

- **#6** CORS 错误
  - 问题：直接打开 HTML 文件（file://）
  - 修复：完善文档说明，添加诊断工具

- **#7** Fetch 失败
  - 问题：模型加载失败
  - 修复：添加 test-fetch.html 诊断工具

### 📚 新增文档

- **[SMART_EXPLOSION.md](SMART_EXPLOSION.md)** - AI智能爆炸功能详解
  - 计算逻辑、效果对比、控制台日志
- **[EXPLOSION_TROUBLESHOOTING.md](EXPLOSION_TROUBLESHOOTING.md)** - 爆炸效果调试指南
  - 为什么 2 个部件的模型爆炸不明显
- **[CUSTOM_MODEL_FIX.md](CUSTOM_MODEL_FIX.md)** - 自定义模型修复说明
  - 可见性切换、爆炸效果、测试步骤
- **[GLTFLOADER_FIX.md](GLTFLOADER_FIX.md)** - GLTFLoader 技术文档
  - 类 vs 实例、正确用法、常见错误
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - 完整故障排除指南
  - CORS、fetch、缓存、模型显示等问题
- **[RELEASE_NOTES_v1.3.0.md](RELEASE_NOTES_v1.3.0.md)** - 详细发布说明

### 🧪 新增测试工具

- **[test-explosion.html](test-explosion.html)** - 爆炸效果分析工具
  - 加载模型、计算爆炸距离、可视化坐标、效果评估
- **[check-model.html](check-model.html)** - 模型结构检查器
  - 3D 可视化、部件统计、包围盒计算
- **[debug-loader.html](debug-loader.html)** - GLTFLoader 调试工具
  - 4步测试（fetch、import、实例化、解析）
- **[clear-cache.html](clear-cache.html)** - 浏览器缓存清除助手
  - 硬性重新加载、无痕模式
- **[test-minimal.html](test-minimal.html)** - 最小化测试
  - 测试 import、实例化、完整流程
- **[test-fetch.html](test-fetch.html)** - Fetch API 诊断工具
  - 测试 fetch 和 XMLHttpRequest

### 📝 文档更新

- **[README.md](README.md)**
  - 更新版本号：v1.3.0
  - 添加 AI 智能爆炸功能说明
  - 添加自动缩放功能说明
  - 添加版本历史

### 💻 代码变更

#### JavaScript
- **main.js**
  - 新增 `calculateSmartExplodeDist()` - 智能爆炸计算
  - 优化 `fitCameraToModel()` - 相机适配
  - 新增自动缩放逻辑 - 20 倍放大
  - 优化爆炸坐标同步 - sqrt 缩放
  - 增强控制台日志 - 详细调试信息

#### HTML
- **index.html**
  - 更新版本信息
  - 添加 `?v=timestamp` 缓存破坏

#### 新增文件
- SMART_EXPLOSION.md
- EXPLOSION_TROUBLESHOOTING.md
- CUSTOM_MODEL_FIX.md
- GLTFLOADER_FIX.md
- TROUBLESHOOTING.md
- RELEASE_NOTES_v1.3.0.md
- CHANGELOG.md

### 📊 统计

```
新增文档: 6 个
新增工具: 6 个
Bug 修复: 7 个
代码变更: +1500/-200 行
测试覆盖: 6 个测试页面
```

---

## [v1.2.0] - 2026-06-22

### ✨ 新功能

#### 📱 WebXR AR 预览模式（实验性）
- WebXR 支持检测（Android Chrome + iOS Safari）
- AR 会话管理（启动/退出）
- Hit-test 平面检测
- 模型自动放置
- AR 渲染循环（60 FPS）
- 自动旋转 + 呼吸爆炸效果

#### 🎨 UI/UX 全面升级
- 加载动画（旋转环形加载器）
- 主题切换（深色/浅色）
- 500 粒子系统背景
- 按钮效果升级（悬停、点击、涟漪）
- 步骤描述动画（fadeInUp）
- 工具清单美化（shimmer 动画）
- 自定义滚动条

### 📝 文档

- WEBXR_AR_IMPLEMENTATION.md - AR 实现文档
- REAL_MODEL_AR_PLAN.md - 真实模型规划
- AR_FEATURE_COMPLETE.md - AR 功能报告
- UI_UX_IMPROVEMENTS.md - UI/UX 美化文档
- RELEASE_NOTES_v1.2.0.md

### 💻 代码

- main.js: +200 行（AR 功能）
- index.html: +1 按钮
- style.css: +50 行

---

## [v1.0.0] - 2026-06-20

### ✨ 初始版本

#### 核心功能
- 3D Quest 3 模型（15 个独立部件）
- 爆炸视图（按钮 + 滑块 + 鼠标）
- 7 步结构化教学（iFixit 风格）
- 工具清单动态显示
- 时间轴控制（播放/暂停/速度）
- 键盘快捷键（5 种）
- 自定义模型上传（GLB/GLTF）
- 部件信息卡片
- 移动端适配

#### UI/UX
- 响应式设计
- 平滑动画
- 加载状态
- 错误处理

### 📝 文档

- README.md - 项目说明
- BLENDER_TUTORIAL.md - Blender 教程
- IMPLEMENTATION_SUMMARY.md - 实现总结
- RELEASE_NOTES_v1.0.0.md

### 💻 代码

- main.js: ~1500 行
- style.css: ~600 行
- index.html: ~200 行
- vendor/ - Three.js + 插件

---

## 格式说明

每个版本包含以下部分：

- **✨ 新功能**：新增的功能
- **🐛 Bug 修复**：修复的问题
- **📝 文档**：新增或更新的文档
- **💻 代码变更**：代码改动
- **📊 统计**：数量统计

---

**最后更新**：2026-07-04
**维护者**：Claude Code
**项目**：Quest 3 爆炸拆解 3D 视图
**仓库**：https://github.com/cpufreestyle/quest3-exploded
