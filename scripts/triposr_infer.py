#!/usr/bin/env python3
"""
本地「单图转3D」真重建（TripoSR 包装，离线推理，无需云端 API）。

由 server.js 以如下方式调用：
  <venv-python> scripts/triposr_infer.py \
      --image <png> --output <glb> --manifest <json> \
      [--device auto|cpu|cuda] [--mc-resolution N] [--bake-texture] \
      [--texture-resolution N] [--remove-bg] [--foreground-ratio F] \
      [--triposr-dir DIR] [--model ID_OR_PATH] [--chunk-size N]

实现：调用 TripoSR 的 TSR 模型（基于 LRM 的前馈单图 3D 重建），从单张 RGB 图
推断 triplane 场景编码，再用 marching cubes 提取带纹理（顶点色或烘焙图集）的
水密网格，导出 GLB 并写出 manifest。

这是「真正的单图 3D 重建」（有体积 / 背面 / 多视角一致），区别于被替换掉的
亮度挤出浮雕（blender_image_to_3d.py 的 relief / voxel 模式）。
"""

import os
import sys
import json
import argparse
import traceback


def resolve_triposr_dir(explicit):
    if explicit:
        return os.path.abspath(explicit)
    env = os.environ.get("TRIPOSR_DIR")
    if env:
        return os.path.abspath(env)
    # 默认仓库根：<repo>/external/TripoSR
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "external", "TripoSR"))


def parse_args():
    p = argparse.ArgumentParser(description="TripoSR single-image 3D reconstruction (local)")
    p.add_argument("--image", required=True, help="输入图片路径 (png/jpg)")
    p.add_argument("--output", required=True, help="输出 GLB 路径")
    p.add_argument("--manifest", required=True, help="输出 manifest JSON 路径")
    p.add_argument("--device", default="auto", help="auto|cpu|cuda")
    p.add_argument("--mc-resolution", type=int, default=256, help="marching cubes 网格分辨率")
    p.add_argument("--bake-texture", action="store_true", help="烘焙纹理图集（默认用顶点色）")
    p.add_argument("--texture-resolution", type=int, default=2048, help="纹理图集分辨率")
    p.add_argument("--remove-bg", action="store_true", help="用 rembg 移除背景（依赖更重）")
    p.add_argument("--foreground-ratio", type=float, default=0.85, help="前景占图比例")
    p.add_argument("--triposr-dir", default=None, help="TripoSR 仓库根目录（含 tsr/ 包）")
    p.add_argument("--model", default="stabilityai/TripoSR", help="模型 ID 或本地路径")
    p.add_argument("--chunk-size", type=int, default=8192, help="表面提取分块大小")
    return p.parse_args()


def main():
    args = parse_args()
    triposr_dir = resolve_triposr_dir(args.triposr_dir)

    if not os.path.isdir(os.path.join(triposr_dir, "tsr")):
        raise SystemExit(
            "未找到 TripoSR 仓库（期望 " + os.path.join(triposr_dir, "tsr") + " 存在）。\n"
            "请先运行：bash scripts/setup_triposr.sh"
        )
    if triposr_dir not in sys.path:
        sys.path.insert(0, triposr_dir)

    import torch
    from PIL import Image
    from tsr.system import TSR
    from tsr.utils import remove_background, resize_foreground

    device = args.device
    if device == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print("INFO: device=" + device + ", triposr_dir=" + triposr_dir + ", model=" + args.model, flush=True)

    print("INFO: loading TripoSR model...", flush=True)
    model = TSR.from_pretrained(args.model, config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(args.chunk_size)
    model.to(device)

    if not os.path.exists(args.image):
        raise SystemExit("缺少输入图片: " + args.image)
    img = Image.open(args.image).convert("RGB")

    if args.remove_bg:
        try:
            img = remove_background(img, rembg_session="u2net")
            img = resize_foreground(img, args.foreground_ratio)
            print("INFO: background removed", flush=True)
        except Exception as e:
            print("WARN: remove_bg failed (" + str(e) + "), using original image", flush=True)

    print("INFO: running inference...", flush=True)
    with torch.no_grad():
        scene_codes = model([img], device=device)

    return_vertex_colors = not args.bake_texture
    print("INFO: extracting mesh (mc_res=" + str(args.mc_resolution) + ", bake=" + str(args.bake_texture) + ")...", flush=True)
    meshes = model.extract_mesh(scene_codes, return_vertex_colors, resolution=args.mc_resolution)

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)

    if args.bake_texture:
        try:
            from tsr.bake_texture import bake_texture
            import xatlas
            mesh = meshes[0]
            vmapping, indices, uvs, colors = bake_texture(
                mesh, model, scene_codes[0], texture_resolution=args.texture_resolution
            )
            xatlas.export(args.output, mesh.vertices, indices, uvs, mesh.vertex_normals)
            tex_path = os.path.splitext(args.output)[0] + "_texture.png"
            colors.save(tex_path)
            print("INFO: baked texture -> " + args.output + " + " + tex_path, flush=True)
        except Exception as e:
            print("WARN: bake_texture failed (" + str(e) + "), falling back to vertex colors", flush=True)
            meshes[0].export(args.output)
    else:
        meshes[0].export(args.output)

    if not os.path.exists(args.output):
        raise SystemExit("GLB 导出后文件不存在: " + args.output)

    # 计算几何中心，供前端爆炸/定位使用
    import trimesh
    center = [0.0, 0.0, 0.0]
    try:
        tm = trimesh.load(args.output, force="mesh")
        if hasattr(tm, "bounds") and tm.bounds is not None:
            b = tm.bounds
            center = [float((b[0][i] + b[1][i]) / 2.0) for i in range(3)]
    except Exception:
        pass

    manifest = {
        "total_parts": 1,
        "engine": "triposr",
        "parts": [
            {
                "name": "ReconstructedModel",
                "display_name": "重建模型",
                "type": "triposr",
                "center": [round(c, 4) for c in center],
            }
        ],
    }
    with open(args.manifest, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print("OK: triposr image-to-3d -> " + args.output, flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
