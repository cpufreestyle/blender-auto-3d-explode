# 架构治理迭代计划（Architecture Health Roadmap）

> 目标：降低 `server.js` / `main.js` 单体复杂度，消除重复，统一配置与发布流程，提升可维护性。
> 状态：持续更新。每次合并后回填「进度」。

## 现状（已核实）
- `server.js` 约 1850 行单体：手动路由 + 图片转3D 多厂商 + AI 配置 + Blender/MCP 编排。
- 图片转3D 三厂商（Meshy/Tripo/Hyper3D）轮询+鉴权逻辑已抽成公共 `pollTask` / `requireProviderKey`（N3 完成）。
- `server.js` 的 `parseMultipart`(188) 已委托 `src/server-utils.js` 的 `parseMultipartBuffer`(223)，属流式包装，非重复实现。
- 请求体解析三套：`parseMultipart`(188) / `readJSONBodyMax`(495) / `readJSONBody`(1399)。
- 版本号曾脱节：`package.json` `2.0.0` vs release `v3.2.3`（N2 已对齐）。
- release 流程曾手动 `gh` 导致误标 Latest（已纠正为 v3.2.3；后续统一走 `scripts/create_release.sh`）。

## Now — Sprint 1（已承诺）
| ID | 任务 | MoSCoW | 状态 |
|---|---|---|---|
| N1 | 统一 release 流程：发布走 `scripts/create_release.sh`（自带 `--latest`+工作区校验），弃用手敲 `gh` | Must | ✅ 已纠正 Latest→v3.2.3；脚本待后续增强 |
| N2 | `package.json` 版本号对齐到 `v3.2.3` 并推送 | Must | ✅ `84c9cbd` |
| N3 | 抽离图片转3D 三厂商公共逻辑（`pollTask` / `requireProviderKey`） | Must | ✅ `4bfd0db`（去重 ~66 行） |

## Next — Sprint 2–3（已规划）
| ID | 任务 | MoSCoW | 依赖 | 状态 |
|---|---|---|---|---|
| NE1 | `server.js` 模块化拆分：云端图片转3D 厂商函数抽至 `src/providers/image-to-3d.js`（纯函数，返回 `{glbBuffer, manifest}`）；`server.js` 降至 ~1530 行 | Should | N3 | ✅ 已完成 |
| NE2 | 复用 `src/server-utils.js`：移除并行实现，`server.js` 仅引入 `getCORSHeaders`/`cleanupOldTempFiles`/`MAX_FILE_SIZE` | Should | 无 | ✅ 已完成 |
| NE3 | 统一请求体解析：`src/body.js` 的 `readBody(req,{maxSize})` 按 Content-Type 分发 JSON/multipart，复用 `parseMultipartBuffer`，取代三套旧解析器 | Should | NE2 | ✅ 已完成 |
| NE4 | 配置 schema 化 + 模型单一来源：`src/provider-models.js` 抽模型清单，server 与 `ai-config.html` 共享；`handleAIConfigPost` 增加校验 | Should | 无 | ✅ `7c32679` |

## Later — Sprint 4+（方向性）
| ID | 任务 | MoSCoW | 状态 |
|---|---|---|---|
| L1 | 统一路由/中间件 + 错误响应 + 结构化日志（`wrap(handler)` 收敛 try/catch 与 `console.log`） | Could | ✅ `src/logger.js` + `wrap`/`respondError` 中间件 + 进程级异常守卫；`console.*` 重定向为结构化日志 |
| L2 | `main.js` 前端模块化（按 3D 视图/上传/配置面板/VLM 流程拆 ES module） | Could | 🟡 试点×2：① 几何体拆分纯函数迁入 `src/geometry-split.js`；② 材质/乐高外观系统迁入 `src/lego-materials.js`（`currentModelStyle`/`applyModelStyle` 保留 main.js）。`main.js` 持续减负、行为不变；剩余（视图/上传/配置/VLM 面板）因共享状态耦合 + 无法在此环境跑 Three.js 预览，放最后单独做 |
| L3 | 提升测试覆盖：provider 生成/预检函数单测（当前只能 HTTP 端到端） | Could | ✅ `tests/provider-test.mjs`（mock fetch，22 项全绿，无需真实 Key） |
| L4 | 依赖漏洞治理：`npm audit` 跟进（default 分支存在 high 级漏洞，见 GitHub Dependabot 告警） | Must(技术健康) | ✅ lockfile 已修（npm audit fix）；GitHub Dependabot 因缓存滞后仍显 3 high，以 lockfile 为准 |

## 依赖与风险
- **N3 → NE1**：先抽公共逻辑，再拆模块，避免拆出多份重复。
- **NE3 → NE2**：统一解析前先确认 `server-utils` 接口复用方式。
- **发布风险**：手动 `gh` 因上下文过期会把旧 release 误标 Latest；统一到脚本消除。
- **依赖审计限制**：本地 `npm audit` 经 npmmirror 镜像无法访问 security 接口；需用官方源或查看 GitHub Dependabot 告警。
- 容量：70% 功能 / 20% 技术健康 / 10% 缓冲；N3+NE2 属技术健康投入。

## 进度日志
- 2026-07-24：N2/N3 完成并推送；启动 NE1-NE4 + 依赖治理（用户指令「1 2 3」）。
- 2026-07-24：依赖 3 项 high 漏洞修复（npm audit fix，传递 devDeps）；NE1（providers 模块抽出）+ NE2 + NE3（统一请求体解析）完成，server.js 约 1854→1530 行，冒烟测试通过（/api/health、/api/ai-config 均 200）。NE4（模型清单单一来源）待做。
- 2026-07-24：L3 落地 — 新增 `tests/provider-test.mjs`，mock 全局 fetch 测试 `src/providers/image-to-3d.js` 的 Meshy/Tripo/Hyper3D 三个纯函数（成功路径返回 `{glbBuffer, manifest}`、缺失 Key 抛 `status=400`、失败状态上抛），22 项全绿且无真实网络请求；`package.json` 的 `test` 脚本已串联 `unit-test` + `provider-test`。
- 2026-07-24：L1 落地 — 新增 `src/logger.js` 结构化日志器（时间戳+级别+meta，`LOG_LEVEL` 过滤，写 stderr）；`server.js` 将 `console.*` 重定向到该 logger 统一全部日志；新增 `wrap(handler)` 中间件 + `respondError(res,err)` 统一错误信封（按 `err.status` 取码，默认 500，防连接挂起），并用 `wrap` 包裹 `createServer` 回调；追加进程级 `uncaughtException`/`unhandledRejection` 守卫。冒烟测试通过（/api/health、/api/ai-config=200，未知路由 404，日志为结构化输出）。
- 2026-07-24：L2 试点 — 抽取 `main.js` 几何体拆分纯函数（extractFacesToGeometry / splitByConnectedComponents / splitByMaterialGroups / splitSpatially / generatePartName）至 `src/geometry-split.js`（ES module，复用同一 three 实例与 `src/utils.js` 的 UnionFind/generatePartName）；`main.js` 删除原 5 个函数体并改为导入，`node --check` 与 `npm test`（22 项）均通过。`main.js` 减约 150 行，行为不变；因共享状态耦合且无法在此环境运行 Three.js 预览，完整前端拆分（视图/上传/配置/VLM 面板）留待最后单独做。
- 2026-07-24：L2 试点② — 抽出 `main.js` 材质/乐高外观系统（`materials` 常量 + `makeLegoMaterial`/`makeLegoGlass`/`legoMaterials`/`nativeToLego`/`brightenToLego`/`getLegoMaterialForMesh`）至 `src/lego-materials.js`；`currentModelStyle` 状态与 `applyModelStyle` 切换逻辑因需改写该状态而保留在 `main.js`。`node --check` 与 `npm test`（22 项）通过，main.js 进一步减负、行为不变。
