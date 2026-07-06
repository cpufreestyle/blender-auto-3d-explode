#!/usr/bin/env python3
"""
Blender AI 绘画脚本 — 根据提示词生成3D模型并导出 GLB + manifest

用法:
  blender --background --python blender_ai_paint.py -- --prompt "红色球体" --output output.glb --manifest manifest.json
"""

import bpy
import bmesh
import json
import sys
import os
import math
import traceback
from mathutils import Vector

# 全局图片特征（可选，由前端 Canvas 提取后传入）
IMAGE_FEATURES = None

# 确保输出立即刷新
def log(msg):
    print(msg, flush=True)
    sys.stdout.flush()


def clear_scene():
    """清空场景中所有对象、材质、网格"""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    for light in list(bpy.data.lights):
        bpy.data.lights.remove(light)
    for cam in list(bpy.data.cameras):
        bpy.data.cameras.remove(cam)


def make_mat(name, color, roughness=0.5, metallic=0.0, emission=None, emission_strength=0.0,
             clearcoat=0.0, clearcoat_roughness=0.03, sheen=0.0, alpha=1.0, ior=1.45):
    """创建增强版 Principled BSDF 材质（支持涂层、光泽、透明度、折射率）"""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*color, 1.0)
        bsdf.inputs['Roughness'].default_value = roughness
        if 'Metallic' in bsdf.inputs:
            bsdf.inputs['Metallic'].default_value = metallic
        # 发光
        if emission and 'Emission Color' in bsdf.inputs:
            bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
            if 'Emission Strength' in bsdf.inputs:
                bsdf.inputs['Emission Strength'].default_value = emission_strength
        elif emission and 'Emission' in bsdf.inputs:
            bsdf.inputs['Emission'].default_value = (*emission, 1.0)
            if 'Emission Strength' in bsdf.inputs:
                bsdf.inputs['Emission Strength'].default_value = emission_strength
        # 涂层（Clearcoat）— Blender 4.x/5.x 兼容
        for cc_key, cr_key in [('Coat Weight', 'Coat Roughness'),
                                ('Clearcoat', 'Clearcoat Roughness')]:
            if cc_key in bsdf.inputs and clearcoat > 0:
                bsdf.inputs[cc_key].default_value = clearcoat
                if cr_key in bsdf.inputs:
                    bsdf.inputs[cr_key].default_value = clearcoat_roughness
                break
        # 光泽（Sheen）— 用于织物、皮肤
        for sh_key in ['Sheen Weight', 'Sheen']:
            if sh_key in bsdf.inputs and sheen > 0:
                bsdf.inputs[sh_key].default_value = sheen
                break
        # 透明度
        if alpha < 1.0 and 'Alpha' in bsdf.inputs:
            bsdf.inputs['Alpha'].default_value = alpha
            mat.blend_method = 'BLEND'
        # 折射率
        if 'IOR' in bsdf.inputs:
            bsdf.inputs['IOR'].default_value = ior
    return mat


def add_obj(obj, name, mat, pos=None, rot=None, scale=None):
    """添加命名对象，赋予材质并平滑着色（pos/rot/scale 为 None 时保持当前值）"""
    obj.name = name
    if pos is not None:
        obj.location = pos
    if rot is not None:
        obj.rotation_euler = rot
    if scale is not None:
        obj.scale = scale
    if mat:
        obj.data.materials.append(mat)
    obj['ai_paint_part'] = name
    # 平滑着色
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()
    # 自动平滑法线（保留硬边）
    if hasattr(obj.data, 'use_auto_smooth'):
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(40)
    return obj


# ===== Blender 高级功能辅助函数 =====

def apply_subsurf(obj, levels=2, render_levels=3):
    """细分曲面修改器 — 使表面更平滑、有机"""
    mod = obj.modifiers.new(name='Subsurf', type='SUBSURF')
    mod.levels = levels
    mod.render_levels = render_levels
    return obj


def apply_bevel_mod(obj, width=0.02, segments=3):
    """倒角修改器 — 使边缘更圆滑"""
    mod = obj.modifiers.new(name='Bevel', type='BEVEL')
    mod.width = width
    mod.segments = segments
    return obj


def apply_solidify(obj, thickness=0.02):
    """实体化修改器 — 给薄面增加厚度"""
    mod = obj.modifiers.new(name='Solidify', type='SOLIDIFY')
    mod.thickness = thickness
    return obj


def apply_mirror(obj, axis='X'):
    """镜像修改器 — 对称复制"""
    mod = obj.modifiers.new(name='Mirror', type='MIRROR')
    mod.use_axis[0] = (axis == 'X')
    mod.use_axis[1] = (axis == 'Y')
    mod.use_axis[2] = (axis == 'Z')
    mod.use_clip = True
    return obj


def apply_array(obj, count=3, offset=(1.2, 0, 0)):
    """阵列修改器 — 重复排列"""
    mod = obj.modifiers.new(name='Array', type='ARRAY')
    mod.count = count
    mod.use_relative_offset = False
    mod.use_constant_offset = True
    mod.constant_offset_displace = offset
    return obj


def create_curve_tube(name, points, radius=0.05, mat=None, bevel_res=4):
    """通过贝塞尔曲线创建管道/线缆 — 适合管道、头发、电缆"""
    curve_data = bpy.data.curves.new(name=name + '_curve', type='CURVE')
    curve_data.dimensions = '3D'
    curve_data.bevel_depth = radius
    curve_data.bevel_resolution = bevel_res
    curve_data.use_fill_caps = True

    spline = curve_data.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for i, p in enumerate(points):
        bp = spline.bezier_points[i]
        bp.co = Vector(p)
        bp.handle_left_type = 'AUTO'
        bp.handle_right_type = 'AUTO'

    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    obj['ai_paint_part'] = name
    return obj


def taper_mesh(obj, axis='x', end='positive', scale=0.0):
    """使用 bmesh 对网格端点进行锥化（收尖）"""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()

    coords = [getattr(v.co, axis) for v in bm.verts]
    if not coords:
        bpy.ops.object.mode_set(mode='OBJECT')
        return obj

    span = max(coords) - min(coords)
    if end == 'positive':
        threshold = max(coords) - span * 0.15
        sel_verts = [v for v in bm.verts if getattr(v.co, axis) >= threshold]
    else:
        threshold = min(coords) + span * 0.15
        sel_verts = [v for v in bm.verts if getattr(v.co, axis) <= threshold]

    if axis == 'x':
        bmesh.ops.scale(bm, vec=(1, scale, scale), verts=sel_verts)
    elif axis == 'y':
        bmesh.ops.scale(bm, vec=(scale, 1, scale), verts=sel_verts)
    else:
        bmesh.ops.scale(bm, vec=(scale, scale, 1), verts=sel_verts)

    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


# ===== 更多 Blender 高级功能辅助函数 =====

def apply_boolean(target, cutter, operation='DIFFERENCE'):
    """布尔运算 — 在 target 上执行布尔操作（差集/并集/交集）"""
    mod = target.modifiers.new(name='Boolean', type='BOOLEAN')
    mod.operation = operation
    mod.object = cutter
    # 应用修改器
    bpy.ops.object.select_all(action='DESELECT')
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier='Boolean')
    # 删除切割体
    bpy.data.objects.remove(cutter, do_unlink=True)
    return target


def apply_displace(obj, strength=0.1, mid_level=0.5):
    """位移修改器 — 添加表面凹凸细节（肌肉纹理、皮肤质感）"""
    # 创建一个简单的噪声纹理
    tex = bpy.data.textures.new(name=f'{obj.name}_disp_tex', type='CLOUDS')
    tex.noise_scale = 0.5
    mod = obj.modifiers.new(name='Displace', type='DISPLACE')
    mod.texture = tex
    mod.strength = strength
    mod.mid_level = mid_level
    return obj


def apply_edge_split(obj, split_angle=40):
    """边线拆分修改器 — 保留硬边"""
    mod = obj.modifiers.new(name='EdgeSplit', type='EDGE_SPLIT')
    mod.split_angle = math.radians(split_angle)
    return obj


def apply_wireframe(obj, thickness=0.02):
    """线框修改器 — 将网格转换为线框结构"""
    mod = obj.modifiers.new(name='Wireframe', type='WIREFRAME')
    mod.thickness = thickness
    return obj


def apply_remesh(obj, voxel_size=0.05):
    """重网格化修改器 — 统一网格拓扑"""
    mod = obj.modifiers.new(name='Remesh', type='REMESH')
    if hasattr(mod, 'voxel_size'):
        mod.mode = 'VOXEL'
        mod.voxel_size = voxel_size
    elif hasattr(mod, 'octree_depth'):
        mod.mode = 'BLOCKS'
        mod.octree_depth = 5
    return obj


def create_cloth_cape(name, width=1.2, height=1.5, mat=None):
    """创建披风 — 平面 + 实体化 + 波浪变形（模拟布料）"""
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.scale = (width, height, 1)
    bpy.ops.object.transform_apply(scale=True)
    # 细分网格使布料更平滑
    for _ in range(3):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.subdivide()
        bpy.ops.object.mode_set(mode='OBJECT')
    # 波浪变形 — bmesh 顶点位移
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        # 底部波动更大
        wave = math.sin(v.co.x * 4) * 0.08 * (1 - v.co.y / height)
        v.co.z += wave
        # 整体后倾
        v.co.y -= abs(v.co.x) * 0.1
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    apply_solidify(obj, thickness=0.015)
    apply_subsurf(obj, levels=1)
    if mat:
        obj.data.materials.append(mat)
    obj['ai_paint_part'] = name
    obj.name = name
    return obj


def create_emblem(name, letter='S', radius=0.15, mat=None):
    """创建胸章 — 用文本+倒角+挤出制作3D标志"""
    bpy.ops.object.text_add(location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.data.body = letter
    obj.data.extrude = 0.03
    obj.data.bevel_depth = 0.01
    obj.data.bevel_resolution = 3
    obj.data.size = radius * 2
    # 转为网格
    bpy.ops.object.convert(target='MESH')
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    obj['ai_paint_part'] = name
    return obj


# ===== 模型生成器 =====

def create_red_sphere():
    """红色球体"""
    mat_red = make_mat('RedMat', (1.0, 0.1, 0.1), roughness=0.3)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=48, ring_count=24, location=(0, 0, 0))
    return [add_obj(bpy.context.active_object, '球体', mat_red)]


def create_basketball():
    """篮球"""
    mat_ball = make_mat('BasketballMat', (0.85, 0.35, 0.05), roughness=0.7)
    mat_line = make_mat('LineMat', (0.05, 0.05, 0.05), roughness=0.8)

    parts = []
    # 球体主体
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=48, ring_count=24, location=(0, 0, 0))
    parts.append(add_obj(bpy.context.active_object, '篮球主体', mat_ball))

    # 经线
    for i in range(4):
        angle = i * math.pi / 4
        bpy.ops.mesh.primitive_torus_add(
            major_radius=1.0, minor_radius=0.015,
            location=(0, 0, 0),
            rotation=(0, angle, 0)
        )
        parts.append(add_obj(bpy.context.active_object, f'经线{i+1}', mat_line))

    # 赤道线
    bpy.ops.mesh.primitive_torus_add(
        major_radius=1.0, minor_radius=0.015,
        location=(0, 0, 0),
        rotation=(math.pi / 2, 0, 0)
    )
    parts.append(add_obj(bpy.context.active_object, '赤道线', mat_line))

    return parts


def create_quest3():
    """Quest 3 VR 头显 — 15 个部件"""
    S = 0.5

    mat_white = make_mat('WhitePanel', (0.92, 0.92, 0.90), roughness=0.6)
    mat_black = make_mat('BlackBody', (0.08, 0.08, 0.09), roughness=0.7)
    mat_lens = make_mat('LensBlue', (0.12, 0.22, 0.42), roughness=0.2, metallic=0.8)
    mat_glass = make_mat('LensGlass', (0.05, 0.08, 0.15), roughness=0.05, metallic=0.9)
    mat_cam = make_mat('CameraBlack', (0.03, 0.03, 0.03), roughness=0.3, metallic=0.5)
    mat_strap = make_mat('StrapGray', (0.28, 0.28, 0.30), roughness=0.85)
    mat_foam = make_mat('FoamDark', (0.18, 0.18, 0.20), roughness=0.95)
    mat_pcb = make_mat('PCBGreen', (0.05, 0.35, 0.12), roughness=0.4)

    parts = []

    # 主机身
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.scale = (1.1 * S, 0.85 * S, 0.55 * S)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.modifier_add(type='BEVEL')
    obj.modifiers['Bevel'].width = 0.03
    obj.modifiers['Bevel'].segments = 4
    parts.append(add_obj(obj, '主机身', mat_black, (0, -0.47 * S, -0.06 * S)))

    # 前面板
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.scale = (1.05 * S, 0.75 * S, 0.08 * S)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.modifier_add(type='BEVEL')
    obj.modifiers['Bevel'].width = 0.02
    obj.modifiers['Bevel'].segments = 3
    parts.append(add_obj(obj, '前面板', mat_white, (0, -0.16 * S, 0.28 * S)))

    # 透镜 x2
    for side, x in [('左透镜', -0.35 * S), ('右透镜', 0.35 * S)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.18 * S, depth=0.06 * S, location=(x, 0.3 * S, 0.2 * S))
        obj = bpy.context.active_object
        obj.rotation_euler = (math.pi / 2, 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(add_obj(obj, side + '模组', mat_lens))
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.14 * S, location=(x, 0.33 * S, 0.2 * S))
        sphere = bpy.context.active_object
        sphere.scale = (1, 0.3, 1)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(sphere, side + '玻璃', mat_glass))

    # 摄像头 x4
    for i, (cx, cy) in enumerate([(-0.4, -0.05), (0.4, -0.05), (-0.15, -0.35), (0.15, -0.35)]):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.04 * S, depth=0.05 * S, location=(cx * S, cy * S, 0.34 * S))
        obj = bpy.context.active_object
        obj.rotation_euler = (math.pi / 2, 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(add_obj(obj, f'摄像头{i+1}', mat_cam))

    # 头带臂 x2
    for side, x in [('左头带臂', -0.95 * S), ('右头带臂', 0.95 * S)]:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, 0.1 * S, 0.0))
        obj = bpy.context.active_object
        obj.scale = (0.12 * S, 0.6 * S, 0.25 * S)
        bpy.ops.object.transform_apply(scale=True)
        bpy.ops.object.modifier_add(type='BEVEL')
        obj.modifiers['Bevel'].width = 0.02
        obj.modifiers['Bevel'].segments = 3
        parts.append(add_obj(obj, side, mat_strap))

    # 面罩海绵
    bpy.ops.mesh.primitive_torus_add(major_radius=0.5 * S, minor_radius=0.08 * S, location=(0, 0.35 * S, 0.15 * S))
    obj = bpy.context.active_object
    obj.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    obj.scale = (1.3, 0.8, 1)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '面罩海绵', mat_foam))

    # 头带
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.6 * S, 0.15 * S))
    obj = bpy.context.active_object
    obj.scale = (1.8 * S, 0.15 * S, 0.08 * S)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '头带', mat_strap))

    # 主板/显示屏
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.1 * S, 0.0))
    obj = bpy.context.active_object
    obj.scale = (0.9 * S, 0.7 * S, 0.04 * S)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '主板/显示屏', mat_pcb))

    return parts


def create_robot():
    """机器人 — 多部件"""
    mat_body = make_mat('RobotBody', (0.6, 0.6, 0.65), roughness=0.4, metallic=0.7)
    mat_dark = make_mat('RobotDark', (0.15, 0.15, 0.18), roughness=0.5, metallic=0.6)
    mat_eye = make_mat('RobotEye', (0.0, 0.8, 1.0), roughness=0.1, emission=(0.0, 0.8, 1.0), emission_strength=3.0)
    mat_joint = make_mat('RobotJoint', (0.3, 0.3, 0.32), roughness=0.3, metallic=0.9)

    parts = []

    # 头部
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 1.5, 0))
    obj = bpy.context.active_object
    obj.scale = (0.5, 0.4, 0.45)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.modifier_add(type='BEVEL')
    obj.modifiers['Bevel'].width = 0.05
    obj.modifiers['Bevel'].segments = 4
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '头部', mat_body))

    # 眼睛 x2
    for side, x in [('左眼', -0.15), ('右眼', 0.15)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.06, location=(x, 1.45, 0.2))
        parts.append(add_obj(bpy.context.active_object, side, mat_eye))

    # 颈部
    bpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=0.2, location=(0, 1.15, 0))
    obj = bpy.context.active_object
    obj.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(add_obj(obj, '颈部', mat_joint))

    # 躯干
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.5, 0))
    obj = bpy.context.active_object
    obj.scale = (0.6, 0.7, 0.35)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.modifier_add(type='BEVEL')
    obj.modifiers['Bevel'].width = 0.04
    obj.modifiers['Bevel'].segments = 3
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '躯干', mat_body))

    # 胸口指示灯
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=(0, 0.55, 0.25))
    parts.append(add_obj(bpy.context.active_object, '胸口指示灯', mat_eye))

    # 手臂 x2
    for side, x in [('左臂', -0.75), ('右臂', 0.75)]:
        # 肩膀
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.15, location=(x, 0.75, 0))
        parts.append(add_obj(bpy.context.active_object, side + '肩', mat_joint))
        # 上臂
        bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.4, location=(x, 0.4, 0))
        obj = bpy.context.active_object
        obj.rotation_euler = (0, 0, 0)
        parts.append(add_obj(obj, side + '上臂', mat_dark))
        # 肘
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.09, location=(x, 0.15, 0))
        parts.append(add_obj(bpy.context.active_object, side + '肘', mat_joint))
        # 前臂
        bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.35, location=(x, -0.1, 0))
        parts.append(add_obj(bpy.context.active_object, side + '前臂', mat_dark))
        # 手
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -0.35, 0))
        obj = bpy.context.active_object
        obj.scale = (0.12, 0.08, 0.15)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, side + '手', mat_body))

    # 腰部
    bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=0.15, location=(0, 0.05, 0))
    parts.append(add_obj(bpy.context.active_object, '腰部', mat_joint))

    # 腿 x2
    for side, x in [('左腿', -0.2), ('右腿', 0.2)]:
        # 大腿
        bpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=0.45, location=(x, -0.35, 0))
        parts.append(add_obj(bpy.context.active_object, side + '大腿', mat_dark))
        # 膝
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=(x, -0.6, 0))
        parts.append(add_obj(bpy.context.active_object, side + '膝', mat_joint))
        # 小腿
        bpy.ops.mesh.primitive_cylinder_add(radius=0.09, depth=0.4, location=(x, -0.85, 0))
        parts.append(add_obj(bpy.context.active_object, side + '小腿', mat_dark))
        # 脚
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -1.1, 0.05))
        obj = bpy.context.active_object
        obj.scale = (0.15, 0.08, 0.25)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, side + '脚', mat_body))

    return parts


def create_car():
    """汽车 — 多部件"""
    mat_body = make_mat('CarBody', (0.8, 0.1, 0.1), roughness=0.3, metallic=0.6)
    mat_glass = make_mat('CarGlass', (0.1, 0.1, 0.15), roughness=0.1, metallic=0.3)
    mat_wheel = make_mat('WheelBlack', (0.05, 0.05, 0.05), roughness=0.8)
    mat_hub = make_mat('HubSilver', (0.7, 0.7, 0.72), roughness=0.3, metallic=0.9)
    mat_light = make_mat('Headlight', (1.0, 0.95, 0.8), roughness=0.1, emission=(1.0, 0.95, 0.8), emission_strength=2.0)

    parts = []

    # 底盘
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.3))
    obj = bpy.context.active_object
    obj.scale = (2.0, 0.9, 0.15)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '底盘', mat_body))

    # 车身
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.65))
    obj = bpy.context.active_object
    obj.scale = (1.8, 0.85, 0.35)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.modifier_add(type='BEVEL')
    obj.modifiers['Bevel'].width = 0.05
    obj.modifiers['Bevel'].segments = 3
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '车身', mat_body))

    # 车顶
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.1, 0, 1.05))
    obj = bpy.context.active_object
    obj.scale = (1.0, 0.8, 0.3)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.modifier_add(type='BEVEL')
    obj.modifiers['Bevel'].width = 0.05
    obj.modifiers['Bevel'].segments = 3
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '车顶', mat_body))

    # 挡风玻璃
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.45, 0, 0.95))
    obj = bpy.context.active_object
    obj.scale = (0.5, 0.82, 0.3)
    obj.rotation_euler = (0, math.radians(-30), 0)
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    parts.append(add_obj(obj, '挡风玻璃', mat_glass))

    # 后窗
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.65, 0, 0.95))
    obj = bpy.context.active_object
    obj.scale = (0.4, 0.82, 0.28)
    obj.rotation_euler = (0, math.radians(35), 0)
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    parts.append(add_obj(obj, '后窗', mat_glass))

    # 侧窗 x2
    for side, y in [('左侧窗', 0.43), ('右侧窗', -0.43)]:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.1, y, 1.1))
        obj = bpy.context.active_object
        obj.scale = (0.9, 0.02, 0.2)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, side, mat_glass))

    # 大灯 x2
    for side, x in [('左大灯', 0.95), ('右大灯', 0.95)]:
        for i, y in enumerate([0.3, -0.3]):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=(x, y, 0.5))
            parts.append(add_obj(bpy.context.active_object, f'大灯{["左","右"][i]}', mat_light))

    # 车轮 x4
    wheel_positions = [
        ('左前轮', 0.7, 0.5),
        ('右前轮', 0.7, -0.5),
        ('左后轮', -0.7, 0.5),
        ('右后轮', -0.7, -0.5),
    ]
    for name, x, y in wheel_positions:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=0.15, location=(x, y, 0.2))
        obj = bpy.context.active_object
        obj.rotation_euler = (math.pi / 2, 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(add_obj(obj, name, mat_wheel))
        # 轮毂
        bpy.ops.mesh.primitive_cylinder_add(radius=0.15, depth=0.16, location=(x, y, 0.2))
        obj = bpy.context.active_object
        obj.rotation_euler = (math.pi / 2, 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(add_obj(obj, name + '轮毂', mat_hub))

    return parts


def create_house():
    """房屋 — 多部件"""
    mat_wall = make_mat('WallWhite', (0.9, 0.88, 0.82), roughness=0.8)
    mat_roof = make_mat('RoofRed', (0.6, 0.15, 0.1), roughness=0.7)
    mat_door = make_mat('DoorBrown', (0.35, 0.2, 0.1), roughness=0.6)
    mat_window = make_mat('WindowBlue', (0.3, 0.5, 0.7), roughness=0.2, metallic=0.3)
    mat_chimney = make_mat('ChimneyBrick', (0.5, 0.25, 0.15), roughness=0.8)
    mat_ground = make_mat('GroundGreen', (0.2, 0.5, 0.15), roughness=0.9)

    parts = []

    # 地面
    bpy.ops.mesh.primitive_plane_add(size=4, location=(0, 0, 0))
    parts.append(add_obj(bpy.context.active_object, '地面', mat_ground))

    # 墙壁 x4
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
    obj = bpy.context.active_object
    obj.scale = (1.5, 1.0, 1.0)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '墙体', mat_wall))

    # 屋顶（四面体）
    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=1.2, depth=0.8, location=(0, 0, 1.4))
    obj = bpy.context.active_object
    obj.rotation_euler = (0, 0, math.radians(45))
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(add_obj(obj, '屋顶', mat_roof))

    # 门
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.51, 0.35))
    obj = bpy.context.active_object
    obj.scale = (0.3, 0.02, 0.55)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '门', mat_door))

    # 窗户 x2
    for side, x in [('左窗', -0.4), ('右窗', 0.4)]:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, 0.51, 0.65))
        obj = bpy.context.active_object
        obj.scale = (0.25, 0.02, 0.25)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, side, mat_window))

    # 烟囱
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.4, -0.2, 1.5))
    obj = bpy.context.active_object
    obj.scale = (0.2, 0.2, 0.4)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '烟囱', mat_chimney))

    return parts


def create_character(gender='female'):
    """美女角色 — 使用细分曲面、曲线头发、五官细节等高级功能"""
    mat_skin = make_mat('Skin', (0.96, 0.82, 0.72), roughness=0.45, sheen=0.3, clearcoat=0.1)
    mat_hair = make_mat('Hair', (0.15, 0.08, 0.06), roughness=0.6, sheen=0.5)
    mat_lip = make_mat('Lip', (0.75, 0.25, 0.25), roughness=0.35, sheen=0.4)
    mat_eye_w = make_mat('EyeWhite', (0.95, 0.93, 0.9), roughness=0.3)
    mat_eye_i = make_mat('Iris', (0.2, 0.35, 0.55), roughness=0.15, clearcoat=0.8)
    mat_pupil = make_mat('Pupil', (0.02, 0.02, 0.02), roughness=0.2)
    mat_dress = make_mat('Dress', (0.7, 0.15, 0.35), roughness=0.5, sheen=0.3)
    mat_shoe = make_mat('Shoe', (0.12, 0.08, 0.1), roughness=0.4, clearcoat=0.3)
    mat_blush = make_mat('Blush', (0.9, 0.5, 0.5), roughness=0.6)

    parts = []

    # === 头部 — UV球 + 细分曲面 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, segments=32, ring_count=16, location=(0, 1.65, 0))
    obj = bpy.context.active_object
    obj.scale = (0.88, 1.05, 0.92)
    bpy.ops.object.transform_apply(scale=True)
    apply_subsurf(obj, levels=2)
    parts.append(add_obj(obj, '脸部', mat_skin))

    # === 头发主体 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.25, segments=32, ring_count=16, location=(0, 1.72, -0.02))
    obj = bpy.context.active_object
    obj.scale = (0.92, 0.85, 0.95)
    bpy.ops.object.transform_apply(scale=True)
    apply_subsurf(obj, levels=2)
    parts.append(add_obj(obj, '头发', mat_hair))

    # === 两侧发束 — 贝塞尔曲线管道 ===
    for side, x_dir in [('左发束', -1), ('右发束', 1)]:
        tube = create_curve_tube(side, [
            (x_dir * 0.18, 1.65, 0),
            (x_dir * 0.22, 1.5, 0.02),
            (x_dir * 0.2, 1.3, 0.05),
            (x_dir * 0.15, 1.1, 0.03),
        ], radius=0.04, mat=mat_hair, bevel_res=4)
        parts.append(tube)

    # === 后侧长发 — 曲线管道 ===
    tube = create_curve_tube('后发', [
        (0, 1.65, -0.18),
        (0.02, 1.5, -0.22),
        (0.01, 1.3, -0.25),
        (-0.01, 1.1, -0.23),
        (0, 0.95, -0.2),
    ], radius=0.05, mat=mat_hair, bevel_res=4)
    parts.append(tube)

    # === 刘海 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, segments=16, ring_count=8, location=(0, 1.78, 0.15))
    obj = bpy.context.active_object
    obj.scale = (1.5, 0.6, 0.7)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '刘海', mat_hair))

    # === 眼睛 — 白眼球 + 虹膜 + 瞳孔 ===
    for side, x in [('左眼', -0.07), ('右眼', 0.07)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, segments=16, ring_count=8, location=(x, 1.63, 0.18))
        parts.append(add_obj(bpy.context.active_object, side + '白', mat_eye_w))
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.022, segments=16, ring_count=8, location=(x, 1.625, 0.205))
        parts.append(add_obj(bpy.context.active_object, side + '虹膜', mat_eye_i))
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.012, segments=12, ring_count=6, location=(x, 1.63, 0.222))
        parts.append(add_obj(bpy.context.active_object, side + '瞳孔', mat_pupil))

    # === 鼻子 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.025, segments=12, ring_count=6, location=(0, 1.58, 0.21))
    obj = bpy.context.active_object
    obj.scale = (0.8, 1.2, 0.8)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '鼻子', mat_skin))

    # === 嘴唇 — 圆环 ===
    bpy.ops.mesh.primitive_torus_add(major_radius=0.04, minor_radius=0.012, location=(0, 1.52, 0.19))
    obj = bpy.context.active_object
    obj.scale = (1.5, 0.6, 1)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '嘴唇', mat_lip))

    # === 腮红 ===
    for side, x in [('左腮红', -0.12), ('右腮红', 0.12)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.03, segments=12, ring_count=6, location=(x, 1.55, 0.17))
        obj = bpy.context.active_object
        obj.scale = (1, 0.6, 0.3)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, side, mat_blush))

    # === 耳朵 ===
    for side, x in [('左耳', -0.19), ('右耳', 0.19)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, segments=12, ring_count=6, location=(x, 1.63, 0))
        obj = bpy.context.active_object
        obj.scale = (0.5, 1, 1.2)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, side, mat_skin))

    # === 颈部 ===
    bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=0.12, vertices=24, location=(0, 1.35, 0))
    obj = bpy.context.active_object
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '颈部', mat_skin))

    # === 躯干（连衣裙）— 立方体 + bmesh腰部收窄 + 细分 + 倒角 ===
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.95, 0))
    obj = bpy.context.active_object
    obj.scale = (0.32, 0.4, 0.18)
    bpy.ops.object.transform_apply(scale=True)
    # bmesh 使腰部收窄
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    mid_verts = [v for v in bm.verts if abs(v.co.y) < 0.05]
    bmesh.ops.scale(bm, vec=(0.75, 1, 0.8), verts=mid_verts)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    apply_subsurf(obj, levels=2)
    apply_bevel_mod(obj, width=0.02, segments=3)
    parts.append(add_obj(obj, '连衣裙', mat_dress))

    # === 胸部 ===
    for side, x in [('左胸', -0.1), ('右胸', 0.1)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, segments=16, ring_count=8, location=(x, 1.05, 0.12))
        obj = bpy.context.active_object
        obj.scale = (1, 0.8, 0.7)
        bpy.ops.object.transform_apply(scale=True)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, side, mat_dress))

    # === 手臂 x2 — 圆柱 + 细分 ===
    for side, x in [('左臂', -0.28), ('右臂', 0.28)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=0.45, vertices=20, location=(x, 0.9, 0))
        obj = bpy.context.active_object
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, side, mat_dress))
        # 手
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.05, segments=16, ring_count=8, location=(x, 0.6, 0))
        parts.append(add_obj(bpy.context.active_object, side + '手', mat_skin))

    # === 腿 x2 — 圆柱 + 锥化 + 细分 ===
    for side, x in [('左腿', -0.1), ('右腿', 0.1)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.55, vertices=20, location=(x, 0.3, 0))
        obj = bpy.context.active_object
        taper_mesh(obj, axis='y', end='negative', scale=0.6)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, side, mat_dress))
        # 鞋
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -0.02, 0.04))
        obj = bpy.context.active_object
        obj.scale = (0.08, 0.05, 0.18)
        bpy.ops.object.transform_apply(scale=True)
        apply_bevel_mod(obj, width=0.015, segments=2)
        parts.append(add_obj(obj, side + '鞋', mat_shoe))

    return parts


def create_rocket():
    """火箭 — 多部件"""
    mat_body = make_mat('RocketBody', (0.9, 0.9, 0.92), roughness=0.3, metallic=0.7)
    mat_tip = make_mat('RocketTip', (0.8, 0.1, 0.1), roughness=0.3)
    mat_window = make_mat('RocketWindow', (0.2, 0.5, 0.9), roughness=0.1, metallic=0.5)
    mat_fin = make_mat('RocketFin', (0.2, 0.2, 0.25), roughness=0.4, metallic=0.6)
    mat_flame = make_mat('Flame', (1.0, 0.5, 0.0), roughness=0.1, emission=(1.0, 0.5, 0.0), emission_strength=5.0)

    parts = []

    # 火箭主体
    bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.5, vertices=32, location=(0, 0.5, 0))
    obj = bpy.context.active_object
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '火箭主体', mat_body))

    # 尖头
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.3, depth=0.5, location=(0, 1.5, 0))
    parts.append(add_obj(bpy.context.active_object, '尖端', mat_tip))

    # 舷窗
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=(0, 0.8, 0.25))
    obj = bpy.context.active_object
    obj.scale = (1, 1, 0.3)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '舷窗', mat_window))

    # 尾翼 x3
    for i in range(3):
        angle = i * 2 * math.pi / 3
        x = math.cos(angle) * 0.35
        z = math.sin(angle) * 0.35
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -0.2, z))
        obj = bpy.context.active_object
        obj.scale = (0.02, 0.4, 0.25)
        obj.rotation_euler = (0, angle, 0)
        bpy.ops.object.transform_apply(scale=True, rotation=True)
        parts.append(add_obj(obj, f'尾翼{i+1}', mat_fin))

    # 火焰
    bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.2, depth=0.4, location=(0, -0.9, 0))
    obj = bpy.context.active_object
    obj.rotation_euler = (math.pi, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(add_obj(obj, '火焰', mat_flame))

    return parts


def create_airplane():
    """飞机 — 使用细分曲面、实体化、倒角、bmesh翼型等高级功能"""
    mat_fuselage = make_mat('Fuselage', (0.9, 0.9, 0.93), roughness=0.2, metallic=0.3, clearcoat=0.8)
    mat_wing = make_mat('Wing', (0.85, 0.85, 0.88), roughness=0.25, metallic=0.2, clearcoat=0.6)
    mat_engine = make_mat('Engine', (0.25, 0.25, 0.28), roughness=0.35, metallic=0.85)
    mat_prop = make_mat('Propeller', (0.08, 0.08, 0.1), roughness=0.4, metallic=0.4)
    mat_window = make_mat('CabinWindow', (0.2, 0.4, 0.65), roughness=0.1, clearcoat=1.0, metallic=0.3)
    mat_cockpit = make_mat('CockpitGlass', (0.04, 0.08, 0.18), roughness=0.05, metallic=0.8, clearcoat=1.0)
    mat_tail = make_mat('TailRed', (0.75, 0.12, 0.1), roughness=0.3, metallic=0.2)
    mat_light_r = make_mat('NavLightR', (1.0, 0.1, 0.1), roughness=0.1, emission=(1.0, 0.1, 0.1), emission_strength=4.0)
    mat_light_g = make_mat('NavLightG', (0.1, 1.0, 0.2), roughness=0.1, emission=(0.1, 1.0, 0.2), emission_strength=4.0)
    mat_light_w = make_mat('LandingLight', (1.0, 0.95, 0.8), roughness=0.1, emission=(1.0, 0.95, 0.8), emission_strength=5.0)

    parts = []

    # === 机身 — 圆柱 + bmesh锥化收尖 + 细分曲面 ===
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.25, depth=2.8, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.rotation_euler = (0, math.pi / 2, 0)
    bpy.ops.object.transform_apply(rotation=True)
    taper_mesh(obj, axis='x', end='positive', scale=0.05)   # 机头收尖
    taper_mesh(obj, axis='x', end='negative', scale=0.4)    # 机尾微收
    apply_subsurf(obj, levels=2)
    parts.append(add_obj(obj, '机身', mat_fuselage))

    # === 驾驶舱玻璃 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, segments=24, ring_count=12, location=(1.15, 0, 0.1))
    obj = bpy.context.active_object
    obj.scale = (1.3, 0.85, 0.7)
    bpy.ops.object.transform_apply(scale=True)
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '驾驶舱', mat_cockpit))

    # === 主翼 — 薄板 + bmesh翼型 + 实体化 + 倒角 ===
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
    obj = bpy.context.active_object
    obj.scale = (0.8, 2.4, 0.04)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    tip_verts = [v for v in bm.verts if abs(v.co.y) > 1.0]
    bmesh.ops.scale(bm, vec=(1, 0.3, 1), verts=tip_verts)       # 翼尖收窄
    root_verts = [v for v in bm.verts if abs(v.co.y) < 0.1]
    bmesh.ops.scale(bm, vec=(1, 1, 1.5), verts=root_verts)      # 翼根加厚
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    apply_solidify(obj, thickness=0.03)
    apply_bevel_mod(obj, width=0.02, segments=2)
    parts.append(add_obj(obj, '主翼', mat_wing))

    # === 水平尾翼 ===
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.15, 0, 0.1))
    obj = bpy.context.active_object
    obj.scale = (0.4, 1.0, 0.03)
    bpy.ops.object.transform_apply(scale=True)
    apply_solidify(obj, thickness=0.02)
    apply_bevel_mod(obj, width=0.015, segments=2)
    parts.append(add_obj(obj, '水平尾翼', mat_wing))

    # === 垂直尾翼 — bmesh后掠 ===
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-1.15, 0, 0.35))
    obj = bpy.context.active_object
    obj.scale = (0.4, 0.04, 0.35)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    top_verts = [v for v in bm.verts if v.co.z > 0.3]
    bmesh.ops.translate(bm, vec=(-0.15, 0, 0), verts=top_verts)  # 后掠
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    apply_solidify(obj, thickness=0.02)
    apply_bevel_mod(obj, width=0.015, segments=2)
    parts.append(add_obj(obj, '垂直尾翼', mat_tail))

    # === 发动机 x2（机翼下方）— 圆柱 + 细分 ===
    for side, y in [('左发动机', 0.7), ('右发动机', -0.7)]:
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.12, depth=0.5, location=(0.1, y, -0.2))
        obj = bpy.context.active_object
        obj.rotation_euler = (0, math.pi / 2, 0)
        bpy.ops.object.transform_apply(rotation=True)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, side, mat_engine))
        # 螺旋桨叶
        bpy.ops.mesh.primitive_cylinder_add(radius=0.01, depth=0.5, location=(0.36, y, -0.2))
        obj = bpy.context.active_object
        obj.rotation_euler = (0, 0, math.pi / 2)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(add_obj(obj, side + '桨叶', mat_prop))
        # 桨毂
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.04, location=(0.36, y, -0.2))
        parts.append(add_obj(bpy.context.active_object, side + '桨毂', mat_engine))

    # === 客舱窗户 x6（双侧）===
    for i in range(6):
        x = 0.3 + i * 0.25
        for y_side, suffix in [(0.22, ''), (-0.22, '右')]:
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.04, segments=12, ring_count=8, location=(x, y_side, 0.08))
            obj = bpy.context.active_object
            obj.scale = (1.5, 0.4, 1)
            bpy.ops.object.transform_apply(scale=True)
            parts.append(add_obj(obj, f'窗户{i+1}{suffix}', mat_window))

    # === 翼尖航行灯（红/绿）===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.03, location=(0.3, 1.15, -0.05))
    parts.append(add_obj(bpy.context.active_object, '左航行灯', mat_light_r))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.03, location=(0.3, -1.15, -0.05))
    parts.append(add_obj(bpy.context.active_object, '右航行灯', mat_light_g))

    # === 着陆灯 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.05, location=(1.35, 0, -0.05))
    parts.append(add_obj(bpy.context.active_object, '着陆灯', mat_light_w))

    return parts


def create_superhero(hero_type='superman'):
    """超级英雄生成器 — 披风+紧身衣+胸章+肌肉位移+英雄配色
    支持：superman, batman, ironman, spiderman, captain, generic
    使用：布尔运算、位移修改器、布料披风、文本胸章、细分曲面
    """
    # === 英雄配色方案 ===
    hero_schemes = {
        'superman': {
            'suit': (0.05, 0.15, 0.55), 'cape': (0.7, 0.05, 0.05),
            'boots': (0.7, 0.05, 0.05), 'emblem': 'S', 'emblem_color': (0.9, 0.85, 0.1),
            'skin': (0.95, 0.80, 0.68), 'hair': (0.05, 0.03, 0.02),
            'name_prefix': '超人',
        },
        'batman': {
            'suit': (0.05, 0.05, 0.08), 'cape': (0.03, 0.03, 0.05),
            'boots': (0.05, 0.05, 0.08), 'emblem': 'B', 'emblem_color': (0.8, 0.6, 0.0),
            'skin': (0.95, 0.80, 0.68), 'hair': (0.05, 0.03, 0.02),
            'name_prefix': '蝙蝠侠',
        },
        'ironman': {
            'suit': (0.75, 0.1, 0.05), 'cape': None, 'boots': (0.3, 0.3, 0.35),
            'emblem': 'I', 'emblem_color': (0.9, 0.85, 0.1),
            'skin': (0.75, 0.1, 0.05), 'hair': None,
            'name_prefix': '钢铁侠',
        },
        'spiderman': {
            'suit': (0.7, 0.1, 0.1), 'cape': None, 'boots': (0.05, 0.1, 0.4),
            'emblem': 'S', 'emblem_color': (0.05, 0.1, 0.4),
            'skin': (0.7, 0.1, 0.1), 'hair': None,
            'name_prefix': '蜘蛛侠',
        },
        'captain': {
            'suit': (0.1, 0.2, 0.6), 'cape': None, 'boots': (0.6, 0.05, 0.05),
            'emblem': '★', 'emblem_color': (0.9, 0.9, 0.9),
            'skin': (0.95, 0.80, 0.68), 'hair': (0.2, 0.15, 0.08),
            'name_prefix': '美队',
        },
        'generic': {
            'suit': (0.1, 0.3, 0.6), 'cape': (0.1, 0.3, 0.6),
            'boots': (0.05, 0.05, 0.05), 'emblem': 'H', 'emblem_color': (0.9, 0.8, 0.1),
            'skin': (0.95, 0.80, 0.68), 'hair': (0.1, 0.05, 0.03),
            'name_prefix': '英雄',
        },
    }
    s = hero_schemes.get(hero_type, hero_schemes['generic'])
    np = s['name_prefix']

    # === 材质 ===
    mat_suit = make_mat(f'{np}Suit', s['suit'], roughness=0.3, metallic=0.3, clearcoat=0.5)
    mat_skin = make_mat(f'{np}Skin', s['skin'], roughness=0.5, sheen=0.2)
    mat_emblem = make_mat(f'{np}Emblem', s['emblem_color'], roughness=0.2, metallic=0.6,
                          clearcoat=0.8, emission=s['emblem_color'], emission_strength=0.5)
    mat_hair = make_mat(f'{np}Hair', s['hair'], roughness=0.6, sheen=0.4) if s['hair'] else None
    mat_boots = make_mat(f'{np}Boots', s['boots'], roughness=0.3, metallic=0.4, clearcoat=0.6)
    mat_eye = make_mat(f'{np}Eye', (0.05, 0.05, 0.05), roughness=0.2)
    mat_belt = make_mat(f'{np}Belt', (0.8, 0.65, 0.1), roughness=0.3, metallic=0.8)
    mat_cape = None
    if s['cape']:
        mat_cape = make_mat(f'{np}Cape', s['cape'], roughness=0.5, sheen=0.3)

    parts = []

    # === 头部 — UV球 + 细分 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, segments=32, ring_count=16, location=(0, 1.65, 0))
    obj = bpy.context.active_object
    obj.scale = (0.9, 1.08, 0.95)
    bpy.ops.object.transform_apply(scale=True)
    apply_subsurf(obj, levels=2)
    parts.append(add_obj(obj, f'{np}头部', mat_skin))

    # === 头发（非全脸罩英雄才有）===
    if mat_hair:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.24, segments=32, ring_count=16, location=(0, 1.72, -0.02))
        obj = bpy.context.active_object
        obj.scale = (0.92, 0.8, 0.92)
        bpy.ops.object.transform_apply(scale=True)
        apply_subsurf(obj, levels=2)
        parts.append(add_obj(obj, f'{np}头发', mat_hair))

    # === 眼睛 x2 ===
    for side, x in [('左眼', -0.07), ('右眼', 0.07)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.025, segments=16, ring_count=8, location=(x, 1.63, 0.19))
        parts.append(add_obj(bpy.context.active_object, f'{np}{side}', mat_eye))

    # === 面罩（蝙蝠侠/蜘蛛侠用面罩替代头发）===
    if hero_type in ('batman', 'spiderman'):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.23, segments=32, ring_count=16, location=(0, 1.6, 0.05))
        obj = bpy.context.active_object
        obj.scale = (0.92, 0.6, 0.85)
        bpy.ops.object.transform_apply(scale=True)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, f'{np}面罩', mat_suit))

    # === 颈部 ===
    bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.15, vertices=24, location=(0, 1.3, 0))
    obj = bpy.context.active_object
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, f'{np}颈部', mat_suit))

    # === 躯干（紧身衣）— 立方体 + bmesh V型肌肉 + 位移 + 细分 ===
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.85, 0))
    obj = bpy.context.active_object
    obj.scale = (0.38, 0.5, 0.22)
    bpy.ops.object.transform_apply(scale=True)
    # bmesh 使胸部宽阔、腰部收紧（倒三角身材）
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bottom_verts = [v for v in bm.verts if v.co.y < -0.2]
    bmesh.ops.scale(bm, vec=(0.75, 1, 0.8), verts=bottom_verts)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    apply_displace(obj, strength=0.03)  # 肌肉纹理
    apply_subsurf(obj, levels=2)
    apply_bevel_mod(obj, width=0.02, segments=3)
    parts.append(add_obj(obj, f'{np}紧身衣', mat_suit))

    # === 胸章 — 3D文本挤出 ===
    emblem = create_emblem(f'{np}胸章', letter=s['emblem'], radius=0.1, mat=mat_emblem)
    emblem.location = (0, 0.85, 0.23)
    emblem.rotation_euler = (math.radians(90), 0, 0)
    parts.append(emblem)

    # === 腰带 ===
    bpy.ops.mesh.primitive_torus_add(major_radius=0.28, minor_radius=0.03, location=(0, 0.6, 0))
    obj = bpy.context.active_object
    obj.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(add_obj(obj, f'{np}腰带', mat_belt))

    # === 手臂 x2 — 圆柱 + 位移（肌肉感）+ 细分 ===
    for side, x in [('左臂', -0.33), ('右臂', 0.33)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.5, vertices=20, location=(x, 0.85, 0))
        obj = bpy.context.active_object
        apply_displace(obj, strength=0.015)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, f'{np}{side}', mat_suit))
        # 拳头
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.06, segments=16, ring_count=8, location=(x, 0.55, 0))
        parts.append(add_obj(bpy.context.active_object, f'{np}{side}拳', mat_suit))

    # === 腿 x2 — 圆柱 + 锥化 + 细分 ===
    for side, x in [('左腿', -0.12), ('右腿', 0.12)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.09, depth=0.55, vertices=20, location=(x, 0.25, 0))
        obj = bpy.context.active_object
        taper_mesh(obj, axis='y', end='negative', scale=0.7)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, f'{np}{side}', mat_suit))
        # 靴子
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -0.05, 0.05))
        obj = bpy.context.active_object
        obj.scale = (0.12, 0.08, 0.22)
        bpy.ops.object.transform_apply(scale=True)
        apply_bevel_mod(obj, width=0.02, segments=3)
        parts.append(add_obj(obj, f'{np}{side}靴', mat_boots))

    # === 披风 — 布料模拟（平面+波浪变形+实体化+细分）===
    if mat_cape:
        cape = create_cloth_cape(f'{np}披风', width=0.9, height=1.2, mat=mat_cape)
        cape.location = (0, 0.7, -0.18)
        cape.rotation_euler = (0, 0, 0)
        parts.append(cape)

    # === 英雄光环（发光底座）===
    mat_aura = make_mat(f'{np}Aura', s['emblem_color'], roughness=0.1,
                        emission=s['emblem_color'], emission_strength=3.0)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.35, minor_radius=0.02, location=(0, -0.12, 0))
    obj = bpy.context.active_object
    obj.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(add_obj(obj, f'{np}光环', mat_aura))

    return parts


def create_male_character():
    """男性角色 — 宽肩窄腰、短发、硬朗五官"""
    mat_skin = make_mat('MSkin', (0.88, 0.72, 0.58), roughness=0.5, sheen=0.15)
    mat_hair = make_mat('MHair', (0.08, 0.05, 0.03), roughness=0.6, sheen=0.3)
    mat_shirt = make_mat('MShirt', (0.15, 0.2, 0.35), roughness=0.6, sheen=0.2)
    mat_pants = make_mat('MPants', (0.08, 0.08, 0.12), roughness=0.7)
    mat_shoe = make_mat('MShoe', (0.05, 0.05, 0.05), roughness=0.4, clearcoat=0.3)
    mat_eye = make_mat('MEye', (0.05, 0.05, 0.05), roughness=0.2)

    parts = []

    # === 头部 — UV球 + 细分（男性更宽更方）===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.23, segments=32, ring_count=16, location=(0, 1.65, 0))
    obj = bpy.context.active_object
    obj.scale = (0.95, 1.0, 0.95)
    bpy.ops.object.transform_apply(scale=True)
    apply_subsurf(obj, levels=2)
    parts.append(add_obj(obj, '头部', mat_skin))

    # === 短发 ===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.25, segments=32, ring_count=16, location=(0, 1.72, -0.01))
    obj = bpy.context.active_object
    obj.scale = (0.95, 0.7, 0.95)
    bpy.ops.object.transform_apply(scale=True)
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '头发', mat_hair))

    # === 眼睛 x2 ===
    for side, x in [('左眼', -0.07), ('右眼', 0.07)]:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.025, segments=16, ring_count=8, location=(x, 1.63, 0.19))
        parts.append(add_obj(bpy.context.active_object, side, mat_eye))

    # === 鼻子（男性更大）===
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.03, segments=12, ring_count=6, location=(0, 1.58, 0.21))
    obj = bpy.context.active_object
    obj.scale = (0.9, 1.3, 0.9)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '鼻子', mat_skin))

    # === 嘴 ===
    bpy.ops.mesh.primitive_torus_add(major_radius=0.04, minor_radius=0.008, location=(0, 1.52, 0.19))
    obj = bpy.context.active_object
    obj.scale = (1.3, 0.5, 1)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(add_obj(obj, '嘴', mat_skin))

    # === 颈部（男性更粗）===
    bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.14, vertices=24, location=(0, 1.3, 0))
    obj = bpy.context.active_object
    apply_subsurf(obj, levels=1)
    parts.append(add_obj(obj, '颈部', mat_skin))

    # === 躯干 — 立方体 + bmesh倒三角身材 + 位移肌肉 + 细分 ===
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.85, 0))
    obj = bpy.context.active_object
    obj.scale = (0.42, 0.5, 0.24)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bottom_verts = [v for v in bm.verts if v.co.y < -0.15]
    bmesh.ops.scale(bm, vec=(0.72, 1, 0.8), verts=bottom_verts)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    apply_displace(obj, strength=0.02)
    apply_subsurf(obj, levels=2)
    apply_bevel_mod(obj, width=0.02, segments=3)
    parts.append(add_obj(obj, '上衣', mat_shirt))

    # === 手臂 x2 — 圆柱 + 位移 + 细分（男性更粗壮）===
    for side, x in [('左臂', -0.34), ('右臂', 0.34)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.5, vertices=20, location=(x, 0.85, 0))
        obj = bpy.context.active_object
        apply_displace(obj, strength=0.012)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, side, mat_shirt))
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.06, segments=16, ring_count=8, location=(x, 0.55, 0))
        parts.append(add_obj(bpy.context.active_object, side + '手', mat_skin))

    # === 腿 x2 — 圆柱 + 锥化 + 细分 ===
    for side, x in [('左腿', -0.12), ('右腿', 0.12)]:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.55, vertices=20, location=(x, 0.25, 0))
        obj = bpy.context.active_object
        taper_mesh(obj, axis='y', end='negative', scale=0.7)
        apply_subsurf(obj, levels=1)
        parts.append(add_obj(obj, side, mat_pants))
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -0.05, 0.04))
        obj = bpy.context.active_object
        obj.scale = (0.1, 0.06, 0.2)
        bpy.ops.object.transform_apply(scale=True)
        apply_bevel_mod(obj, width=0.015, segments=2)
        parts.append(add_obj(obj, side + '鞋', mat_shoe))

    return parts


def create_generic_model(prompt):
    """根据提示词生成通用模型 — 关键词匹配"""
    prompt_lower = prompt.lower()

    # 颜色检测
    colors = {
        '红': (1.0, 0.1, 0.1), '红': (1.0, 0.1, 0.1),
        '蓝': (0.1, 0.3, 0.9), '蓝': (0.1, 0.3, 0.9),
        '绿': (0.1, 0.7, 0.2), '绿': (0.1, 0.7, 0.2),
        '黄': (1.0, 0.85, 0.0), '黄': (1.0, 0.85, 0.0),
        '紫': (0.6, 0.1, 0.8), '紫': (0.6, 0.1, 0.8),
        '橙': (1.0, 0.5, 0.0), '橙': (1.0, 0.5, 0.0),
        '白': (0.9, 0.9, 0.9), '白': (0.9, 0.9, 0.9),
        '黑': (0.05, 0.05, 0.05), '黑': (0.05, 0.05, 0.05),
    }
    base_color = (0.7, 0.7, 0.7)
    for kw, color in colors.items():
        if kw in prompt_lower:
            base_color = color
            break

    # 形状检测
    parts = []
    mat = make_mat('GenericMat', base_color, roughness=0.4, metallic=0.3)

    if any(kw in prompt_lower for kw in ['立方体', '方块', 'cube', 'box', '正方']):
        bpy.ops.mesh.primitive_cube_add(size=1.5, location=(0, 0, 0))
        parts.append(add_obj(bpy.context.active_object, '立方体', mat))
    elif any(kw in prompt_lower for kw in ['圆柱', '柱体', 'cylinder', '柱']):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.8, depth=1.5, location=(0, 0, 0))
        parts.append(add_obj(bpy.context.active_object, '圆柱体', mat))
    elif any(kw in prompt_lower for kw in ['圆锥', '锥体', 'cone']):
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.8, depth=1.5, location=(0, 0, 0))
        parts.append(add_obj(bpy.context.active_object, '圆锥体', mat))
    elif any(kw in prompt_lower for kw in ['圆环', '环', 'torus', '甜甜圈']):
        bpy.ops.mesh.primitive_torus_add(major_radius=0.8, minor_radius=0.3, location=(0, 0, 0))
        parts.append(add_obj(bpy.context.active_object, '圆环', mat))
    else:
        # 默认：组合体（球体 + 立方体 + 圆柱）
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.8, location=(0, 0.5, 0))
        parts.append(add_obj(bpy.context.active_object, '球体部件', mat))

        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.5, 0))
        obj = bpy.context.active_object
        obj.scale = (1.2, 0.5, 1.2)
        bpy.ops.object.transform_apply(scale=True)
        parts.append(add_obj(obj, '底座', mat))

        bpy.ops.mesh.primitive_cylinder_add(radius=0.15, depth=1.0, location=(0, 0, 0))
        parts.append(add_obj(bpy.context.active_object, '连接柱', mat))

    return parts


# ===== 提示词智能匹配 =====

# 定义提示词模板库 — 每个模板有权重，优先匹配高权重
PROMPT_TEMPLATES = [
    # === 超级英雄类（高优先级，必须在泛「人」之前匹配）===
    {
        'keywords': ['超人', 'superman', '克拉克', '钢铁之躯'],
        'weight': 100,
        'creator': lambda: create_superhero('superman'),
        'desc': '超人',
    },
    {
        'keywords': ['蝙蝠侠', 'batman', '布鲁斯'],
        'weight': 100,
        'creator': lambda: create_superhero('batman'),
        'desc': '蝙蝠侠',
    },
    {
        'keywords': ['钢铁侠', 'iron man', 'ironman', '托尼'],
        'weight': 100,
        'creator': lambda: create_superhero('ironman'),
        'desc': '钢铁侠',
    },
    {
        'keywords': ['蜘蛛侠', 'spiderman', 'spider-man', '彼得帕克'],
        'weight': 100,
        'creator': lambda: create_superhero('spiderman'),
        'desc': '蜘蛛侠',
    },
    {
        'keywords': ['美国队长', 'captain america', '美队', '史蒂夫'],
        'weight': 100,
        'creator': lambda: create_superhero('captain'),
        'desc': '美国队长',
    },
    {
        'keywords': ['英雄', 'hero', '超级英雄', 'superhero', 'super hero'],
        'weight': 90,
        'creator': lambda: create_superhero('generic'),
        'desc': '超级英雄',
    },
    # === 具体角色类型 ===
    {
        'keywords': ['美女', '女孩', '女性', 'woman', 'girl', 'female', '少女', '女神'],
        'weight': 80,
        'creator': lambda: create_character('female'),
        'desc': '女性角色',
    },
    {
        'keywords': ['男人', '男性', 'man', 'male', '男孩', 'boy', '帅哥', '战士', 'warrior', 'knight', '骑士'],
        'weight': 80,
        'creator': lambda: create_male_character(),
        'desc': '男性角色',
    },
    # === 具体物体（中优先级）===
    {
        'keywords': ['篮球', 'basketball'],
        'weight': 70,
        'creator': create_basketball,
        'desc': '篮球',
    },
    {
        'keywords': ['quest', 'vr', '头显', '头戴'],
        'weight': 70,
        'creator': create_quest3,
        'desc': 'Quest 3 头显',
    },
    {
        'keywords': ['机器人', 'robot', '机械人', '机甲', 'mecha'],
        'weight': 70,
        'creator': create_robot,
        'desc': '机器人',
    },
    {
        'keywords': ['汽车', '车', 'car', 'vehicle', '跑车', '赛车'],
        'weight': 70,
        'creator': create_car,
        'desc': '汽车',
    },
    {
        'keywords': ['飞机', 'airplane', 'plane', '客机', '航班', 'aircraft'],
        'weight': 70,
        'creator': create_airplane,
        'desc': '飞机',
    },
    {
        'keywords': ['房子', '房屋', 'house', '建筑', 'building', '小屋'],
        'weight': 70,
        'creator': create_house,
        'desc': '房子',
    },
    {
        'keywords': ['火箭', 'rocket', '导弹', 'missile'],
        'weight': 70,
        'creator': create_rocket,
        'desc': '火箭',
    },
    # === 泛角色（低优先级兜底）===
    {
        'keywords': ['人', '角色', 'character', '人物', 'person', 'human', '角色'],
        'weight': 30,
        'creator': lambda: create_character('female'),
        'desc': '人物角色',
    },
    {
        'keywords': ['球', 'sphere', 'ball'],
        'weight': 30,
        'creator': create_red_sphere,
        'desc': '球体',
    },
]


def match_prompt(prompt):
    """根据提示词智能匹配模型类型 — 评分系统，高权重优先"""
    p = prompt.lower().strip()
    log(f'  🧠 提示词分析: "{prompt}"')

    best_match = None
    best_score = 0
    matched_kw = ''

    for template in PROMPT_TEMPLATES:
        for kw in template['keywords']:
            if kw in p:
                # 精确匹配得分更高
                score = template['weight']
                if p.strip() == kw:
                    score += 50  # 完全匹配加50分
                elif p.startswith(kw):
                    score += 20  # 开头匹配加20分

                if score > best_score:
                    best_score = score
                    best_match = template
                    matched_kw = kw
                break  # 每个模板只匹配一次

    if best_match:
        log(f"  ✅ 匹配: {best_match['desc']} (关键词: '{matched_kw}', 得分: {best_score})")
        return best_match['creator']
    else:
        log(f"  📦 未匹配预设，使用通用生成器")
        return lambda: create_generic_model(prompt)


# ===== 后处理 =====

def post_process_scene():
    """后处理：将曲线转换为网格、全局平滑着色"""
    # 1. 将所有曲线对象转换为网格（曲线管道等）
    curve_objs = [obj for obj in bpy.data.objects if obj.type == 'CURVE']
    for obj in curve_objs:
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.convert(target='MESH')
        log(f"     🔄 曲线已转换: {obj.name}")

    # 2. 平滑着色所有网格对象
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.shade_smooth()
            if hasattr(obj.data, 'use_auto_smooth'):
                obj.data.use_auto_smooth = True
                obj.data.auto_smooth_angle = math.radians(40)

    log(f"  ✅ 后处理完成（{len(curve_objs)} 条曲线已转换，全部网格已平滑着色）")


# ===== GLB 导出 =====

def export_glb(output_path):
    """导出场景为 GLB"""
    # 确保所有对象都被选中
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
    )
    log(f"  GLB 导出完成: {output_path}")


def compute_manifest():
    """计算 manifest"""
    meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    manifest = {"parts": []}

    if not meshes:
        return manifest

    all_coords = []
    for obj in meshes:
        for v in obj.data.vertices:
            all_coords.append(obj.matrix_world @ v.co)

    if not all_coords:
        return manifest

    min_x = min(c.x for c in all_coords)
    max_x = max(c.x for c in all_coords)
    min_y = min(c.y for c in all_coords)
    max_y = max(c.y for c in all_coords)
    min_z = min(c.z for c in all_coords)
    max_z = max(c.z for c in all_coords)

    center = Vector(((min_x + max_x) / 2, (min_y + max_y) / 2, (min_z + max_z) / 2))
    model_size = [max_x - min_x, max_y - min_y, max_z - min_z]

    parts_info = []
    for obj in meshes:
        obj_coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
        if not obj_coords:
            continue

        o_min_x = min(c.x for c in obj_coords)
        o_max_x = max(c.x for c in obj_coords)
        o_min_y = min(c.y for c in obj_coords)
        o_max_y = max(c.y for c in obj_coords)
        o_min_z = min(c.z for c in obj_coords)
        o_max_z = max(c.z for c in obj_coords)

        part_center = Vector(((o_min_x + o_max_x) / 2, (o_min_y + o_max_y) / 2, (o_min_z + o_max_z) / 2))
        dist = (part_center - center).length

        rel = part_center - center
        abs_x, abs_y, abs_z = abs(rel.x), abs(rel.y), abs(rel.z)
        max_abs = max(abs_x, abs_y, abs_z)
        if max_abs < 0.01:
            direction = "中心"
        elif abs_x == max_abs:
            direction = "右侧" if rel.x > 0 else "左侧"
        elif abs_y == max_abs:
            direction = "顶部" if rel.y > 0 else "底部"
        else:
            direction = "前方" if rel.z > 0 else "后方"

        display_name = obj.name
        parts_info.append({
            "name": obj.name,
            "display_name": display_name,
            "direction": direction,
            "center": [round(part_center.x, 6), round(part_center.y, 6), round(part_center.z, 6)],
            "bbox_min": [round(o_min_x, 6), round(o_min_y, 6), round(o_min_z, 6)],
            "bbox_max": [round(o_max_x, 6), round(o_max_y, 6), round(o_max_z, 6)],
            "size": [round(o_max_x - o_min_x, 6), round(o_max_y - o_min_y, 6), round(o_max_z - o_min_z, 6)],
            "distance_from_center": round(dist, 6),
            "face_count": len(obj.data.polygons),
            "vertex_count": len(obj.data.vertices),
        })

    parts_info.sort(key=lambda p: p["distance_from_center"], reverse=True)

    for i, p in enumerate(parts_info):
        p["name"] = f"Part_{i+1:03d}"

    manifest["parts"] = parts_info
    manifest["total_parts"] = len(parts_info)
    manifest["model_center"] = [round(center.x, 6), round(center.y, 6), round(center.z, 6)]
    manifest["model_size"] = model_size

    return manifest


# ===== 主函数 =====

def parse_args():
    if '--' in sys.argv:
        script_args = sys.argv[sys.argv.index('--') + 1:]
    else:
        script_args = sys.argv[1:]

    prompt = '球体'
    output_path = '/tmp/ai_paint_output.glb'
    manifest_path = '/tmp/ai_paint_manifest.json'
    image_features_path = None

    i = 0
    while i < len(script_args):
        arg = script_args[i]
        if arg == '--prompt' and i + 1 < len(script_args):
            prompt = script_args[i + 1]
            i += 2
        elif arg == '--output' and i + 1 < len(script_args):
            output_path = script_args[i + 1]
            i += 2
        elif arg == '--manifest' and i + 1 < len(script_args):
            manifest_path = script_args[i + 1]
            i += 2
        elif arg == '--image-features' and i + 1 < len(script_args):
            image_features_path = script_args[i + 1]
            i += 2
        else:
            i += 1

    return prompt, output_path, manifest_path, image_features_path


def load_image_features(image_features_path):
    """加载图片特征 JSON 文件"""
    global IMAGE_FEATURES
    if not image_features_path or not os.path.exists(image_features_path):
        return
    try:
        with open(image_features_path, 'r', encoding='utf-8') as f:
            IMAGE_FEATURES = json.load(f)
        colors = IMAGE_FEATURES.get('dominantColors', [])
        mood = IMAGE_FEATURES.get('mood', 'unknown')
        log(f"  🖼️ 图片特征已加载: {mood}色调, {len(colors)}个主色, 对称度{IMAGE_FEATURES.get('symmetry', 0):.0%}")
        for c in colors:
            r, g, b = c['r'] / 255.0, c['g'] / 255.0, c['b'] / 255.0
            log(f"     🎨 rgb({c['r']},{c['g']},{c['b']}) 占比{c['ratio']:.0%}")
    except Exception as e:
        log(f"  ⚠️ 图片特征加载失败: {e}")


def apply_image_colors_to_scene():
    """根据图片特征重新着色场景中的对象"""
    if not IMAGE_FEATURES:
        return

    colors = IMAGE_FEATURES.get('dominantColors', [])
    if not colors:
        return

    mood = IMAGE_FEATURES.get('mood', 'neutral')
    avg_lum = IMAGE_FEATURES.get('avgLuminance', 0.5)

    # 将主色转为 0-1 范围
    palette = [(c['r'] / 255.0, c['g'] / 255.0, c['b'] / 255.0, c.get('ratio', 0.2)) for c in colors]

    # 获取场景中所有有材质的网格对象
    mesh_objs = [obj for obj in bpy.data.objects if obj.type == 'MESH' and obj.data.materials]
    if not mesh_objs:
        return

    log(f"  🎨 应用图片配色到 {len(mesh_objs)} 个对象...")

    for idx, obj in enumerate(mesh_objs):
        # 按比例分配颜色：主要对象用主色，次要对象用辅色
        color_idx = idx % len(palette)
        r, g, b, ratio = palette[color_idx]

        # 根据色调调整材质属性
        if mood == 'bright':
            roughness = 0.3
            metallic = 0.1
        elif mood == 'dark':
            roughness = 0.6
            metallic = 0.5
        elif mood == 'warm':
            roughness = 0.4
            metallic = 0.2
        elif mood == 'cool':
            roughness = 0.35
            metallic = 0.4
        elif mood == 'natural':
            roughness = 0.7
            metallic = 0.1
        else:
            roughness = 0.5
            metallic = 0.3

        # 如果主色占比非常高（>60%），全部用主色
        if palette[0][3] > 0.6:
            r, g, b = palette[0][0], palette[0][1], palette[0][2]

        # 创建新材质
        mat_name = f'ImgColor_{obj.name}_{idx}'
        # 对暗色物体增加金属感，亮色增加光泽
        use_emission = avg_lum > 0.6 and idx == 0
        emission_color = (r, g, b) if use_emission else None
        emission_strength = 0.3 if use_emission else 0.0

        new_mat = make_mat(mat_name, (r, g, b), roughness=roughness, metallic=metallic,
                           emission=emission_color, emission_strength=emission_strength,
                           clearcoat=0.3 if mood in ('bright', 'cool') else 0.0)

        # 替换对象的材质
        obj.data.materials.clear()
        obj.data.materials.append(new_mat)

    log(f"  ✅ 图片配色已应用 ({len(mesh_objs)} 个对象, {mood}色调)")


def apply_image_shape_influence():
    """根据图片特征微调形状（对称性、边缘密度影响细节）"""
    if not IMAGE_FEATURES:
        return

    symmetry = IMAGE_FEATURES.get('symmetry', 0.5)
    edge_density = IMAGE_FEATURES.get('edgeDensity', 0.1)

    # 高边缘密度 = 增加细分级别（更多几何细节）
    if edge_density > 0.15:
        for obj in bpy.data.objects:
            if obj.type == 'MESH':
                # 添加细分修改器
                if not any(m.type == 'SUBSURF' for m in obj.modifiers):
                    subsurf = obj.modifiers.new(name='ImgSubsurf', type='SUBSURF')
                    subsurf.levels = 1
                    subsurf.render_levels = 2
        log(f"  📐 边缘密度高({edge_density:.0%})，已添加细分")

    # 高对称性 = 确保模型对称（不需要额外操作，生成器已对称）
    log(f"  📐 图片对称度: {symmetry:.0%}, 边缘密度: {edge_density:.0%}")


def main():
    global IMAGE_FEATURES
    prompt, output_path, manifest_path, image_features_path = parse_args()

    # 加载图片特征
    load_image_features(image_features_path)

    log("=" * 50)
    log(f"  🎨 AI 绘画 — Blender 模型生成器")
    log(f"  📝 提示词: {prompt}")
    if IMAGE_FEATURES:
        log(f"  🖼️ 图片参考: {IMAGE_FEATURES.get('mood', '?')}色调, {len(IMAGE_FEATURES.get('dominantColors', []))}个主色")
    log("=" * 50)

    try:
        # 1. 清空场景
        clear_scene()
        log("  ✅ 场景已清空")

        # 2. 匹配提示词并生成模型
        creator = match_prompt(prompt)
        parts = creator()
        log(f"  ✅ 模型已生成: {len(parts)} 个部件")
        for p in parts:
            log(f"     - {p.name}")

        # 2.5 后处理：曲线转网格、平滑着色
        post_process_scene()

        # 2.6 如果有图片特征，应用图片配色和形状影响
        if IMAGE_FEATURES:
            apply_image_colors_to_scene()
            apply_image_shape_influence()

        # 3. 导出 GLB
        export_glb(output_path)

        # 4. 计算 manifest
        manifest = compute_manifest()
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        log(f"  ✅ Manifest 已保存: {manifest_path} ({manifest['total_parts']} 个部件)")

        log(f"\n  🎉 AI 绘画完成！")
        log(f"     GLB: {output_path}")
        log(f"     部件数: {manifest['total_parts']}")

    except Exception as e:
        log(f"\n  ❌ 错误: {e}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
