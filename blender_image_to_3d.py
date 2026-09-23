#!/usr/bin/env python3
"""
本地「图片转 3D」Blender 脚本（零外部依赖，离线可用）

由 server.js 以 `blender --background --python blender_image_to_3d.py -- --image <png> \
--output <glb> --manifest <json> [--resolution N] [--depth F] [--mode relief|voxel|depth] \
[--texture] [--tiles N] [--thickness F]` 方式调用。

三种重建模式：
- relief：亮度 -> z 高度图（单面薄片，历史默认行为）
- voxel ：亮度 8 级量化成像素块（单面薄片）
- depth ：多线索单目深度先验（大气透视 / 地面垂直 / 中心主体 / 局部细节，
          鲁棒百分位归一 + 边缘感知平滑），默认带真实厚度（侧墙 + 底盖），
          从背面看也是实体；numpy 不可用时自动退化为亮度高度图并在 manifest 标注。

默认把模型切成 tiles×tiles 个独立网格（带正确世界坐标，拼合即还原），
使生成的模型可像普通装配体一样爆炸/拆解；--tiles 1 则退化为单个网格。
"""

import bpy
import mathutils
import sys
import json
import os
import traceback

try:
    import numpy as np
except ImportError:  # Blender 未捆绑 numpy 的极端情况：depth 退化为亮度高度图
    np = None

# depth 模式的 manifest 标识：先验法 / 退化的亮度法
DEPTH_SOURCE_PRIOR = "monocular-prior-v1"
DEPTH_SOURCE_LUMA = "luminance"
DEPTH_SOURCE_LUMA_QUANTIZED = "luminance-quantized"

# 单目深度先验的各线索权重（和为 1）。大气透视最不可靠（亮物体也亮），权重最小。
CUE_WEIGHTS = {"haze": 0.15, "vertical": 0.25, "centre": 0.30, "detail": 0.30}


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    opts = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--image" and i + 1 < len(argv):
            opts["image"] = argv[i + 1]
            i += 2
        elif a == "--output" and i + 1 < len(argv):
            opts["output"] = argv[i + 1]
            i += 2
        elif a == "--manifest" and i + 1 < len(argv):
            opts["manifest"] = argv[i + 1]
            i += 2
        elif a == "--resolution" and i + 1 < len(argv):
            opts["resolution"] = int(argv[i + 1])
            i += 2
        elif a == "--depth" and i + 1 < len(argv):
            opts["depth"] = float(argv[i + 1])
            i += 2
        elif a == "--mode" and i + 1 < len(argv):
            opts["mode"] = argv[i + 1]
            i += 2
        elif a == "--texture":
            opts["texture"] = True
            i += 1
        elif a == "--tiles" and i + 1 < len(argv):
            opts["tiles"] = int(argv[i + 1])
            i += 2
        elif a == "--thickness" and i + 1 < len(argv):
            opts["thickness"] = float(argv[i + 1])
            i += 2
        else:
            i += 1
    return opts


def find_bsdf(mat):
    """安全查找 Principled BSDF 节点（跨 Blender 版本，按类型而非名称）。

    不再按名字兜底：节点可以被改名，按名字可能命中一个并非 Principled BSDF 的节点。
    """
    # Blender 5.x 起新建材质默认带节点树（use_nodes 属性 6.0 将移除），直接用 node_tree
    if mat.node_tree is None:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def sample_grid(img, resX, resY, channel):
    """把图片最近邻采样成 resY x resX 的网格（净色 channel：0=R 1=G 2=B 3=A）。

    Blender 的 img.pixels 是自下而上的行序，因此网格第 y 行取图像第 y 行：
    这样几何起伏与贴图 UV 的上下方向一致（此前 relief 用 (resY-1-y)，高度场
    相对贴图整体上下翻转，亮部 bumps 会出现在照片亮部的对面）。
    """
    W, H = img.size
    pixels = img.pixels  # 保持只读访问，避免把大图像素整块复制到 Python list
    grid = [[0.0] * resX for _ in range(resY)]
    for y in range(resY):
        py = int(round(y / (resY - 1) * (H - 1)))
        row_offset = py * W * 4
        for x in range(resX):
            px = int(round(x / (resX - 1) * (W - 1)))
            idx = row_offset + px * 4
            if channel == 3:
                grid[y][x] = pixels[idx + 3]
            else:
                r = pixels[idx]
                g = pixels[idx + 1]
                b = pixels[idx + 2]
                grid[y][x] = 0.299 * r + 0.587 * g + 0.114 * b
    return grid


def robust_scale(values, lo_pct=2.0, hi_pct=98.0):
    """鲁棒归一化到 [0,1]：用百分位代替 min/max，抵抗离群亮点/暗点。"""
    a = np.asarray(values, dtype=np.float32)
    amin = float(np.percentile(a, lo_pct))
    amax = float(np.percentile(a, hi_pct))
    if amax - amin < 1e-6:
        return np.zeros_like(a)
    return np.clip((a - amin) / (amax - amin), 0.0, 1.0)


def blur3(values):
    """3x3 均值模糊（边缘复制填充），用来抑制像素级噪声。"""
    a = np.asarray(values, dtype=np.float32)
    p = np.pad(a, 1, mode="edge")
    out = np.zeros_like(a)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            out += p[dy : dy + a.shape[0], dx : dx + a.shape[1]]
    return out / 9.0


def edge_aware_smooth(field, guide, iterations=48, lam=0.2, kappa=0.35):
    """梯度引导的边缘感知平滑（各向异性扩散的 Jacobi 迭代）。

    传导系数由 guide（亮度）梯度决定：图像边缘处几乎停止平滑，把深度场的
    阶跃留在原位；平坦区被抹平，去掉单目先验的高频噪声。kappa 以图像自身
    的强边缘幅度（梯度 p97）为尺度，因此对噪点多的照片同样稳健 —— 不会
    因为噪声小梯度就把整张图都判成"边缘"而完全不平滑。
    """
    f = np.array(field, dtype=np.float32)
    g = np.asarray(guide, dtype=np.float32)
    gy, gx = np.gradient(g)
    gm = np.hypot(gx, gy)
    ref = float(np.percentile(gm, 97.0))
    if ref < 1e-6:
        ref = 1.0
    cond = np.exp(-((gm / (kappa * ref)) ** 2)).astype(np.float32)
    # 四条边上的传导系数取两端最小值，避免深度跨越图像边缘渗透
    c_n = np.zeros_like(cond)
    c_n[1:, :] = np.minimum(cond[1:, :], cond[:-1, :])
    c_s = np.zeros_like(cond)
    c_s[:-1, :] = np.minimum(cond[:-1, :], cond[1:, :])
    c_w = np.zeros_like(cond)
    c_w[:, 1:] = np.minimum(cond[:, 1:], cond[:, :-1])
    c_e = np.zeros_like(cond)
    c_e[:, :-1] = np.minimum(cond[:, :-1], cond[:, 1:])
    for _ in range(iterations):
        d_n = np.zeros_like(f)
        d_n[1:, :] = f[:-1, :] - f[1:, :]
        d_s = np.zeros_like(f)
        d_s[:-1, :] = f[1:, :] - f[:-1, :]
        d_w = np.zeros_like(f)
        d_w[:, 1:] = f[:, :-1] - f[:, 1:]
        d_e = np.zeros_like(f)
        d_e[:, :-1] = f[:, 1:] - f[:, :-1]
        f = np.clip(f + lam * (c_n * d_n + c_s * d_s + c_w * d_w + c_e * d_e), 0.0, 1.0)
    return f


def estimate_depth(luma_grid, alpha_grid=None):
    """多线索单目深度先验：返回 (resY, resX) 的 [0,1] 深度场，1 = 近。

    四条线索各自鲁棒归一化后加权求和，再做边缘感知平滑，最后再次归一化：
    - 大气透视：雾霾让远景变亮，故越亮越远；
    - 地面垂直：相机通常略高于水平面，画面下方多是近处地面/主体底部；
    - 中心主体：居中对象比四角背景近（商品/人物照的强先验）；
    - 局部细节：纹理高频越密集通常越近（远景被大气低通滤波掉）。
    alpha_grid 非空时，透明背景被压平（深度 0），不参与起伏。
    """
    luma = np.asarray(luma_grid, dtype=np.float32)
    h, w = luma.shape
    yy, xx = np.mgrid[0:h, 0:w]

    haze = 1.0 - robust_scale(luma)
    vertical = 1.0 - (yy / max(h - 1, 1))
    dist = np.hypot(
        (yy - (h - 1) / 2.0) / max(h / 2.0, 1.0),
        (xx - (w - 1) / 2.0) / max(w / 2.0, 1.0),
    )
    centre = 1.0 - robust_scale(dist)
    # 细节线索先在 3x3 邻域平均：像素级噪声不该被当成"近处才有细节"
    gy, gx = np.gradient(blur3(luma))
    detail = robust_scale(np.hypot(gx, gy))

    combined = (
        CUE_WEIGHTS["haze"] * haze
        + CUE_WEIGHTS["vertical"] * vertical
        + CUE_WEIGHTS["centre"] * centre
        + CUE_WEIGHTS["detail"] * detail
    )
    depth = robust_scale(blur3(combined))
    depth = edge_aware_smooth(depth, robust_scale(blur3(luma)))
    depth = robust_scale(depth)
    if alpha_grid is not None:
        alpha = np.asarray(alpha_grid, dtype=np.float32)
        depth = depth * (alpha > 0.5)
    return np.clip(depth, 0.0, 1.0)


def tile_faces(front, back, x0, x1, y0, y1, wall_left, wall_right, wall_bottom, wall_top):
    """由顶点索引表生成一个 tile 的面列表。

    front: {(x, y): 顶点索引}（高度场表面）；back 为 None 时只生成前表面，
    即历史「单面薄片」行为。back 非空时补齐后表面与侧墙，绕序保证外法线朝外，
    GLB 导出后从背面看也是实体而非镂空薄片。x0..x1 / y0..y1 为闭区间顶点范围；
    侧墙按 wall_* 开关逐边加（实体模式下只加在整模型外轮廓，内部接缝不加）。
    """
    faces = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            faces.append(
                (front[(x, y)], front[(x + 1, y)], front[(x + 1, y + 1)], front[(x, y + 1)])
            )
    if back is None:
        return faces
    for y in range(y0, y1):
        for x in range(x0, x1):
            faces.append(
                (back[(x, y)], back[(x, y + 1)], back[(x + 1, y + 1)], back[(x + 1, y)])
            )
    if wall_bottom:
        for x in range(x0, x1):
            a, b = front[(x, y0)], front[(x + 1, y0)]
            c, d = back[(x + 1, y0)], back[(x, y0)]
            faces.append((a, d, c, b))  # 底边，法线 -y
    if wall_top:
        for x in range(x0, x1):
            a, b = front[(x, y1)], front[(x + 1, y1)]
            c, d = back[(x + 1, y1)], back[(x, y1)]
            faces.append((a, b, c, d))  # 顶边，法线 +y
    if wall_left:
        for y in range(y0, y1):
            a, b = front[(x0, y)], front[(x0, y + 1)]
            c, d = back[(x0, y + 1)], back[(x0, y)]
            faces.append((a, b, c, d))  # 左边，法线 -x
    if wall_right:
        for y in range(y0, y1):
            a, b = front[(x1, y)], front[(x1, y + 1)]
            c, d = back[(x1, y + 1)], back[(x1, y)]
            faces.append((a, d, c, b))  # 右边，法线 +x
    return faces


def main():
    opts = parse_args()
    image_path = opts.get("image")
    output = opts.get("output")
    manifest_path = opts.get("manifest")
    resolution = int(opts.get("resolution", 128))
    depth = float(opts.get("depth", 0.35))
    mode = opts.get("mode", "relief")
    use_texture = opts.get("texture", False)
    tiles = max(1, int(opts.get("tiles", 3)))
    # depth 模式默认给实体厚度；relief/voxel 保持 0（单面薄片），行为不变
    thickness = max(0.0, float(opts.get("thickness", 0.08 if mode == "depth" else 0.0)))

    if not image_path or not os.path.exists(image_path):
        raise SystemExit("缺少输入图片: " + str(image_path))
    if not output:
        raise SystemExit("缺少输出路径")
    if mode not in ("relief", "voxel", "depth"):
        raise SystemExit("不支持的 mode: " + str(mode) + "（应为 relief / voxel / depth）")

    # 确保输出目录存在
    out_dir = os.path.dirname(output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    # 清空场景
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    img = bpy.data.images.load(image_path)
    W, H = img.size

    aspect = (W / H) if H else 1.0
    if aspect >= 1:
        resX = max(2, resolution)
        resY = max(2, int(round(resolution / aspect)))
    else:
        resY = max(2, resolution)
        resX = max(2, int(round(resolution * aspect)))

    # 亮度/深度网格：voxel 模式在采样时顺手量化，避免二次遍历
    luma_grid = sample_grid(img, resX, resY, 0)
    if mode == "voxel":
        levels = 8
        luma_grid = [
            [round(v * (levels - 1)) / (levels - 1) for v in row] for row in luma_grid
        ]

    depth_source = DEPTH_SOURCE_LUMA_QUANTIZED if mode == "voxel" else DEPTH_SOURCE_LUMA
    height_grid = luma_grid
    if mode == "depth":
        if np is not None:
            alpha_grid = None
            if getattr(img, "channels", 3) >= 4:
                alpha_grid = sample_grid(img, resX, resY, 3)
            height_grid = estimate_depth(luma_grid, alpha_grid)
            depth_source = DEPTH_SOURCE_PRIOR
        else:
            print("WARN: numpy 不可用，depth 模式退化为亮度高度图", flush=True)

    # 先按网格计算所有顶点的全局坐标（px,py,pz）与 UV，供分块复用
    verts2d = []
    uv2d = []
    for y in range(resY):
        for x in range(resX):
            br = height_grid[y][x]
            px = (x / (resX - 1) - 0.5) * 2.0
            py = (y / (resY - 1) - 0.5) * 2.0 / aspect
            pz = br * depth
            verts2d.append((px, py, pz))
            uv2d.append((x / (resX - 1), y / (resY - 1)))

    # 分块数：切成 tiles×tiles 个独立网格，拼合即还原、爆炸即分离（便于拆解教学）
    part_order = []  # [(name, center_vector)]

    def build_tile(tr, tc, name):
        y0 = (tr * resY) // tiles
        x0 = (tc * resX) // tiles
        # 顶点闭区间上界：薄片模式保持历史半开区间 [y0, y1)；实体模式改为闭区间，
        # 且非末块多含一行/一列（下一块的首行/首列）—— 相邻两块表面严格相邻，
        # 接缝处不留一格沟壕；末块则收到网格最后一行/列
        solid = thickness > 0
        if solid:
            y1 = min(((tr + 1) * resY) // tiles, resY - 1)
            x1 = min(((tc + 1) * resX) // tiles, resX - 1)
            wall_bottom, wall_top = tr == 0, tr == tiles - 1
            wall_left, wall_right = tc == 0, tc == tiles - 1
        else:
            y1 = ((tr + 1) * resY) // tiles - 1
            x1 = ((tc + 1) * resX) // tiles - 1
            wall_bottom = wall_top = wall_left = wall_right = False
        verts = []
        uvs = []
        front = {}
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                front[(x, y)] = len(verts)
                verts.append(verts2d[y * resX + x])
                uvs.append(uv2d[y * resX + x])
        back = None
        if solid:
            back = {}
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    back[(x, y)] = len(verts)
                    px, py, pz = verts2d[y * resX + x]
                    verts.append((px, py, pz - thickness))
                    uvs.append(uv2d[y * resX + x])
        faces = tile_faces(
            front, back, x0, x1, y0, y1, wall_left, wall_right, wall_bottom, wall_top
        )
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        uv_layer = mesh.uv_layers.new(name="UVMap")
        for loop in mesh.loops:
            uv_layer.data[loop.index].uv = uvs[loop.vertex_index]
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        # 计算该块中心（只用前表面顶点，与单面模式保持一致，便于爆炸排序稳定）
        if front:
            c = mathutils.Vector((0.0, 0.0, 0.0))
            for (x, y) in front:
                c += mathutils.Vector(verts2d[y * resX + x])
            c /= len(front)
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

    created_objs = []
    if tiles == 1:
        obj, _ = build_tile(0, 0, "ImageRelief")
        created_objs.append(obj)
        part_order.append(("ImageRelief", mathutils.Vector((0, 0, 0))))
    else:
        for tr in range(tiles):
            for tc in range(tiles):
                name = f"Tile_{tr}_{tc}"
                obj, center = build_tile(tr, tc, name)
                created_objs.append(obj)
                part_order.append((name, center))

    for obj in created_objs:
        obj.select_set(True)
    if created_objs:
        bpy.context.view_layer.objects.active = created_objs[0]
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            pass
        for obj in created_objs:
            if obj.data.materials:
                obj.data.materials[0] = mat
            else:
                obj.data.materials.append(mat)

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
        "depth_source": depth_source,
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

    print(
        f"OK: image-to-3d generated -> {output} "
        f"({len(part_order)} parts, mode={mode}, depth_source={depth_source}, "
        f"thickness={thickness:.4f})"
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # 把完整 traceback 打到 stderr，便于 server 透传诊断
        traceback.print_exc()
        sys.exit(1)
