# Quest 3 爆炸拆解 3D 视图

基于 Three.js 的 Meta Quest 3 交互式 3D 拆解教学工具，支持爆炸视图、自定义模型上传、WebXR AR 预览。

## ✨ 核心功能

### 🎮 3D 交互
- **Quest 3 完整模型**：15 个独立部件
- **爆炸视图**：一键完全拆解 + 深度滑块控制
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
- **智能爆炸**：自动计算爆炸方向
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
