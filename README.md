# 🔧 Blender Auto 3D Explode

> 基于 Three.js 的交互式 3D 拆解教学工具 — 支持 AI 生成模型、爆炸视图动画、WebXR AR 预览

[![Version](https://img.shields.io/github/v/release/cpufreestyle/blender-auto-3d-explode)](https://github.com/cpufreestyle/blender-auto-3d-explode/releases)
[![License](https://img.shields.io/badge/license-ISC-blue)](./LICENSE)

---

## ✨ 功能亮点

| 功能 | 说明 |
|------|------|
| 🧨 **3D 爆炸视图** | 滑块控制拆解程度，鼠标拖拽旋转/缩放，点击查看部件信息 |
| 🤖 **AI 生成模型** | 文字提示词生成 3D 模型（乐高人仔、汽车、房子、超级英雄等） |
| 🖼️ **图片转 3D** | 上传图片自动重建为 3D 模型，支持纹理烘焙 |
| 📱 **WebXR AR 预览** | 在支持 AR 的设备上将模型投射到现实空间 |
| 🧱 **乐高砖块拼接** | 2x4, 2x2, 1x2 等标准砖块，真实积木拼接效果 |
| 🎨 **自定义模型上传** | 上传 GLB 模型直接预览拆解效果 |
| 🔌 **多 AI 提供商** | OpenAI / Anthropic / StepFun / Ollama / LM Studio / NVIDIA / Replicate |
| 🌐 **3D 生成 MCP 联动** | Meshy / Tripo(Triple 3D) / Hyper3D(Rodin) 经 MCP 工具调用，生成模型直接导入 Blender 场景 |

---

## 🚀 快速开始

### 前提条件

- **Node.js** 18+
- **Blender** 3.6+（可选，AI 绘画功能需要）

### macOS

双击 `启动服务.command`

### Windows

双击 `start.bat`

### 命令行

```bash
npm install
node server.js
# 浏览器打开 http://localhost:3001
```

---

## 🎮 使用指南

### 3D 拆解视图

- 拖动滑块控制拆解程度
- 鼠标拖拽旋转视角，滚轮缩放
- 点击部件高亮并显示信息

### AI 模型生成

1. 访问 `http://localhost:3001/ai-config.html` 配置 AI 提供商
2. 在主页输入提示词（如"乐高跑车"、"蝙蝠侠"）
3. 系统自动调用 Blender 生成 3D 模型并加载

### 图片转 3D

上传图片 → 自动去背景 → 3D 重建 → 纹理烘焙 → 交互预览

---

## 📦 项目结构

```
├── index.html          # 主页面（3D 拆解预览）
├── ai-config.html      # AI 模型配置页
├── main.js             # Three.js 场景 & 拆解逻辑
├── server.js           # Node.js 后端服务
├── scripts/            # 图片转3D / 纹理烘焙 / 工具脚本
├── src/                # 前端模块
├── tests/              # 单元 & E2E 测试
├── docs/               # 详细文档
└── blender_scripts/    # Blender Python 脚本
```

---

## 🛠️ 开发

```bash
npm run dev           # 启动开发服务器
npm run server        # 启动 Blender 集成服务器
npm run format:all    # 代码格式化
npm run test          # 运行测试
npm run build         # 生产构建
```

---

## 🤖 支持的 AI 提供商

| 提供商 | 用途 | 配置方式 |
|--------|------|----------|
| OpenAI | 文本生成模型 | API Key |
| Anthropic | 文本生成模型 | API Key |
| StepFun (阶跃星辰) | 文本生成模型 | API Key |
| NVIDIA | GLM-5.2 模型 | API Key |
| Ollama | 本地模型 | 本地地址 |
| LM Studio | 本地模型 | 本地地址 |
| Replicate | Hunyuan3D-2 图生3D | API Token |

复制 `ai-config.example.json` 为 `ai-config.json` 并填入密钥即可。

---

## 🔗 3D 生成 MCP 联动

项目内置 MCP 服务器（`scripts/mcp_server.py`），可被 Claude / CodeBuddy 等支持 MCP 的 CUI 直接调用，将云端 3D 生成服务与本地 Blender 场景联动。

### 接入方式

在 MCP 客户端（如 `.mcp.json`）中指向本服务器：

```json
{ "mcpServers": { "blender": { "command": "python3", "args": ["scripts/mcp_server.py"] } } }
```

### 新增的 3D 生成工具

| 工具 | 服务 | 流程 |
|------|------|------|
| `create_meshy_job` / `poll_meshy_job` / `import_meshy_asset` | **Meshy AI** | 文生/图生 3D → 轮询 → 导入场景 |
| `create_tripo_job` / `poll_tripo_job` / `import_tripo_asset` | **Tripo (Triple 3D)** | 文生/图生 3D → 轮询 → 导入场景 |
| `create_hyper3d_job` / `poll_hyper3d_job` / `import_hyper3d_asset` | **Hyper3D (Rodin)** | 复用已有 Rodin 命令 |

- 密钥通过参数 `api_key` 传入，或设置环境变量 `MESHY_API_KEY` / `TRIPO_API_KEY`
- `create`/`poll` 无需 Blender 运行；`import_*` 会把生成的 GLB 下载到本地并导入当前 Blender 场景（联动）

---

## 📄 License

ISC
