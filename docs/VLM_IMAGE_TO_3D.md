# 图片转 3D · VLM 视觉模型路线

用**视觉大模型（VLM）**"看"一张图片，自动生成 Blender Python 代码，在 Blender 中程序化重建出 3D 模型并导出 GLB。

> ⚠️ 这是**程序化几何近似重建**（用基础几何体拼出物体的主要形状/比例/配色），并非高保真的带纹理网格重建。追求照片级网格请使用本地 TripoSR / Replicate / Meshy / Tripo / Hyper3D 等真重建路线。

## 支持的视觉模型

| 模型 | provider 标识 | 接口 |
| --- | --- | --- |
| StepFun step-3.7-flash | `stepfun` | OpenAI 兼容 `/chat/completions` |
| Kimi kimi-k3 | `kimi` | OpenAI 兼容 `/chat/completions` |
| Claude claude-3-sonnet | `anthropic` | Anthropic 原生 Messages API |

在 `ai-config.html` 的「图片转 3D → 🤖 AI 视觉模型（VLM）」下拉中切换，保存后生效。

## 前置条件

1. **Blender 已启动**，且 Blender MCP 插件正在监听 `localhost:9876`（即 `scripts/blender_mcp_addon.py`）。
2. 对应 provider 的 **API Key 已配置**于 `ai-config.json`：
   - `stepfun.key` —— StepFun 平台 Key
   - `kimi.key` —— Kimi / Moonshot 平台 Key
   - `anthropic.key` —— Anthropic Key

## 使用方式

### 方式一：前端 UI（推荐）

1. 打开 `ai-config.html` → 切换到「图片转 3D」标签。
2. 选择 **🤖 AI 视觉模型（VLM）** 单选。
3. 在「视觉模型」下拉选择 StepFun / Kimi / Claude，点击「保存配置」。
4. 在 Quest 3 前端使用「图片转 3D」功能，选择 VLM 模式上传图片即可。

   请求会经 `server.js` 的 `vlm` 分支 → `runVLMImageTo3D` → 调用 `scripts/vlm_img_to_blender.py`。

### 方式二：命令行直接调用脚本

```bash
python3 scripts/vlm_img_to_blender.py \
  --provider stepfun \
  --model step-3.7-flash \
  --image path/to/your.png
```

- 不传 `--image` 时使用默认示例图（`external/TripoSR/examples/hamburger.png`）。
- 不传 `--model` 时回退到 `ai-config.json` 中该 provider 的 `model`，再回退到 `step-3.7-flash`。
- 成功后导出 GLB 到 `/tmp/vlm_img_to_3d.glb`，最终生成的 Blender 代码存档到 `scripts/_vlm_generated_blender.py`。

## 管线原理

1. 读取图片 → base64。
2. 调用视觉模型（多模态 Chat Completions / Messages），提示其输出**完整、可直接执行的 Blender Python 代码**（仅用 `bpy.ops.mesh.primitive_*` 基础几何体，所有新建对象名以 `GLM_VLM_` 开头）。
3. 通过 Blender MCP 插件 TCP（`localhost:9876`）在 Blender 内**沙箱执行**该代码。
4. 若执行报错，把错误信息**回灌视觉模型**让其修复并重生成（最多 `MAX_RETRIES=4` 次迭代，自愈常见 Blender API 不兼容问题）。
5. 成功后把场景中以 `GLM_VLM_` 开头的对象导出为 GLB。

## 配置参考（`ai-config.json`）

```json
{
  "vlm": { "provider": "stepfun", "model": "step-3.7-flash" },
  "stepfun": { "key": "sk-...", "model": "step-3.7-flash" },
  "kimi":    { "key": "sk-...", "model": "kimi-k3" },
  "anthropic": { "key": "sk-ant-...", "model": "claude-3-sonnet-20240229" }
}
```

各 provider 的 base_url 固定在脚本内：

- StepFun：`https://api.stepfun.com/v1`
- Kimi：`https://api.moonshot.cn/v1`
- Anthropic：`https://api.anthropic.com/v1`

## 已知局限

- 重建结果为**程序化近似**，细节与真实纹理有限。
- 依赖 Blender + MCP 插件实时运行；插件未启动会报连接错误。
- 视觉模型偶发生成不兼容的 Blender API 调用，靠自动修复循环自愈，极端情况下可能达到最大重试次数后失败（此时可换模型或调整图片）。

## 示例产物

- `scripts/_vlm_generated_blender.py` —— 一次 VLM 看图生成的汉堡模型代码样例。
