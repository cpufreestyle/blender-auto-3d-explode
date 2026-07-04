#!/usr/bin/env python3
"""
Blender 自动化示例 - 创建红色立方体

测试用：在 Blender 中创建一个红色立方体
"""

import bpy

# 清空场景
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# 创建立方体
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0, 0, 1))

# 获取创建的立方体
cube = bpy.context.active_object
cube.name = "AutoRedCube"

# 创建材质
mat = bpy.data.materials.new(name="RedMaterial")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs['Base Color'].default_value = (0.8, 0.2, 0.2, 1.0)  # 红色
bsdf.inputs['Roughness'].default_value = 0.3

# 应用材质
cube.data.materials.append(mat)

# 添加动画
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 100

# 关键帧 1
scene.frame_set(1)
cube.location = (0, 0, 1)
cube.keyframe_insert(data_path="location", frame=1)

# 关键帧 50
scene.frame_set(50)
cube.location = (0, 0, 4)
cube.keyframe_insert(data_path="location", frame=50)

# 关键帧 100
scene.frame_set(100)
cube.location = (0, 0, 1)
cube.keyframe_insert(data_path="location", frame=100)

# 添加光源
bpy.ops.object.light_add(type='SUN', location=(5, -5, 10))
sun = bpy.context.active_object
sun.data.energy = 3.0

# 设置相机
bpy.ops.object.camera_add(location=(5, -5, 3))
camera = bpy.context.active_object
camera.rotation_euler = (1.2, 0, 0.78)
scene.camera = camera

print("=" * 50)
print("  ✅ 示例脚本执行完成")
print("=" * 50)
print(f"📦 Blender 版本: {bpy.app.version}")
print(f"🎯 场景物体数量: {len(bpy.context.scene.objects)}")
print(f"🎬 创建物体: {cube.name}")
print(f"📹 相机: {camera.name}")
print(f"💡 光源: {sun.name}")
print("=" * 50)
