#!/usr/bin/env python3
"""
Quest 3 完整拆解模型 - Blender Python 脚本

生成 Quest 3 的 15 个可拆解部件，并设置爆炸视图动画

部件列表：
1. 主机身
2. 前面板
3. 面罩海绵
4. 左透镜模组
5. 右透镜模组
6. 左透镜玻璃
7. 右透镜玻璃
8. 主板/显示屏
9. 左摄像头
10. 右摄像头
11. 中置摄像头
12. 下置追踪摄像头
13. 左头带臂
14. 右头带臂
15. 头带

使用方法：
在 Blender 中：
1. 打开 Scripting 工作区
2. 新建脚本
3. 粘贴此代码
4. 点击 "Run Script"

或命令行：
blender --background --python quest3_exploded.py
"""

import bpy
import math
from mathutils import Vector
from typing import List, Tuple


# ========== 材质定义 ==========

def create_materials():
    """创建所有材质"""

    materials = {}

    # 白色前面板（亚光塑料）
    mat = bpy.data.materials.new(name="FrontPlate")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.97, 0.97, 0.97, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.35
    bsdf.inputs['Metallic'].default_value = 0.02
    # Clearcoat 在某些版本可能不可用
    if 'Clearcoat' in bsdf.inputs:
        bsdf.inputs['Clearcoat'].default_value = 0.5
        bsdf.inputs['Clearcoat Roughness'].default_value = 0.2
    materials['frontPlate'] = mat

    # 黑色主机身（哑光塑料）
    mat = bpy.data.materials.new(name="Body")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.12, 0.12, 0.13, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.6
    bsdf.inputs['Metallic'].default_value = 0.08
    materials['body'] = mat

    # 深空蓝透镜外环（金属质感）
    mat = bpy.data.materials.new(name="LensBarrel")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.1, 0.18, 0.29, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.2
    bsdf.inputs['Metallic'].default_value = 0.55
    if 'Clearcoat' in bsdf.inputs:
        bsdf.inputs['Clearcoat'].default_value = 0.9
        bsdf.inputs['Clearcoat Roughness'].default_value = 0.1
    materials['lensBarrel'] = mat

    # 透镜玻璃（透明蓝色）
    mat = bpy.data.materials.new(name="LensGlass")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.6, 0.8, 1.0, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.03
    bsdf.inputs['Metallic'].default_value = 0.0
    if 'Transmission' in bsdf.inputs:
        bsdf.inputs['Transmission'].default_value = 0.95
        bsdf.inputs['Thickness'].default_value = 0.5
    materials['lensGlass'] = mat

    # 摄像头（深色玻璃纤维）
    mat = bpy.data.materials.new(name="Camera")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.05, 0.05, 0.05, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.25
    bsdf.inputs['Metallic'].default_value = 0.65
    materials['camera'] = mat

    # 传感器镜头
    mat = bpy.data.materials.new(name="Sensor")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.04, 0.1, 0.2, 1.0)
    if 'Emission' in bsdf.inputs:
        bsdf.inputs['Emission'].default_value = (0.04, 0.1, 0.2, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 0.5
    materials['sensor'] = mat

    # 头带臂（深灰色塑料）
    mat = bpy.data.materials.new(name="StrapArm")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.18, 0.18, 0.19, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.7
    bsdf.inputs['Metallic'].default_value = 0.12
    materials['strapArm'] = mat

    # 记忆海绵（深灰色，高粗糙度）
    mat = bpy.data.materials.new(name="Foam")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.1, 0.1, 0.11, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.95
    bsdf.inputs['Metallic'].default_value = 0.0
    materials['foam'] = mat

    # 主板 PCB（深绿色）
    mat = bpy.data.materials.new(name="PCB")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.04, 0.25, 0.13, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.75
    bsdf.inputs['Metallic'].default_value = 0.05
    materials['pcb'] = mat

    return materials


# ========== 部件创建函数 ==========

def create_part(name: str, mesh, home_pos: Tuple[float, float, float],
                explode_pos: Tuple[float, float, float], material):
    """创建部件并设置爆炸位置

    Args:
        name: 部件名称
        mesh: 网格对象
        home_pos: 原始位置 (x, y, z)
        explode_pos: 爆炸位置 (x, y, z)
        material: 材质
    """
    # 设置位置和材质
    mesh.location = home_pos
    mesh.data.materials.append(material)

    # 存储自定义属性
    mesh['home_pos'] = home_pos
    mesh['explode_pos'] = explode_pos
    mesh['part_name'] = name

    return mesh


def create_rounded_box(name: str, size: Tuple[float, float, float],
                       location: Tuple[float, float, float],
                       radius: float = 0.05, material=None) -> bpy.types.Object:
    """创建圆角立方体

    Args:
        name: 名称
        size: (width, height, depth)
        location: 位置
        radius: 圆角半径
        material: 材质
    """
    # 使用默认立方体模拟圆角（Blender 原生圆角需要修改器）
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size

    # 添加倒角修改器模拟圆角
    bevel = obj.modifiers.new(name="Bevel", type='BEVEL')
    bevel.width = radius
    bevel.segments = 3

    if material:
        obj.data.materials.append(material)

    return obj


def create_cylinder_mesh(name: str, radius: float, depth: float,
                        location: Tuple[float, float, float],
                        rotation: Tuple[float, float, float] = (0, 0, 0),
                        material=None) -> bpy.types.Object:
    """创建圆柱体

    Args:
        name: 名称
        radius: 半径
        depth: 深度
        location: 位置
        rotation: 旋转（度）
        material: 材质
    """
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius,
        depth=depth,
        location=location,
        rotation=tuple(math.radians(r) for r in rotation)
    )
    obj = bpy.context.active_object
    obj.name = name

    if material:
        obj.data.materials.append(material)

    return obj


# ========== Quest 3 模型构建 ==========

def create_quest3_model(materials: dict) -> List[bpy.types.Object]:
    """创建完整的 Quest 3 模型（15 个部件）

    Returns:
        部件列表
    """
    parts = []

    print("\n🔨 开始创建 Quest 3 模型...\n")

    # 1. 主机身（中部黑色主体）
    print("1/15 创建主机身...")
    body = create_rounded_box(
        name="主机身",
        size=(2.2, 1.15, 1.0),
        location=(0, 0, 0),
        radius=0.12,
        material=materials['body']
    )
    body['home_pos'] = (0, 0, 0)
    body['explode_pos'] = (0, 0, 0)
    parts.append(body)

    # 2. 前面板（白色外壳）
    print("2/15 创建前面板...")
    front = create_rounded_box(
        name="前面板",
        size=(2.3, 1.25, 0.25),
        location=(0, 0, 0.55),
        radius=0.1,
        material=materials['frontPlate']
    )
    front['home_pos'] = (0, 0, 0.55)
    front['explode_pos'] = (0, 0, 1.45)
    parts.append(front)

    # 3. 后面罩/泡沫垫
    print("3/15 创建面罩海绵...")
    foam = create_rounded_box(
        name="面罩海绵",
        size=(2.0, 0.95, 0.18),
        location=(0, 0, -0.55),
        radius=0.08,
        material=materials['foam']
    )
    foam['home_pos'] = (0, 0, -0.55)
    foam['explode_pos'] = (0, 0, -1.35)
    parts.append(foam)

    # 4. 左透镜模组
    print("4/15 创建左透镜模组...")
    left_barrel = create_cylinder_mesh(
        name="左透镜模组",
        radius=0.32,
        depth=0.45,
        location=(-0.52, 0.05, -0.12),
        rotation=(90, 0, 0),
        material=materials['lensBarrel']
    )
    left_barrel['home_pos'] = (-0.52, 0.05, -0.12)
    left_barrel['explode_pos'] = (-0.52, 0.05, -0.7)
    parts.append(left_barrel)

    # 5. 右透镜模组
    print("5/15 创建右透镜模组...")
    right_barrel = create_cylinder_mesh(
        name="右透镜模组",
        radius=0.32,
        depth=0.45,
        location=(0.52, 0.05, -0.12),
        rotation=(90, 0, 0),
        material=materials['lensBarrel']
    )
    right_barrel['home_pos'] = (0.52, 0.05, -0.12)
    right_barrel['explode_pos'] = (0.52, 0.05, -0.7)
    parts.append(right_barrel)

    # 6. 左透镜玻璃
    print("6/15 创建左透镜玻璃...")
    left_glass = create_cylinder_mesh(
        name="左透镜",
        radius=0.26,
        depth=0.04,
        location=(-0.52, 0.05, -0.34),
        rotation=(90, 0, 0),
        material=materials['lensGlass']
    )
    left_glass['home_pos'] = (-0.52, 0.05, -0.34)
    left_glass['explode_pos'] = (-0.52, 0.05, -1.1)
    parts.append(left_glass)

    # 7. 右透镜玻璃
    print("7/15 创建右透镜玻璃...")
    right_glass = create_cylinder_mesh(
        name="右透镜",
        radius=0.26,
        depth=0.04,
        location=(0.52, 0.05, -0.34),
        rotation=(90, 0, 0),
        material=materials['lensGlass']
    )
    right_glass['home_pos'] = (0.52, 0.05, -0.34)
    right_glass['explode_pos'] = (0.52, 0.05, -1.1)
    parts.append(right_glass)

    # 8. 主板/显示屏
    print("8/15 创建主板...")
    pcb = create_rounded_box(
        name="主板",
        size=(1.6, 0.7, 0.06),
        location=(0, 0.05, -0.05),
        radius=0.02,
        material=materials['pcb']
    )
    pcb['home_pos'] = (0, 0.05, -0.05)
    pcb['explode_pos'] = (0, 0.05, -0.95)
    parts.append(pcb)

    # 9. 左摄像头
    print("9/15 创建左摄像头...")
    left_cam = create_cylinder_mesh(
        name="左摄像头",
        radius=0.09,
        depth=0.08,
        location=(-0.75, 0.18, 0.68),
        rotation=(90, 0, 0),
        material=materials['camera']
    )
    left_cam['home_pos'] = (-0.75, 0.18, 0.68)
    left_cam['explode_pos'] = (-0.95, 0.35, 1.8)
    parts.append(left_cam)

    # 10. 右摄像头
    print("10/15 创建右摄像头...")
    right_cam = create_cylinder_mesh(
        name="右摄像头",
        radius=0.09,
        depth=0.08,
        location=(0.75, 0.18, 0.68),
        rotation=(90, 0, 0),
        material=materials['camera']
    )
    right_cam['home_pos'] = (0.75, 0.18, 0.68)
    right_cam['explode_pos'] = (0.95, 0.35, 1.8)
    parts.append(right_cam)

    # 11. 中置摄像头
    print("11/15 创建中置摄像头...")
    center_cam = create_cylinder_mesh(
        name="中置摄像头",
        radius=0.09,
        depth=0.08,
        location=(0, 0.28, 0.68),
        rotation=(90, 0, 0),
        material=materials['camera']
    )
    center_cam['home_pos'] = (0, 0.28, 0.68)
    center_cam['explode_pos'] = (0, 0.55, 1.9)
    parts.append(center_cam)

    # 12. 下置追踪摄像头
    print("12/15 创建下置追踪摄像头...")
    bottom_cam = create_cylinder_mesh(
        name="下置追踪摄像头",
        radius=0.09,
        depth=0.08,
        location=(0, -0.35, 0.6),
        rotation=(90, 0, 0),
        material=materials['camera']
    )
    bottom_cam['home_pos'] = (0, -0.35, 0.6)
    bottom_cam['explode_pos'] = (0, -0.75, 1.7)
    parts.append(bottom_cam)

    # 13. 左头带臂
    print("13/15 创建左头带臂...")
    left_arm = create_rounded_box(
        name="左头带臂",
        size=(0.25, 0.7, 0.18),
        location=(-1.25, 0, 0),
        radius=0.04,
        material=materials['strapArm']
    )
    left_arm['home_pos'] = (-1.25, 0, 0)
    left_arm['explode_pos'] = (-2.1, 0, 0)
    parts.append(left_arm)

    # 14. 右头带臂
    print("14/15 创建右头带臂...")
    right_arm = create_rounded_box(
        name="右头带臂",
        size=(0.25, 0.7, 0.18),
        location=(1.25, 0, 0),
        radius=0.04,
        material=materials['strapArm']
    )
    right_arm['home_pos'] = (1.25, 0, 0)
    right_arm['explode_pos'] = (2.1, 0, 0)
    parts.append(right_arm)

    # 15. 头带
    print("15/15 创建头带...")
    # 使用曲线创建头带
    curve = bpy.data.curves.new('headstrap_curve', type='CURVE')
    curve.dimensions = '3D'
    spline = curve.splines.new('NURBS')
    spline.points.add(4)

    # 设置曲线点
    points = [
        (-1.25, 0.25, -0.1),
        (-0.8, 1.4, -0.5),
        (0, 1.6, -0.6),
        (0.8, 1.4, -0.5),
        (1.25, 0.25, -0.1)
    ]

    for i, point in enumerate(points):
        spline.points[i].co = (point[0], point[1], point[2], 1.0)

    spline.use_endpoint_u = True
    spline.use_cyclic_u = False

    # 创建管状几何体
    strap = bpy.data.objects.new('头带', curve)
    bpy.context.collection.objects.link(strap)

    # 添加填充几何体修改器（兼容新旧版本）
    try:
        fill = strap.modifiers.new(name="Fill", type='NODES')
    except TypeError:
        # 旧版本使用 'GeometryNodes'
        fill = strap.modifiers.new(name="Fill", type='GeometryNodes')
    # 简单起见，使用默认设置

    strap['home_pos'] = (0, 0, 0)
    strap['explode_pos'] = (0, 0.9, -0.8)
    strap['part_name'] = "头带"

    if materials['strapArm']:
        strap.data.materials.append(materials['strapArm'])

    parts.append(strap)

    print(f"\n✅ Quest 3 模型创建完成！共 {len(parts)} 个部件\n")

    return parts


# ========== 爆炸动画设置 ==========

def setup_exploded_view(parts: List[bpy.types.Object], frame_start: int = 1, frame_end: int = 100):
    """设置爆炸视图动画

    Args:
        parts: 部件列表
        frame_start: 起始帧
        frame_end: 结束帧
    """
    scene = bpy.context.scene
    scene.frame_start = frame_start
    scene.frame_end = frame_end

    print("💥 设置爆炸动画...\n")

    for i, part in enumerate(parts):
        # 获取原始位置和爆炸位置
        home_pos = Vector(part['home_pos'])
        explode_pos = Vector(part['explode_pos'])

        # 设置起始关键帧（合体状态）
        scene.frame_set(frame_start)
        part.location = home_pos
        part.keyframe_insert(data_path="location", frame=frame_start)

        # 设置结束关键帧（爆炸状态）
        scene.frame_set(frame_end)
        part.location = explode_pos
        part.keyframe_insert(data_path="location", frame=frame_end)

        print(f"  {i+1:2d}/15 {part.name:12s} : "
              f"{str(home_pos):25s} → {str(explode_pos)}")

    print(f"\n✅ 爆炸动画设置完成（帧 {frame_start} - {frame_end}）\n")


def setup_rotation_animation(parts: List[bpy.types.Object],
                             frame_start: int = 1, frame_end: int = 250):
    """设置整体旋转动画

    Args:
        parts: 部件列表
        frame_start: 起始帧
        frame_end: 结束帧
    """
    scene = bpy.context.scene

    # 创建父对象用于旋转
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
    pivot = bpy.context.active_object
    pivot.name = "Quest3_Pivot"

    # 将所有部件父化到 pivot
    for part in parts:
        part.parent = pivot

    # 设置旋转关键帧
    scene.frame_set(frame_start)
    pivot.rotation_euler = (0, 0, 0)
    pivot.keyframe_insert(data_path="rotation_euler", frame=frame_start)

    scene.frame_set(frame_end)
    pivot.rotation_euler = (0, 0, math.radians(360))
    pivot.keyframe_insert(data_path="rotation_euler", frame=frame_end)

    # 设置插值为线性（兼容不同 Blender 版本）
    try:
        for fcurve in pivot.animation_data.action.fcurves:
            for keyframe in fcurve.keyframe_points:
                keyframe.interpolation = 'LINEAR'
    except (AttributeError, TypeError):
        # 某些版本 API 不同，跳过插值设置
        pass

    print(f"✅ 旋转动画设置完成（{frame_start} - {frame_end} 帧，360°）\n")


def setup_environment():
    """设置场景环境（相机、灯光）"""
    scene = bpy.context.scene

    # 添加相机
    bpy.ops.object.camera_add(location=(4, -4, 2.5))
    camera = bpy.context.active_object
    camera.name = "Main Camera"
    camera.rotation_euler = (math.radians(70), 0, math.radians(45))
    scene.camera = camera

    # 添加主光源
    bpy.ops.object.light_add(type='SUN', location=(6, -6, 10))
    sun = bpy.context.active_object
    sun.name = "Sun Light"
    sun.data.energy = 3.0

    # 添加补光
    bpy.ops.object.light_add(type='POINT', location=(-5, -5, 3))
    fill = bpy.context.active_object
    fill.name = "Fill Light"
    fill.data.energy = 50

    # 添加轮廓光
    bpy.ops.object.light_add(type='POINT', location=(0, 5, 2))
    rim = bpy.context.active_object
    rim.name = "Rim Light"
    rim.data.energy = 30

    print("✅ 环境设置完成（相机 + 3 盏灯）\n")


def setup_render_settings(resolution_x: int = 1920, resolution_y: int = 1080,
                          frame_rate: int = 30):
    """设置渲染参数

    Args:
        resolution_x: 宽度
        resolution_y: 高度
        frame_rate: 帧率
    """
    scene = bpy.context.scene
    scene.render.resolution_x = resolution_x
    scene.render.resolution_y = resolution_y
    scene.render.resolution_percentage = 100
    scene.render.fps = frame_rate
    scene.frame_current = 1

    # 设置输出格式
    scene.render.image_settings.file_format = 'PNG'

    print(f"✅ 渲染设置: {resolution_x}x{resolution_y} @ {frame_rate}fps\n")


# ========== 主动画控制 ==========

def play_exploded_animation(duration_seconds: float = 5.0):
    """播放爆炸/合体动画

    Args:
        duration_seconds: 动画持续时间（秒）
    """
    scene = bpy.context.scene
    frame_rate = scene.render.fps
    total_frames = int(duration_seconds * frame_rate)

    # 设置当前场景帧范围
    scene.frame_start = 1
    scene.frame_end = total_frames

    # 设置动画为循环
    scene.render.fps = frame_rate

    print(f"🎬 播放爆炸动画（{duration_seconds}秒，{total_frames}帧）")
    print("   提示：在 Blender 中按 Space 播放\n")

    # 跳转到第一帧
    scene.frame_set(1)


def set_exploded_view(exploded: bool = True, frame: int = None):
    """设置爆炸视图状态

    Args:
        exploded: True = 爆炸状态, False = 合体状态
        frame: 指定帧（可选）
    """
    scene = bpy.context.scene

    if frame:
        scene.frame_set(frame)
    else:
        scene.frame_set(scene.frame_end if exploded else scene.frame_start)

    print(f"{'💥' if exploded else '🔒'} {'爆炸' if exploded else '合体'}状态（帧 {scene.frame_current}）\n")


# ========== 主函数 ==========

def main():
    """主函数"""
    print("\n" + "="*60)
    print("  Quest 3 爆炸拆解模型 - Blender Python 脚本")
    print("="*60 + "\n")

    # 1. 创建材质
    print("🎨 创建材质...")
    materials = create_materials()

    # 2. 清空场景
    print("🗑️  清空场景...")
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()

    # 3. 设置环境
    setup_environment()

    # 4. 创建 Quest 3 模型
    parts = create_quest3_model(materials)

    # 5. 设置爆炸动画
    setup_exploded_view(parts, frame_start=1, frame_end=100)

    # 6. 设置旋转动画
    setup_rotation_animation(parts, frame_start=1, frame_end=250)

    # 7. 设置渲染参数
    setup_render_settings(resolution_x=1920, resolution_y=1080, frame_rate=30)

    # 8. 设置为合体状态
    set_exploded_view(exploded=False)

    print("="*60)
    print("✅ Quest 3 爆炸拆解模型创建完成！")
    print("="*60)
    print("\n💡 使用提示：")
    print("   • 按 Space 播放/暂停动画")
    print("   • 拖动时间轴滑块查看不同帧")
    print("   • 帧 1 = 合体状态")
    print("   • 帧 100 = 完全爆炸")
    print("   • 按 Ctrl+Z 撤销操作")
    print("\n🎬 动画说明：")
    print("   • 爆炸动画：帧 1 → 100（约 3.3 秒）")
    print("   • 旋转动画：帧 1 → 250（约 8.3 秒）")
    print("   • 整体循环：约 8.3 秒")
    print()


if __name__ == "__main__":
    main()
