# Blender MCP 开源项目结合设计

> 状态：设计草案（待评审）
> 目标：借鉴主流开源 Blender MCP 项目的强项，补强本项目的「模型生成」与「灵活拆解」能力，同时保留本项目独有的装配/拆解（爆炸视图）优势。

## 1. 背景与现状

### 1.1 本项目已有的能力

- **自研 Blender MCP addon**（`scripts/blender_mcp_addon.py`，TCP 9876，行式 JSON）：
  - `analyze_assembly` — 装配/干涉/可制造性分析
  - `get_assembly_sequence` — 拆解顺序（distance / size / hierarchy）
  - Poly Haven 资产下载、模型导入、纹理/材质处理
- **拆解后端**（`server.js` → `runBlenderSplit` → `blender_split_glb.py`）：材质分离 / 断开几何体 / 微小部件合并 / Quest3 混合拆解。
- **图片转3D 提供方**（`src/providers/image-to-3d.js`）：Meshy / Tripo / **Hyper3D Rodin**（仅 image-to-3d，无 text-to-3d）。
- **AI 绘画**（`blender_ai_paint.py`）：关键词模板 + 乐高兜底，真实几何体生成器 `create_airplane` 等（v3.2.6 修复派发）。

### 1.2 主流开源 Blender MCP 项目调研

| 项目 | Stars | 核心能力 | 与本项目的互补点 |
| --- | --- | --- | --- |
| **ahujasid/blender-mcp** | 25.4k | `execute_blender_code`、`Poly Haven`、`Sketchfab`、Hyper3D Rodin **文生3D**、视口截图、场景查询 | 文生3D 资源 + LLM 自由代码通道 |
| **Blender 官方 lab/blender_mcp** | 官方 | 自然语言桥接 Python API、场景分析/重命名/文档 | 官方维护、长期可靠 |
| **harveyxiacn / emeryporter 等** | 新兴 | 轻量 MCP 实现 | 架构参考 |

**关键洞察**：开源项目**普遍不含「拆解/爆炸视图」**，而本项目自研 addon 已具备 `analyze_assembly` + `get_assembly_sequence`，是差异化优势。因此结合方向是**用开源长板补本项目短板**，而非替换。

## 2. 目标

- 提升「模型生成」质量与多样性：接入开源生态的**文本/图片文生3D**（Hyper3D Rodin 等），让「生成飞机」这类需求不再仅依赖关键词模板。
- 增强拆解灵活性：给自研 addon 增加受控的 `execute_blender_code` 通道，使高级用户/AI 能对任意模型做自定义分离。
- 复用本项目独有的拆解流水线处理外部生成的模型（导入 → `analyze_assembly` → 爆炸视图）。

## 3. 方案（按性价比排序）

### 方案 A — 文本/文生3D 接入（高价值，优先）

- **来源**：开源 `blender-mcp` 已集成 Hyper3D Rodin text-to-3d。本项目 `src/providers/image-to-3d.js` 已有 Hyper3D **image-to-3d** 实现，可对称扩展 `runHyper3DTextTo3D`。
- **流程**：前端输入自然语言 → `server.js` `/api/text-to-3d` → `runHyper3DTextTo3D`（创建任务 → 轮询 → 下载 GLB）→ 落盘 `models/generated/` → 调用现有 `runBlenderSplit` 拆解 → 返回 manifest。
- **复用**：`blender_ai_paint.py` 的关键词匹配可保留为「离线兜底」，云端文生3D 为「在线主打」。
- **前端**：`src/panels/ai-paint-panel.js` 增加「文生3D」模式切换（文本 vs 图片）。

### 方案 B — 自研 addon 增加受控 `execute_blender_code`（中价值，低风险增强）

- 新增 MCP 命令类型 `execute_code`：`params.code` 经 Blender 执行并返回结果。
- **安全围栏（必须）**：
  - 默认关闭，环境变量 `MCP_ALLOW_CODE=1` 才启用；
  - 代码提交前在 UI 展示并需用户确认（类似开源项目的「操作前保存」警告）；
  - 超时限制（如 60s），`bpy.ops.wm.save_as_mainfile` 等危险操作白名单/黑名单；
  - 记录执行日志供审计。
- 价值：对齐开源生态灵活性，支持「按自定义规则拆解」「参数化生成」。

### 方案 C — Poly Haven / 视口截图复用（低价值，可选）

- 视口截图：addon 增加 `render_viewport` 命令，返回 PNG base64，用于前端缩略图预览。
- 本项目 addon 已有 Poly Haven，无需重复。

## 4. 命令映射（目标态）

| 能力 | 开源 blender-mcp | 本项目（目标） | 备注 |
| --- | --- | --- | --- |
| 文生3D | Hyper3D Rodin text-to-3d | `runHyper3DTextTo3D` + `/api/text-to-3d` | 新增（方案 A） |
| 图生3D | Hyper3D/Meshy/Tripo | 已有 `image-to-3d.js` | 复用 |
| 拆解顺序 | 无 | `get_assembly_sequence` | 本项目优势 |
| 装配分析 | 无 | `analyze_assembly` | 本项目优势 |
| 自由代码 | `execute_blender_code` | `execute_code`（受控） | 新增（方案 B） |
| 资产下载 | Poly Haven / Sketchfab | Poly Haven（已有） | 复用 |

## 5. 安全考量

- `execute_code` 属任意代码执行，必须默认关闭 + 显式确认 + 超时 + 审计日志（开源官方亦警告无防护执行风险）。
- 云端文生3D 的 API Key 仅经环境变量传递（`VLM_API_KEY` 模式已验证），不出现在命令行。
- 外部生成的 GLB 须经过现有 `MAX_FILE_SIZE` 与 multipart 校验后再进入拆解流程。

## 6. 明确不做（Non-Goals）

- **不替换**自研 MCP addon：其 `analyze_assembly` / `get_assembly_sequence` 是核心壁垒，开源项目无对应能力。
- **不引入 LLM 自动改写拆解脚本**：避免不可控的代码执行面，拆解逻辑仍由 `blender_split_glb.py` 主导。
- **不接入 Sketchfab 下载**（版权/合规复杂），保持 Poly Haven 即可。
- **不做 Blender 官方 lab MCP 的全量对接**：其定位为文档/重命名/分析，与本项目的「生成+拆解」目标重叠度低。

## 7. 实施里程碑（建议）

1. **M1（方案 A）**：`runHyper3DTextTo3D` + `/api/text-to-3d` + 前端文生3D 模式；复用现有拆解。
2. **M2（方案 B）**：addon `execute_code` 受控通道 + 安全围栏 + 日志。
3. **M3（可选）**：视口截图缩略图预览。

## 8. 验证

- 单元/provider 测试：`tests/provider-test.mjs` 已有 mock fetch，可对称补 `runHyper3DTextTo3D` 成功/缺 Key/失败路径。
- 派发测试：`tests/ai_paint_test.py` 覆盖关键词兜底仍生效。
- 端到端：本地启动 `server.js` + Blender，前端硬刷新后实测文生3D → 拆解全流程。
