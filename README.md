# Quest 3 爆炸拆解 3D 视图

基于 Three.js 的 Meta Quest 3 交互式 3D 拆解教学工具，支持爆炸视图、AI 智能爆炸、自定义模型上传、WebXR AR 预览。

**当前版本**：[v1.3.0](RELEASE_NOTES_v1.3.0.md) | **状态**：✅ Stable | **更新**：2026-07-04

## ✨ 核心功能

### 🎮 3D 交互
- **Quest 3 完整模型**：15 个独立部件
- **AI 智能爆炸视图**：一键完全拆解 + 智能深度控制
  - 自动适应模型大小
  - 防止爆炸飞出屏幕
  - 基于相机位置和视野计算
- **自动模型缩放**：微小模型自动放大 10-20 倍
- **部件高亮**：自动高亮当前步骤的部件
- **信息卡片**：悬停显示部件详细信息

### 📚 教学系统
- **7 步结构化教学**（iFixit 风格）
- **工具清单**：每步动态显示所需工具
- **真实技术规格**：基于官方数据

### 🎯 交互控制
- **时间轴控制**：播放/暂停/速度控制（0.5x/1x/2x）
- **键盘快捷键**：
  - `←` / `→`：上一步/下一步
  - `Space`：爆炸/合体
  - `R`：重置
  - `A`：自动旋转开关
  - `F`：聚焦当前部件

### 📱 自定义模型
- **上传功能**：支持 GLB/GLTF 格式（最大 50MB）
- **AI 智能爆炸**：自动计算最佳爆炸距离
  - 根据模型大小调整
  - 防止飞出屏幕
  - 基于视野角度优化
- **自动缩放**：微小模型自动放大到合适大小
- **相机自动适配**：自动调整最佳观看距离
- **拖拽上传**：便捷的拖拽体验

### 📱 AR 预览（Beta）
- **WebXR AR**：在真实环境中查看 Quest 3
- **平面检测**：自动检测地面/桌面
- **自动放置**：模型自动锚定到现实世界
- **支持设备**：Android Chrome、iOS Safari 15+

### 🎨 UI/UX
- **加载动画**：旋转环形加载器
- **主题切换**：深色/浅色主题
- **粒子系统**：500 个环境粒子
- **按钮效果**：悬停 + 点击 + 涟漪
- **步骤动画**：淡入上移动画
- **响应式设计**：移动端完美适配

## 🚀 快速开始

这是一个纯静态项目，无需构建工具。任意 HTTP 服务器均可运行：

```bash
# 使用 Python
python3 -m http.server 8080

# 或使用 Node.js
npx serve .

# 或使用 Vite
npx vite
```

然后打开 http://localhost:8080。

## 📋 版本历史

### [v1.3.0](RELEASE_NOTES_v1.3.0.md) (2026-07-04)

#### ✨ 新功能
- 🤖 **AI 智能爆炸系统**
  - 智能计算爆炸距离（基于模型大小、相机位置、视野角度）
  - 自动防止爆炸飞出屏幕
  - 朝向相机的爆炸自动减小
- 📏 **自动模型缩放**
  - 检测微小模型（< 5 单位）
  - 自动放大 10-20 倍
  - 爆炸距离同步调整
- 📷 **相机自动适配**
  - 根据模型大小计算最佳距离
  - 平滑过渡动画
  - 适用于默认和自定义模型

#### 🐛 Bug 修复
- 修复爆炸飞出屏幕问题
- 修复小模型看不见问题
- 修复 GLTFLoader 实例化错误
- 修复自定义模型不显示问题
- 修复浏览器缓存问题

#### 📚 新增文档
- [SMART_EXPLOSION.md](SMART_EXPLOSION.md) - AI 智能爆炸详解
- [EXPLOSION_TROUBLESHOOTING.md](EXPLOSION_TROUBLESHOOTING.md) - 爆炸调试指南
- [CUSTOM_MODEL_FIX.md](CUSTOM_MODEL_FIX.md) - 自定义模型修复说明
- [GLTFLOADER_FIX.md](GLTFLOADER_FIX.md) - GLTFLoader 技术文档
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - 完整故障排除指南

#### 🧪 新增工具
- [test-explosion.html](test-explosion.html) - 爆炸效果分析
- [check-model.html](check-model.html) - 模型结构检查
- [debug-loader.html](debug-loader.html) - GLTFLoader 调试
- [clear-cache.html](clear-cache.html) - 缓存清除助手
- [test-minimal.html](test-minimal.html) - 最小化测试
- [test-fetch.html](test-fetch.html) - Fetch API 诊断

---

### [v1.2.0](RELEASE_NOTES_v1.2.0.md) (2026-06-22)

#### ✨ 新功能
- 📱 **WebXR AR 预览模式（实验性）**
  - 支持 Android Chrome + iOS Safari
  - Hit-test 平面检测
  - 模型自动放置
  - 60 FPS 渲染

#### 🎨 UI/UX 升级
- 加载动画（旋转环形）
- 深色/浅色主题切换
- 500 粒子系统背景
- 按钮效果升级
- 步骤描述动画
- 工具清单美化
- 自定义滚动条

---

## 部署到 Vercel

1. 安装 Vercel CLI：
   ```bash
   npm i -g vercel
   ```

2. 登录并部署：
   ```bash
   cd quest3-exploded
   vercel
   ```

3. 按提示选择 scope、项目名称，确认部署。

项目已包含 `vercel.json`，静态文件会自动识别。

## 部署到 GitHub Pages

1. 将本目录推送到 GitHub 仓库。
2. 进入仓库 Settings → Pages。
3. Source 选择 Deploy from a branch，Branch 选择 `main`，文件夹选择 `/ (root)`。
4. 保存后即可访问。

## 文件结构

```
quest3-exploded/
├── index.html      # 页面结构
├── style.css       # 界面样式
├── main.js         # Three.js 场景与交互
├── vercel.json     # Vercel 部署配置
└── README.md
```

## 自定义真实模型

当前模型使用 Three.js 基础几何体拼成的简化版 Quest 3。如果你有真实的 GLTF/GLB 模型，可以在 `main.js` 中：

1. 引入 GLTFLoader：
   ```js
   import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
   ```

2. 加载模型并按部件拆分为独立 Group，分别设置 `homePos` 和 `explodePos`。

## 技术栈

- [Three.js](https://threejs.org/)（ES Module CDN）
- 原生 HTML / CSS / JavaScript
- Vercel（可选部署平台）
