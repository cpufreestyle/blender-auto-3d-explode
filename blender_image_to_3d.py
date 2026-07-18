#!/usr/bin/env python3
"""
本地「图片转 3D」Blender 脚本（零外部依赖，离线可用）

由 server.js 以 `blender --background --python blender_image_to_3d.py -- --image <png> \
--output <glb> --manifest <json> [--resolution N] [--depth F] [--mode relief|voxel] \
[--texture] [--tiles N]`
方式调用。

实现：把输入图片按亮度挤出为高度图（relief），或量化成像素块（voxel），
生成带贴图（可选）的 GLB，并写出 manifest。不调用任何云端/本地推理服务。
默认把模型切成 tiles×tiles 个独立网格（带正确世界坐标，拼合即还原），
使生成的模型可像普通装配体一样爆炸/拆解；--tiles 1 则退化为单个网格。
"""

import bpy
import mathutils
import sys
import json
import os
import traceback


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    opts = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--image" and i + 1 < len(argv):
            opts["image"] = argv[i + 1]; i += 2
        elif a == "--output" and i + 1 < len(argv):
            opts["output"] = argv[i + 1]; i += 2
        elif a == "--manifest" and i + 1 < len(argv):
            opts["manifest"] = argv[i + 1]; i += 2
        elif a == "--resolution" and i + 1 < len(argv):
            opts["resolution"] = int(argv[i + 1]); i += 2
        elif a == "--depth" and i + 1 < len(argv):
            opts["depth"] = float(argv[i + 1]); i += 2
        elif a == "--mode" and i + 1 < len(argv):
            opts["mode"] = argv[i + 1]; i += 2
        elif a == "--texture":
            opts["texture"] = True; i += 1
        elif a == "--tiles" and i + 1 < len(argv):
            opts["tiles"] = int(argv[i + 1]); i += 2
        else:
            i += 1
    return opts


def find_bsdf(mat):
    """安全查找 Principled BSDF 节点（跨 Blender 版本，按类型而非名称）。"""
    if not mat.node_tree or not mat.node_tree.nodes:
        mat.use_nodes = True
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return mat.node_tree.nodes.get("Principled BSDF")


def main():
    opts = parse_args()
    image_path = opts.get("image")
    output = opts.get("output")
    manifest_path = opts.get("manifest")
    resolution = int(opts.get("resolution", 128))
    depth = float(opts.get("depth", 0.35))
    mode = opts.get("mode", "relief")
    use_texture = opts.get("texture", False)

    if not image_path or not os.path.exists(image_path):
        raise SystemExit("缺少输入图片: " + str(image_path))
    if not output:
        raise SystemExit("缺少输出路径")

    # 确保输出目录存在
    out_dir = os.path.dirname(output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    # 清空场景
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    img = bpy.data.images.load(image_path)
    W, H = img.size
    pixels = list(img.pixels)  # RGBA，长度 W*H*4，左下角为原点

    aspect = (W / H) if H else 1.0
    if aspect >= 1:
        resX = max(2, resolution)
        resY = max(2, int(round(resolution / aspect)))
    else:
        resY = max(2, resolution)
        resX = max(2, int(round(resolution * aspect)))

    def brightness_at(x, y):
        px = int(round(x / (resX - 1) * (W - 1)))
        py = int(round((resY - 1 - y) / (resY - 1) * (H - 1)))  # 翻转 Y 以匹配常规朝向
        idx = (py * W + px) * 4
        r, g, b = pixels[idx], pixels[idx + 1], pixels[idx + 2]
        return 0.299 * r + 0.587 * g + 0.114 * b  # 0..1

    # 先按网格计算所有顶点的全局坐标（px,py,pz）与 UV，供分块复用
    verts2d = []
    uv2d = []
    for y in range(resY):
        for x in range(resX):
            br = brightness_at(x, y)
            if mode == "voxel":
                levels = 8
                br = round(br * (levels - 1)) / (levels - 1)
            px = (x / (resX - 1) - 0.5) * 2.0
            py = (y / (resY - 1) - 0.5) * 2.0 / aspect
            pz = br * depth
            verts2d.append((px, py, pz))
            uv2d.append((x / (resX - 1), y / (resY - 1)))

    # 分块数：切成 tiles×tiles 个独立网格，拼合即还原、爆炸即分离（便于拆解教学）
    tiles = max(1, int(opts.get("tiles", 3)))
    part_order = []  # [(name, center_vector)]

    def build_tile(tr, tc, name):
        y0 = (tr * resY) // tiles
        y1 = ((tr + 1) * resY) // tiles
        x0 = (tc * resX) // tiles
        x1 = ((tc + 1) * resX) // tiles
        local = {}
        verts = []
        uvs = []
        for y in range(y0, y1):
            for x in range(x0, x1):
                local[(x, y)] = len(verts)
                verts.append(verts2d[y * resX + x])
                uvs.append(uv2d[y * resX + x])
        faces = []
        for y in range(y0, y1 - 1):
            for x in range(x0, x1 - 1):
                i0 = local[(x, y)]
                i1 = local[(x + 1, y)]
                i2 = local[(x + 1, y + 1)]
                i3 = local[(x, y + 1)]
                faces.append((i0, i1, i2, i3))
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        uv_layer = mesh.uv_layers.new(name="UVMap")
        for loop in mesh.loops:
            uv_layer.data[loop.index].uv = uvs[loop.vertex_index]
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        # 计算该块中心
        if verts:
            c = mathutils.Vector(verts[0])
            for v in verts[1:]:
                c += mathutils.Vector(v)
            c /= len(verts)
        else:
            c = mathutils.Vector((0, 0, 0))
        return obj, c

    # 材质（所有块共用）
    mat = bpy.data.materials.new("ImgReliefMat")
    bsdf = find_bsdf(mat)
    if use_texture and bsdf is not None:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = img
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    elif bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    else:
        # 极端兜底：无节点材料
        mat.diffuse_color = (0.8, 0.8, 0.8, 1.0)

    if tiles == 1:
        obj, _ = build_tile(0, 0, "ImageRelief")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            pass
        if obj.data.materials:
            obj.data.materials[0] = mat
        else:
            obj.data.materials.append(mat)
        part_order.append(("ImageRelief", mathutils.Vector((0, 0, 0))))
    else:
        for tr in range(tiles):
            for tc in range(tiles):
                name = f"Tile_{tr}_{tc}"
                obj, center = build_tile(tr, tc, name)
                bpy.context.view_layer.objects.active = obj
                obj.select_set(True)
                try:
                    bpy.ops.object.shade_smooth()
                except Exception:
                    pass
                if obj.data.materials:
                    obj.data.materials[0] = mat
                else:
                    obj.data.materials.append(mat)
                part_order.append((name, center))

    # 按"距模型中心降序（外层先拆）"排序，便于爆炸拆解时由外向内
    part_order.sort(key=lambda t: t[1].length, reverse=True)

    # 导出 GLB（GLB 模式自动内嵌贴图，无需 export_textures 参数）
    print("INFO: exporting GLB -> " + output)
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_materials="EXPORT",
    )

    if not os.path.exists(output):
        raise SystemExit("GLB 导出后文件不存在: " + output)

    manifest = {
        "total_parts": len(part_order),
        "parts": [
            {
                "name": n,
                "display_name": n,
                "type": mode,
                "center": [round(float(c.x), 4), round(float(c.y), 4), round(float(c.z), 4)],
            }
            for n, c in part_order
        ],
    }
    if manifest_path:
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"OK: image-to-3d generated -> {output} ({len(part_order)} parts)")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # 把完整 traceback 打到 stderr，便于 server 透传诊断
        traceback.print_exc()
        sys.exit(1)
