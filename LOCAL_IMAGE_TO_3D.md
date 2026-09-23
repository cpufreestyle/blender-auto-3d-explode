# 本地图片转 3D（离线 · 真重建）

`/api/image-to-3d` 的本地路线有两条，均不联网、不消耗任何云端额度：

1. **零依赖可拆解重建（默认）** — `blender_image_to_3d.py`：调用本机已安装的 Blender，把单张图片变成带贴图的可拆解模型，默认切成 3×3 个独立网格（拼合即还原、爆炸即分离）。三种重建模式见下方「零依赖重建的三种模式」。
2. **TripoSR 单图真重建（可选）** — `scripts/triposr_infer.py`：从单张 RGB 图推断 triplane → marching cubes 提取带体积 / 背面的水密网格 → 导出 GLB。需预置权重（见下），仅当显式勾选「真重建(TripoSR)」且权重就绪时启用；单网格、不可拆解。

## 已预置的离线依赖

- `external/TripoSR/local_model/`
  - `config.yaml` — 模型结构配置
  - `model.ckpt` — TripoSR 主权重（约 1.6 GB）
- DINO 图像编码器 `facebook/dino-vitb16` — 已缓存到 HuggingFace 本地缓存（`~/.cache/huggingface/hub`），离线加载。

> 只要以上两项就位，`server.js` 检测到 `local_model/model.ckpt` 存在时，会自动以 `--model` 指向本地目录，**不再联网下载**。

## 如何触发

### Web 端
1. 首页点「🧊 图片转3D」，先上传一张参考图。
2. 在「部署方式」下拉里选择 **本地**（默认即本地）。
3. 点「🧊 图片转3D」，状态栏显示「正在用本地 TripoSR 离线重建 3D（无需额度 / 不联网）…」。
4. 约 1–3 分钟（CPU 首跑约 45 秒）后自动加载 GLB 到场景。

### API
```bash
curl -X POST http://localhost:3001/api/image-to-3d \
  -H "Content-Type: application/json" \
  -d '{"image":"<base64 data url>","deploy":"local"}' \
  --output out.glb
```
响应头 `X-Manifest` 含 `{ "engine":"triposr", ... }`，`X-Total-Parts` 为部件数。

## 零依赖重建的三种模式（`blender_image_to_3d.py`）

| 模式 | 原理 | 几何 | 适用 |
| --- | --- | --- | --- |
| `depth`（默认） | 多线索单目深度先验：大气透视（雾霾致远景变亮）/ 地面垂直（画面下方更近）/ 中心主体 / 局部细节，鲁棒百分位归一 + 边缘感知平滑 | 高度场 + 侧墙 + 底盖（默认厚度 0.08），背面也是实体 | 大多数照片，遮挡关系最接近真实 |
| `relief` | 按像素亮度挤出高度图 | 单面薄片 | 教学演示「亮度 -> 起伏」 |
| `voxel` | 亮度 8 级量化成像素块 | 单面薄片 | 像素风 / 乐高风示意 |

manifest 的 `depth_source` 字段记录实际使用的深度来源（`monocular-prior-v1` = 深度先验；`luminance` / `luminance-quantized` = 亮度法，含 numpy 不可用时的自动降级）。`relief` / `voxel` 需要传 `--thickness` 才会加厚；`depth` 默认就有厚度。

## 与 TripoSR 真重建的区别

`blender_image_to_3d.py` 是 2.5D 假 3D（按像素亮度/深度先验挤出薄板或厚板，背面的凹凸是正面的镜像挤出，并非真实背面）。TripoSR 是**前馈单图真重建**，输出带真实背面与体积的水密网格，二者完全不同；前者零依赖、天生可拆解，后者需要 GPU/权重、单网格。

## 排错
- **本地重建失败 / 长期无响应**：确认 `external/TripoSR/local_model/model.ckpt` 存在且完整（约 1.6 GB）；确认 `~/.cache/huggingface/hub/models--facebook--dino-vitb16` 存在。
- **想重建更精细**：本地模式下可调整 marching cubes 分辨率（256 默认；更高更精细但更慢）。
- **重新拉取 / 在别的机器复现离线环境**：运行仓库根目录的一键脚本 `setup-local-weights.py`（自动探测项目根目录，断点续传，可走系统代理或 `--mirror` 镜像）：
  ```bash
  # 预置全部（TripoSR 权重 + DINO tokenizer）
  python setup-local-weights.py
  # 受限网络走镜像：python setup-local-weights.py --mirror
  # 显式代理：         set HF_PROXY=http://127.0.0.1:7897 && python setup-local-weights.py
  ```
  旧的 `dl_hf.py` / `dl_dino.py` 仍保留，但已硬编码本机路径与代理，不建议在别处直接使用。

## 离线验证记录
- 直接推理：`scripts/triposr_infer.py --model external/TripoSR/local_model --image <图>` → 产出 GLB（约 2.1 MB）。
- 端到端：`POST /api/image-to-3d deploy=local` → `HTTP 200`，`manifest.engine=triposr`，产出 GLB（约 3.2 MB），全程 `HF_HUB_OFFLINE=1` 纯离线。
