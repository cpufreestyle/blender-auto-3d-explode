# AGENTS.md

## Project Overview

Blender Auto 3D Explode — 基于 Three.js 的交互式 3D 拆解教学工具，支持 AI 生成模型、爆炸视图动画、WebXR AR 预览，后端通过 Node.js 调用 Blender Python 脚本完成模型拆解与生成。

## Build & Test Commands

```bash
# 安装依赖
npm install

# 启动静态文件开发服务器（端口 3000）
npm run dev

# 启动 Node.js 后端服务器（端口 3001，调用 Blender）
npm run server

# 运行全部单元测试
npm test

# 运行 E2E 测试
npm run test:e2e

# ESLint 检查 + 自动修复
npm run lint

# StyleLint CSS 检查
npm run lint:css

# 完整验证（lint:all + test）
npm run validate

# 生产构建（webpack）
npm run build

# 代码格式化
npm run format
```

## Core Architecture Modules

### 1. 3D 场景引擎 — `main.js`

前端入口，3300+ 行。负责 Three.js 场景初始化、WebGL/WebXR 检测、OrbitControls 相机控制、GLB/STL 模型加载、爆炸动画插值、乐高砖块拼接、AR 会话管理。所有用户交互与 UI 状态在此汇聚。

### 2. Node.js 后端 — `server.js` + `src/server-utils.js` + `src/body.js` + `src/logger.js`

零外部依赖的 HTTP 服务器（仅用 Node 内置模块）。关键端点：
- `POST /api/split` — 接收 GLB，调用 Blender CLI 拆解，返回二进制 GLB + manifest
- `POST /api/ai-paint` — AI 提示词生成 3D 模型
- `POST /api/image-to-3d` — 图片转 3D（本地 TripoSR / 云端 Meshy·Tripo·Hyper3D）
- `GET /api/health` — Blender 健康检查
- `GET /api/assembly/sequence` — 装配拆解顺序
- `GET /api/assembly/analysis` — 装配分析

### 3. 数据与步骤定义 — `src/quest3-data.js` + `src/quest3-steps.js`

纯数据模块，无副作用。`quest3-data.js` 存放 Quest 3 硬件规格与部件颜色/材质/位置定义；`quest3-steps.js` 定义分步骤拆解教学方案（步骤名、包含部件、所需工具、描述文案）。

### 4. 几何体拆分与材质 — `src/geometry-split.js` + `src/lego-materials.js`

纯函数模块。`geometry-split.js` 实现面提取、连通分量拆分、材质分组拆分、空间拆分（依赖 `src/utils.js` 的 UnionFind）；`lego-materials.js` 定义原生/乐高两套 THREE 材质及映射。

### 5. AI 提供商与图片转 3D — `src/providers/image-to-3d.js` + `src/provider-models.js`

云端 3D 生成适配层。封装 Meshy、Tripo(Triple 3D)、Hyper3D(Rodin) 的 REST API 调用，输入图片 base64 返回 `{ glbBuffer, manifest }`。`provider-models.js` 维护各提供商的默认模型列表。

## Coding Conventions

- **模块系统**: ES Modules（`import`/`export`），`"type": "module"` in package.json
- **缩进**: 2 空格，禁止 Tab
- **引号**: 双引号（`"`），字符串中避免单引号
- **分号**: 必须
- **行尾**: Unix LF
- **printWidth**: 100 字符（Prettier）
- **trailingComma**: `es5`
- **import 顺序**: builtin → external → internal → parent → sibling → index，分组间空行，组内字母序（ESLint `import/order`）
- **命名**: camelCase 变量/函数，PascalCase 类/构造器
- **CSS**: 2 空格缩进，BEM 可选，CSS 变量优先
- **Git 提交**: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`, `test(scope):`

## Python Scripts — Special Requirements

所有 Blender Python 脚本（`blender_*.py`、`scripts/blender_*.py`、`scripts/mcp_server.py`）遵循以下约定：

1. **运行方式**: 由 `server.js` 以 `blender --background --python <script>.py -- <args>` 调用，不直接执行
2. **参数解析**: 使用 `sys.argv` 在 `--` 分隔符后手动解析，不依赖 argparse（Blender 后台模式兼容性）
3. **日志输出**: 必须 `print(msg, flush=True)` 并 `sys.stdout.flush()`，因为 Blender 后台模式会缓冲 stdout
4. **版本兼容**: 需兼容 Blender 4.x 和 5.x，通过 `bpy.app.version` 检测并做条件分支
5. **错误处理**: 用 `try/except + traceback.print_exc()` 捕获所有异常，确保非零退出码通知调用方
6. **零外部依赖**: 除 `bpy`/`bmesh`/`mathutils`（Blender 内置）外不假定任何 pip 包可用；TripoSR 等可选依赖仅在专用 venv 中
7. **临时文件**: 在系统 temp 目录下创建，由 `server.js` 的 TTL 清理机制兜底（1 小时过期）
