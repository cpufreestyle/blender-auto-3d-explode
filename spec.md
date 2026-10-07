# Blender Auto 3D Explode — 项目规格 (spec.md)

> 本文件是「实现的事实契约」：描述当前代码**应当**具备的行为与可复现的验证方式。
> 事实优先级：`main.js` / `server.js` / `src/` 源码 > `tests/` > 本文件 > `README.md` / `DEVELOPER_GUIDE.md`（仅作介绍）。
> 任何行为变更必须同步更新本文件与 `harness.md`；`harness.md` 记录最近一次核验结论。
> 冲突时以本文件为准，并由 `harness.md` §6 的 Drift 台账记录历史偏差。
>
> 最近核验：2026-10-07（HEAD `e8fb32e`，v3.3.3）

## 1. 目标与范围

基于 Three.js 的交互式 3D 拆解教学工具：加载 / AI 生成模型 → 爆炸视图动画 → 分步骤拆解教学 → WebXR AR 预览。

- 运行形态：纯静态前端 + 零外部依赖的 Node HTTP 服务（`server.js`，仅用 Node 内置模块），
  Blender 以子进程方式被调用。
- 代码边界：`main.js` 是前端应用外壳（681 行）；`src/` 放可单测的纯函数与工厂模块；
  `server.js` 只做启动引导 + 路由分发；Blender 脚本在仓库根与 `scripts/`、`blender_scripts/`。
- 非目标：多用户 / 鉴权 / 持久化数据库 / 任务队列。

## 2. 运行形态与进程契约

| 项 | 值 | 说明 |
|----|----|------|
| 后端端口 | `PORT`，默认 `3001` | `server.js` |
| 静态前端端口 | 默认 `3000` | `npm run dev`（`npx serve .`） |
| 身份端点 | `GET /api/identity` | 即时返回、**不 exec Blender、不碰磁盘**；供桌面启动器确认端口上是不是本服务 |
| 健康端点 | `GET /api/health` | 会 exec Blender，最长 10s，**不可**用作身份判定 |
| CORS 预检 | `OPTIONS *` → 204 | 空体 + CORS 头 |
| 未知路由 | 404 `{ error, path }` | 非 GET 的未匹配路径 |
| GET 兜底 | 静态文件服务 | 命中 `index.html` 等；MIME / 缓存 / gzip 在 `src/static-server.js` |

契约：

- 端口占用（`EADDRINUSE`）与权限（`EACCES`）必须打印可操作中文提示后 `process.exit(1)`。
- `uncaughtException` 记结构化日志后退出；`unhandledRejection` 只记录不退出。
- 启动时清理超过 1 小时的残留临时文件（启动 + 每小时）。

## 3. HTTP 接口契约

`server.js` 的路由分发表是唯一权威清单（`server.js` 约 303–333 行）。共 **16** 个端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | Blender 健康检查（exec `blender --version`） |
| GET | `/api/identity` | 服务身份标记（app 标记 + 版本 + PID） |
| GET | `/api/generated` | 已生成模型清单（`models/generated`） |
| POST | `/api/blender/launch` | 一键启动 Blender GUI |
| POST | `/api/split` | 接收 GLB，调用 Blender CLI 拆解，返回**二进制 GLB** + manifest 头 |
| POST | `/api/ai-paint` | 提示词生成 3D 模型 |
| POST | `/api/image-to-3d` | 图片转 3D（本地 TripoSR·深度 / 云端 Meshy·Tripo·Hyper3D / VLM） |
| POST | `/api/text-to-3d` | 文生 3D（Hyper3D） |
| GET | `/api/ai-config` | 读取 AI 配置 |
| POST | `/api/ai-config` | 保存 AI 配置（含校验） |
| POST | `/api/ai-test` | 测试 AI 提供商连通性 |
| POST | `/api/test-provider` | 探测指定提供商 |
| POST | `/api/gen-to-blender` | 云端生成 → 自动导入 Blender 实时场景 |
| GET | `/api/blender/export` | 从 Blender 导出对象 GLB（读回） |
| GET | `/api/assembly/sequence` | 装配拆解顺序（`?method=distance\|size\|hierarchy`） |
| GET | `/api/assembly/analysis` | 装配 / 干涉 / 可制造性分析（`?tolerance=0.001`） |

`/api/split` 契约（`src/routes-blender.js`）：

- 上传白名单：`.glb` / `.gltf` / `.stl` / `.obj`；大小上限 `MAX_FILE_SIZE = 150MB`（`src/server-utils.js`）。
- 成功返回二进制 GLB，并以 `X-Total-Parts` 头暴露部件数；manifest 以 **UTF-8** 解析（否则中文部件名乱码）。
- 产物写入系统临时目录，由 TTL 清理兜底。

## 4. 外部依赖契约

| 依赖 | 形态 | 缺失时行为 |
|------|------|------------|
| Blender CLI | 由 `BLENDER_PATH` 覆盖自动探测 | `/api/health` 报不可用；前端回退 JS 拆解；服务器仍运行 |
| `undici` | `package.json` 声明的运行依赖 | 缺失则后端启动即 `ERR_MODULE_NOT_FOUND` |
| 云端 3D 提供商 Key | `ai-config.json` / 请求体 | 未配置时报 400，不发起网络请求 |
| 本地 TripoSR venv + 权重 | 专用 venv | 未就绪时 local 模式走 `blender_image_to_3d.py`（默认 `depth`） |
| Blender MCP 宿主 | TCP `localhost:9876` | 装配分析降级 / 报错，不阻断启动 |

契约：

- 缺失外部依赖时**不得崩溃**：只读端点仍可响应，相关功能降级并给出明确错误。
- Blender 后台模式常因无关 addon 清理以非零码退出，**判定成功以产物是否产出为准**，不只看退出码。
- `scripts/blender_control.py` 与 `scripts/blender_api_server.py` 直接 `parse_args()` 读全量 `sys.argv`，
  不走 `--` 分隔（既有缺陷，见 `harness.md` §6 D2）。

## 5. 不变式（Invariants）

- **I1 零外部依赖的后端**：`server.js` 只 import Node 内置模块 + 本仓库模块；新增第三方运行依赖必须先改本节。
- **I2 拆解产物契约**：`/api/split` 成功必须返回二进制 GLB + `X-Total-Parts`；manifest 按 UTF-8 读。
- **I3 身份端点即时性**：`/api/identity` 不得 exec Blender、不得碰磁盘（否则桌面启动器认亲会被 10s 超时拖死）。
- **I4 vendor 镜像一致**：`vendor/three/` 必须与 `node_modules/three` 同步闭包逐字节一致，且 core `REVISION` 与 `package.json` 的 three 次版本号一致。
- **I5 版本键一致**：`index.html` 的静态资源版本键与 `package.json` 的 `version` 必须一致。
- **I6 死标记清零**：`index.html` 每个 id 都有消费者、`style.css` 每个 class 与 `@keyframes` 都有落点、根目录每个 `.css` 都被 link 加载。
- **I7 单飞 Blender**：后台 Blender 任务串行执行，任意时刻至多一个；GUI 开窗前先结束本服务拉起的上一个窗口。
- **I8 Python 脚本约定**：`blender --background --python x.py -- args`；参数在 `--` 后手动解析（不用 argparse）；
  日志 `print(..., flush=True)`；除 `bpy/bmesh/mathutils` 外零 pip 假设；兼容 Blender 4.x/5.x。

## 6. 验证矩阵（spec ↔ harness）

| 不变式 / 契约 | 验证手段 | 测试文件 |
|---------------|----------|----------|
| I3 身份端点 | `npm test`（桌面启动器 28 条断言） | `tests/desktop-launcher-test.mjs` |
| I4 vendor 镜像 | `npm test` | `tests/vendor-three-test.mjs` |
| I5 版本键一致 + I6 死标记 | `npm test`（id 数量 85 与版本键一致性均被钉住） | `tests/dead-markup-test.mjs` |
| I2 拆解产物 | `npm test` + 真机 Blender 冒烟 | `tests/blender-runner-test.mjs`、`scripts/ci_blender_smoke.py` |
| I7 单飞队列 | `npm test` | `tests/blender-runner-test.mjs` |
| 路由分发 | `npm test` | `tests/routes-generate-test.mjs`、`tests/routes-blender-test.mjs` |
| I8 Python 约定 + Blender 版本行为 | CI `python` + `blender-smoke` job | `tests/*_test.py`、`scripts/ci_blender_smoke.py` |
| 静态服务 MIME / 缓存 | `npm test` | `tests/static-server-test.mjs` |
| 前端 UI（真机） | `npm run smoke:ui`（4 条 CDP 冒烟） | `scripts/ci_*_ui_smoke.mjs` |

## 7. 已知缺口

- `main.js` 的应用外壳（事件监听引导、getState/setState 桥接、编排收尾）无直接单测，靠模块级单测 + 真机冒烟间接覆盖。
- `npm run test:e2e` 需手动起 `server` 与 Blender，**不在** `npm test` 链内（有意为之）。
- `scripts/blender_control.py` / `scripts/blender_api_server.py` 的 argparse 缺陷无回归测试（见 §4 与 `harness.md` D2）。
- 本文件中的行数 / 计数属「快照」，代码演进后会漂移；漂移处理见 `harness.md` §6。
