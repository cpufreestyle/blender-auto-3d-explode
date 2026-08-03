#!/usr/bin/env python3
"""
本地「文本转3D」真生成（Hunyuan3D-2 包装，离线推理，无需云端 API Key）。

由 server.js 以如下方式调用：
  <python> scripts/hunyuan3d_text_infer.py \
      --prompt "一架红色客机" --output <glb> --manifest <json> \
      [--device auto|cpu|cuda] [--hunyuan-dir DIR] [--steps N] [--model ID_OR_PATH]

实现：调用腾讯开源 Hunyuan3D-2 的官方 hy3dgen 包（Hunyuan3DGenerator），
传入自然语言 prompt，先生成参考图再重建为带纹理的水密网格，导出 GLB 并写 manifest。

免费前提：
  - 需自行安装：pip install hy3dgen  （会拉取 Hunyuan3D-2 权重）
  - text-to-3D 依赖 GPU（CUDA），在 CPU / Apple Silicon 上极慢或不支持，
    请用带 NVIDIA 显卡的机器运行。

这是「真正的文本到3D 生成」（有体积 / 多视角一致），与需要云端 Key 的 Hyper3D 路径互为补充：
server 端在无 Hyper3D Key 时自动回退到本脚本，实现零成本文生3D。
"""

import os
import sys
import json
import argparse
import traceback


def resolve_hunyuan_dir(explicit):
    if explicit:
        return os.path.abspath(explicit)
    env = os.environ.get("HUNYUAN3D_DIR")
    if env:
        return os.path.abspath(env)
    # 默认仓库根：<repo>/external/Hunyuan3D-2
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "external", "Hunyuan3D-2"))


def parse_args():
    p = argparse.ArgumentParser(description="Hunyuan3D-2 text-to-3D generation (local, free)")
    p.add_argument("--prompt", required=True, help="自然语言提示词，如 '一架红色客机'")
    p.add_argument("--output", required=True, help="输出 GLB 路径")
    p.add_argument("--manifest", required=True, help="输出 manifest JSON 路径")
    p.add_argument("--device", default="auto", help="auto|cpu|cuda")
    p.add_argument("--steps", type=int, default=50, help="去噪步数（越高越精细越慢）")
    p.add_argument("--hunyuan-dir", default=None, help="Hunyuan3D-2 仓库根目录（含 hy3dgen 包）")
    p.add_argument("--model", default="tencent/Hunyuan3D-2", help="模型 ID 或本地路径")
    return p.parse_args()


def main():
    args = parse_args()
    prompt = args.prompt.strip()
    if not prompt:
        raise SystemExit("错误：prompt 不能为空")

    # 按需把 Hunyuan3D-2 仓库加入 sys.path（若用本地克隆而非 pip 安装）
    hunyuan_dir = resolve_hunyuan_dir(args.hunyuan_dir)
    site = os.path.join(hunyuan_dir, "hy3dgen")
    if os.path.isdir(site) and site not in sys.path:
        sys.path.insert(0, hunyuan_dir)

    try:
        from hy3dgen import Hunyuan3DGenerator
    except Exception as e:
        raise SystemExit(
            "未找到 hy3dgen（Hunyuan3D-2）。请先安装：pip install hy3dgen\n"
            "若使用本地克隆，请设置 --hunyuan-dir 或环境变量 HUNYUAN3D_DIR。\n"
            f"原始错误: {e}"
        )

    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    print(f"  🌐 本地文生3D: prompt='{prompt}' model={args.model} device={device}", flush=True)

    generator = Hunyuan3DGenerator(model_name=args.model, device=device)

    # generate(prompt=...) 会先生成参考图再重建为 3D；返回网格对象列表
    meshes = generator.generate(prompt=prompt, steps=args.steps)

    if not meshes:
        raise SystemExit("Hunyuan3D-2 未返回任何网格")

    # 导出第一个网格为 GLB
    mesh = meshes[0]
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    if hasattr(mesh, "export"):
        mesh.export(args.output)
    else:
        raise SystemExit("网格对象不支持 export()")

    # 写出 manifest（与云端路径格式一致，frontend 可直接加载）
    manifest = {
        "total_parts": 1,
        "parts": [{"name": "Part_001", "display_name": prompt[:32], "semantic_source": "text"}],
        "model_center": [0, 0, 0],
        "model_size": [2, 2, 2],
        "engine": "hunyuan3d-local",
        "prompt": prompt,
    }
    with open(args.manifest, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"  ✅ 本地文生3D 完成: {args.output}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
