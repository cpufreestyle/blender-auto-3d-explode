#!/usr/bin/env python3
"""
Blender Python API 参数化控制系统

功能：
- 创建几何体（立方体、球体、圆柱体等）
- 修改物体属性（位置、旋转、缩放）
- 应用材质
- 添加动画
- 导出场景

使用方法：
在 Blender 中：
1. 打开 Scripting 工作区
2. 新建脚本
3. 粘贴此代码
4. 点击 "Run Script"

或从命令行：
blender --background --python blender_control.py -- --config config.json
"""

import bpy
import json
import sys
import argparse
from math import radians
from typing import Dict, Any


class BlenderController:
    """Blender 控制器主类"""

    def __init__(self):
        self.scene = bpy.context.scene
        self.objects = bpy.data.objects

    def clear_scene(self):
        """清空场景"""
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete()
        print("✅ 场景已清空")

    def create_cube(self, name: str = "Cube", size: float = 2.0,
                   location: tuple = (0, 0, 0), rotation: tuple = (0, 0, 0)):
        """创建立方体

        Args:
            name: 物体名称
            size: 边长
            location: (x, y, z) 位置
            rotation: (x, y, z) 旋转角度（度）
        """
        bpy.ops.mesh.primitive_cube_add(
            size=size,
            location=location,
            rotation=tuple(radians(r) for r in rotation)
        )
        obj = bpy.context.active_object
        obj.name = name
        print(f"✅ 创建立方体: {name}, 尺寸: {size}, 位置: {location}")
        return obj

    def create_sphere(self, name: str = "Sphere", radius: float = 1.0,
                     location: tuple = (0, 0, 0), segments: int = 32):
        """创建球体

        Args:
            name: 物体名称
            radius: 半径
            location: (x, y, z) 位置
            segments: 细分段数
        """
        bpy.ops.mesh.primitive_uv_sphere_add(
            radius=radius,
            location=location,
            segments=segments
        )
        obj = bpy.context.active_object
        obj.name = name
        print(f"✅ 创建球体: {name}, 半径: {radius}, 位置: {location}")
        return obj

    def create_cylinder(self, name: str = "Cylinder", radius: float = 1.0,
                       depth: float = 2.0, location: tuple = (0, 0, 0)):
        """创建圆柱体

        Args:
            name: 物体名称
            radius: 半径
            depth: 高度
            location: (x, y, z) 位置
        """
        bpy.ops.mesh.primitive_cylinder_add(
            radius=radius,
            depth=depth,
            location=location
        )
        obj = bpy.context.active_object
        obj.name = name
        print(f"✅ 创建圆柱体: {name}, 半径: {radius}, 高度: {depth}")
        return obj

    def create_torus(self, name: str = "Torus", major_radius: float = 1.0,
                    minor_radius: float = 0.25, location: tuple = (0, 0, 0)):
        """创建圆环

        Args:
            name: 物体名称
            major_radius: 主半径
            minor_radius: 次半径
            location: (x, y, z) 位置
        """
        bpy.ops.mesh.primitive_torus_add(
            major_radius=major_radius,
            minor_radius=minor_radius,
            location=location
        )
        obj = bpy.context.active_object
        obj.name = name
        print(f"✅ 创建圆环: {name}, 主半径: {major_radius}, 次半径: {minor_radius}")
        return obj

    def create_plane(self, name: str = "Plane", size: float = 2.0,
                    location: tuple = (0, 0, 0), rotation: tuple = (0, 0, 0)):
        """创建平面

        Args:
            name: 物体名称
            size: 大小
            location: (x, y, z) 位置
            rotation: (x, y, z) 旋转角度（度）
        """
        bpy.ops.mesh.primitive_plane_add(
            size=size,
            location=location,
            rotation=tuple(radians(r) for r in rotation)
        )
        obj = bpy.context.active_object
        obj.name = name
        print(f"✅ 创建平面: {name}, 大小: {size}, 位置: {location}")
        return obj

    def set_location(self, obj_name: str, location: tuple):
        """设置物体位置

        Args:
            obj_name: 物体名称
            location: (x, y, z)
        """
        obj = self.objects.get(obj_name)
        if obj:
            obj.location = location
            print(f"✅ 设置位置 {obj_name}: {location}")
        else:
            print(f"❌ 物体不存在: {obj_name}")

    def set_rotation(self, obj_name: str, rotation: tuple):
        """设置物体旋转（欧拉角，度）

        Args:
            obj_name: 物体名称
            rotation: (x, y, z) 角度
        """
        obj = self.objects.get(obj_name)
        if obj:
            obj.rotation_euler = tuple(radians(r) for r in rotation)
            print(f"✅ 设置旋转 {obj_name}: {rotation}°")
        else:
            print(f"❌ 物体不存在: {obj_name}")

    def set_scale(self, obj_name: str, scale: tuple):
        """设置物体缩放

        Args:
            obj_name: 物体名称
            scale: (x, y, z) 缩放值
        """
        obj = self.objects.get(obj_name)
        if obj:
            obj.scale = scale
            print(f"✅ 设置缩放 {obj_name}: {scale}")
        else:
            print(f"❌ 物体不存在: {obj_name}")

    def apply_material(self, obj_name: str, color: tuple = (0.8, 0.2, 0.2, 1.0),
                      metallic: float = 0.0, roughness: float = 0.5):
        """应用材质

        Args:
            obj_name: 物体名称
            color: (R, G, B, A) 颜色值
            metallic: 金属度 0-1
            roughness: 粗糙度 0-1
        """
        obj = self.objects.get(obj_name)
        if not obj:
            print(f"❌ 物体不存在: {obj_name}")
            return

        # 创建新材质
        mat = bpy.data.materials.new(name=f"{obj_name}_Material")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes["Principled BSDF"]

        # 设置属性
        bsdf.inputs['Base Color'].default_value = color
        bsdf.inputs['Metallic'].default_value = metallic
        bsdf.inputs['Roughness'].default_value = roughness

        # 应用材质
        if obj.data.materials:
            obj.data.materials[0] = mat
        else:
            obj.data.materials.append(mat)

        print(f"✅ 应用材质 {obj_name}: 颜色={color}, 金属度={metallic}, 粗糙度={roughness}")

    def add_animation(self, obj_name: str, property_name: str,
                     start_value: float, end_value: float,
                     start_frame: int = 1, end_frame: int = 100):
        """为物体属性添加动画

        Args:
            obj_name: 物体名称
            property_name: 属性名（如 'location', 'rotation_euler', 'scale'）
            start_value: 起始值
            end_value: 结束值
            start_frame: 起始帧
            end_frame: 结束帧
        """
        obj = self.objects.get(obj_name)
        if not obj:
            print(f"❌ 物体不存在: {obj_name}")
            return

        # 设置起始关键帧
        self.scene.frame_set(start_frame)
        setattr(obj, property_name, start_value)
        obj.keyframe_insert(data_path=property_name, frame=start_frame)

        # 设置结束关键帧
        self.scene.frame_set(end_frame)
        setattr(obj, property_name, end_value)
        obj.keyframe_insert(data_path=property_name, frame=end_frame)

        print(f"✅ 添加动画 {obj_name}.{property_name}: {start_value} → {end_value}")

    def add_camera(self, name: str = "Camera", location: tuple = (0, -5, 2),
                  rotation: tuple = (70, 0, 0)):
        """添加相机

        Args:
            name: 相机名称
            location: 位置
            rotation: 旋转角度（度）
        """
        bpy.ops.object.camera_add(location=location)
        cam = bpy.context.active_object
        cam.name = name
        cam.rotation_euler = tuple(radians(r) for r in rotation)

        # 设置为活动相机
        self.scene.camera = cam

        print(f"✅ 添加相机: {name}, 位置: {location}")
        return cam

    def add_light(self, name: str = "Light", light_type: str = 'POINT',
                 location: tuple = (0, 0, 5), energy: float = 100):
        """添加灯光

        Args:
            name: 灯光名称
            light_type: 灯光类型（'POINT', 'SUN', 'SPOT', 'AREA'）
            location: 位置
            energy: 亮度
        """
        bpy.ops.object.light_add(type=light_type, location=location)
        light = bpy.context.active_object
        light.name = name
        light.data.energy = energy

        print(f"✅ 添加灯光: {name}, 类型: {light_type}, 亮度: {energy}")
        return light

    def setup_environment(self):
        """设置基础环境"""
        # 添加相机
        self.add_camera()

        # 添加灯光
        self.add_light("Main_Light", 'SUN', location=(5, -5, 10), energy=3)
        self.add_light("Fill_Light", 'POINT', location=(-5, -5, 5), energy=50)
        self.add_light("Rim_Light", 'POINT', location=(0, 5, 3), energy=30)

        print("✅ 环境设置完成")

    def execute_from_config(self, config: Dict[str, Any]):
        """从配置文件执行操作

        Args:
            config: 配置字典
        """
        print(f"\n📋 加载配置文件: {config.get('description', '未命名')}")

        # 清空场景
        if config.get('clear_scene', True):
            self.clear_scene()

        # 执行创建物体
        for obj_config in config.get('objects', []):
            obj_type = obj_config.get('type')
            obj_name = obj_config.get('name', f"Object_{len(self.objects)}")

            if obj_type == 'cube':
                self.create_cube(
                    name=obj_name,
                    size=obj_config.get('size', 2.0),
                    location=tuple(obj_config.get('location', [0, 0, 0])),
                    rotation=tuple(obj_config.get('rotation', [0, 0, 0]))
                )

            elif obj_type == 'sphere':
                self.create_sphere(
                    name=obj_name,
                    radius=obj_config.get('radius', 1.0),
                    location=tuple(obj_config.get('location', [0, 0, 0])),
                    segments=obj_config.get('segments', 32)
                )

            elif obj_type == 'cylinder':
                self.create_cylinder(
                    name=obj_name,
                    radius=obj_config.get('radius', 1.0),
                    depth=obj_config.get('depth', 2.0),
                    location=tuple(obj_config.get('location', [0, 0, 0]))
                )

            elif obj_type == 'plane':
                self.create_plane(
                    name=obj_name,
                    size=obj_config.get('size', 2.0),
                    location=tuple(obj_config.get('location', [0, 0, 0])),
                    rotation=tuple(obj_config.get('rotation', [0, 0, 0]))
                )

            # 应用材质
            if 'material' in obj_config:
                mat = obj_config['material']
                self.apply_material(
                    obj_name,
                    color=tuple(mat.get('color', [0.8, 0.2, 0.2, 1.0])),
                    metallic=mat.get('metallic', 0.0),
                    roughness=mat.get('roughness', 0.5)
                )

        # 执行动画
        for anim_config in config.get('animations', []):
            obj_name = anim_config.get('object')
            prop = anim_config.get('property')
            start = anim_config.get('start_value')
            end = anim_config.get('end_value')
            start_frame = anim_config.get('start_frame', 1)
            end_frame = anim_config.get('end_frame', 100)

            self.add_animation(obj_name, prop, start, end, start_frame, end_frame)

        # 设置渲染输出
        if 'render' in config:
            render = config['render']
            self.scene.render.resolution_x = render.get('resolution_x', 1920)
            self.scene.render.resolution_y = render.get('resolution_y', 1080)
            self.scene.frame_start = render.get('start_frame', 1)
            self.scene.frame_end = render.get('end_frame', 100)
            print(f"✅ 渲染设置: {self.scene.render.resolution_x}x{self.scene.render.resolution_y}")

        print("✅ 配置执行完成\n")


def load_config(config_path: str) -> Dict[str, Any]:
    """从 JSON 文件加载配置

    Args:
        config_path: 配置文件路径

    Returns:
        配置字典
    """
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        print(f"✅ 加载配置文件: {config_path}")
        return config
    except Exception as e:
        print(f"❌ 加载配置文件失败: {e}")
        return {}


def main():
    """主函数"""
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='Blender Python API 控制器')
    parser.add_argument('--config', type=str, help='配置文件路径')
    parser.add_argument('--demo', action='store_true', help='运行演示模式')
    args = parser.parse_args()

    # 创建控制器
    controller = BlenderController()

    if args.demo:
        print("\n🎬 运行演示模式...\n")
        controller.clear_scene()

        # 演示：创建一个简单的场景
        controller.setup_environment()

        # 创建红色立方体
        cube = controller.create_cube("RedCube", size=2.0, location=(0, 0, 1))
        controller.apply_material("RedCube", color=(0.8, 0.2, 0.2, 1.0), metallic=0.3)

        # 创建蓝色球体
        sphere = controller.create_sphere("BlueSphere", radius=1.2, location=(3, 0, 1))
        controller.apply_material("BlueSphere", color=(0.2, 0.4, 0.8, 1.0), metallic=0.5)

        # 创建绿色圆柱体
        cylinder = controller.create_cylinder("GreenCylinder", radius=0.8, depth=3,
                                              location=(-3, 0, 1.5))
        controller.apply_material("GreenCylinder", color=(0.2, 0.8, 0.3, 1.0), roughness=0.7)

        # 添加动画
        controller.add_animation("BlueSphere", "location", (3, 0, 1), (3, 0, 3), 1, 50)
        controller.add_animation("BlueSphere", "location", (3, 0, 3), (3, 0, 1), 50, 100)

        print("\n🎬 演示场景创建完成！")
        print("💡 提示：按 Space 播放动画")

    elif args.config:
        config = load_config(args.config)
        if config:
            controller.execute_from_config(config)

    else:
        print("\n💡 使用方法：")
        print("   blender --background --python blender_control.py -- --demo")
        print("   blender --background --python blender_control.py -- --config config.json\n")


# ========== 预设场景示例 ==========

def create_quest3_scene():
    """创建 Quest 3 简化版场景"""
    controller = BlenderController()
    controller.clear_scene()
    controller.setup_environment()

    # 主机身
    body = controller.create_cube("Body", size=2.0, location=(0, 0, 0.5))
    controller.apply_material("Body", color=(0.12, 0.12, 0.13, 1.0), roughness=0.6)

    # 前面板
    front = controller.create_cube("Front", size=1.8, location=(0, 0.05, 0.5))
    controller.apply_material("Front", color=(0.97, 0.97, 0.97, 1.0), roughness=0.35)

    # 透镜
    lens_l = controller.create_cylinder("Lens_L", radius=0.35, depth=0.3, location=(-0.5, 0.5, 0.5))
    lens_l.rotation_euler = (radians(90), 0, 0)
    controller.apply_material("Lens_L", color=(0.1, 0.18, 0.29, 1.0), metallic=0.55, roughness=0.2)

    lens_r = controller.create_cylinder("Lens_R", radius=0.35, depth=0.3, location=(0.5, 0.5, 0.5))
    lens_r.rotation_euler = (radians(90), 0, 0)
    controller.apply_material("Lens_R", color=(0.1, 0.18, 0.29, 1.0), metallic=0.55, roughness=0.2)

    print("\n✅ Quest 3 场景创建完成！")


def create_animated_cubes():
    """创建动画立方体演示"""
    controller = BlenderController()
    controller.clear_scene()
    controller.setup_environment()

    for i in range(5):
        cube = controller.create_cube(
            f"Cube_{i}",
            size=1.0,
            location=(i * 2.5 - 5, 0, 1)
        )
        color = (i / 5, 0.5, 1 - i / 5, 1.0)
        controller.apply_material(f"Cube_{i}", color=color, metallic=0.3)

        # 添加旋转动画
        controller.add_animation(
            f"Cube_{i}",
            "rotation_euler",
            (0, 0, 0),
            (0, 0, radians(360)),
            start_frame=1 + i * 10,
            end_frame=100 + i * 10
        )

    print("\n✅ 动画立方体场景创建完成！")


if __name__ == "__main__":
    main()

    # 可选：取消注释来运行预设场景
    # create_quest3_scene()
    # create_animated_cubes()
