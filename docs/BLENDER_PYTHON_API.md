# Blender Python API 参数化控制系统

## 📋 目录

1. [简介](#简介)
2. [安装](#安装)
3. [使用方式](#使用方式)
4. [API 文档](#api-文档)
5. [示例](#示例)
6. [常见问题](#常见问题)

---

## 简介

这套系统让你可以用 Python 参数化控制 Blender，支持：

- ✅ **bpy 内置 API** - 在 Blender 内部运行
- ✅ **命令行批量处理** - 后台自动处理
- ✅ **HTTP API 服务器** - 远程控制 Blender
- ✅ **JSON 配置文件** - 参数化场景

### 核心特性

- 🎯 **参数化控制** - 通过 JSON 配置定义场景
- 🔄 **自动化批处理** - 无需手动操作
- 🌐 **远程控制** - HTTP API 服务器
- 📊 **可扩展** - 易于添加新功能

---

## 安装

### 1. 确保 Blender 已安装

```bash
# 检查 Blender 版本
blender --version

# 推荐版本：Blender 3.0+
```

### 2. 下载脚本

将以下文件放到你的项目目录：

- `blender_control.py` - 核心控制器
- `blender_api_server.py` - HTTP API 服务器（可选）
- `blender_config.json` - 配置文件（可选）

---

## 使用方式

### 方式 1: bpy 内置 API（推荐）

在 Blender 内部使用：

#### **方法 A: 通过 Blender UI**

1. 打开 Blender
2. 切换到 **Scripting** 工作区
3. 点击 **New** 创建新脚本
4. 粘贴 `blender_control.py` 代码
5. 点击 **Run Script**（播放按钮）

#### **方法 B: 通过命令行**

```bash
# 运行演示模式
blender --background --python blender_control.py -- --demo

# 使用配置文件
blender --background --python blender_control.py -- --config blender_config.json
```

---

### 方式 2: HTTP API 服务器（高级）

启动 HTTP 服务器，通过 REST API 远程控制 Blender：

```bash
# 启动服务器（在 Blender 内部）
blender --background --python blender_api_server.py -- --port 8000
```

然后通过 HTTP 请求控制：

```bash
# 查看 API 文档
curl http://localhost:8000/

# 获取所有物体
curl http://localhost:8000/api/objects

# 创建立方体
curl -X POST http://localhost:8000/api/create \
  -H "Content-Type: application/json" \
  -d '{"type":"cube","name":"MyCube","location":[0,0,0],"size":2.0}'

# 应用材质
curl -X POST http://localhost:8000/api/material \
  -H "Content-Type: application/json" \
  -d '{"name":"MyCube","color":[0.8,0.2,0.2,1.0],"metallic":0.3}'

# 清空场景
curl -X POST http://localhost:8000/api/clear
```

---

## API 文档

### BlenderController 类

#### 几何体创建

##### `create_cube(name, size, location, rotation)`

创建立方体

```python
controller.create_cube(
    name="MyCube",        # 名称
    size=2.0,             # 边长
    location=(0, 0, 0),   # 位置 (x, y, z)
    rotation=(0, 45, 0)   # 旋转角度（度）
)
```

##### `create_sphere(name, radius, location, segments)`

创建球体

```python
controller.create_sphere(
    name="MySphere",
    radius=1.5,
    location=(3, 0, 1),
    segments=32  # 细分段数
)
```

##### `create_cylinder(name, radius, depth, location)`

创建圆柱体

```python
controller.create_cylinder(
    name="MyCylinder",
    radius=1.0,
    depth=3.0,
    location=(0, 0, 1.5)
)
```

##### `create_torus(name, major_radius, minor_radius, location)`

创建圆环

```python
controller.create_torus(
    name="MyTorus",
    major_radius=1.5,
    minor_radius=0.4,
    location=(0, 0, 1)
)
```

##### `create_plane(name, size, location, rotation)`

创建平面

```python
controller.create_plane(
    name="MyPlane",
    size=5.0,
    location=(0, 0, 0),
    rotation=(90, 0, 0)  # 水平放置
)
```

---

#### 物体变换

##### `set_location(obj_name, location)`

设置位置

```python
controller.set_location("MyCube", (2, 0, 1))
```

##### `set_rotation(obj_name, rotation)`

设置旋转

```python
controller.set_rotation("MyCube", (0, 45, 90))  # X=0°, Y=45°, Z=90°
```

##### `set_scale(obj_name, scale)`

设置缩放

```python
controller.set_scale("MyCube", (2, 1, 1))  # X轴放大2倍
```

---

#### 材质

##### `apply_material(obj_name, color, metallic, roughness)`

应用材质

```python
controller.apply_material(
    obj_name="MyCube",
    color=(0.8, 0.2, 0.2, 1.0),  # RGBA
    metallic=0.5,                  # 金属度 0-1
    roughness=0.3                  # 粗糙度 0-1
)
```

**颜色示例**：
- 红色: `(1.0, 0.0, 0.0, 1.0)`
- 绿色: `(0.0, 1.0, 0.0, 1.0)`
- 蓝色: `(0.0, 0.0, 1.0, 1.0)`
- 金色: `(1.0, 0.84, 0.0, 1.0)`
- 银色: `(0.75, 0.75, 0.75, 1.0)`

---

#### 动画

##### `add_animation(obj_name, property_name, start_value, end_value, start_frame, end_frame)`

添加关键帧动画

```python
# 位置动画
controller.add_animation(
    obj_name="MyCube",
    property_name="location",
    start_value=(0, 0, 0),
    end_value=(5, 0, 0),
    start_frame=1,
    end_frame=100
)

# 旋转动画
controller.add_animation(
    obj_name="MyCube",
    property_name="rotation_euler",
    start_value=(0, 0, 0),
    end_value=(0, 0, 3.14159),  # 旋转180°
    start_frame=1,
    end_frame=50
)

# 缩放动画
controller.add_animation(
    obj_name="MySphere",
    property_name="scale",
    start_value=(1, 1, 1),
    end_value=(2, 2, 2),
    start_frame=1,
    end_frame=60
)
```

**可动画属性**：
- `location` - 位置
- `rotation_euler` - 旋转（欧拉角）
- `scale` - 缩放
- `data.materials[0].node_tree.nodes["Principled BSDF"].inputs['Base Color'].default_value` - 颜色

---

#### 相机和灯光

##### `add_camera(name, location, rotation)`

```python
controller.add_camera(
    name="MainCamera",
    location=(0, -5, 2),
    rotation=(70, 0, 0)
)
```

##### `add_light(name, light_type, location, energy)`

```python
controller.add_light(
    name="MainLight",
    light_type='SUN',       # 'POINT', 'SUN', 'SPOT', 'AREA'
    location=(5, -5, 10),
    energy=3.0              # 亮度
)
```

---

#### 场景管理

##### `clear_scene()`

清空场景

```python
controller.clear_scene()
```

##### `setup_environment()`

快速设置相机和灯光

```python
controller.setup_environment()
```

---

### 预设场景

#### `create_quest3_scene()`

创建 Quest 3 简化版模型

```python
create_quest3_scene()
```

#### `create_animated_cubes()`

创建动画立方体演示

```python
create_animated_cubes()
```

---

## 示例

### 示例 1: 基础场景

```python
from blender_control import BlenderController

# 创建控制器
controller = BlenderController()

# 清空场景
controller.clear_scene()

# 创建立方体
cube = controller.create_cube("RedCube", size=2.0, location=(0, 0, 1))

# 应用材质
controller.apply_material("RedCube", color=(0.8, 0.2, 0.2, 1.0), metallic=0.3)

# 创建球体
sphere = controller.create_sphere("BlueSphere", radius=1.0, location=(3, 0, 1))
controller.apply_material("BlueSphere", color=(0.2, 0.4, 0.8, 1.0))

# 添加动画
controller.add_animation("BlueSphere", "location",
                        start_value=(3, 0, 1),
                        end_value=(3, 0, 3),
                        start_frame=1,
                        end_frame=50)
```

### 示例 2: 使用 JSON 配置文件

**config.json**:
```json
{
  "description": "我的场景",
  "clear_scene": true,
  "objects": [
    {
      "type": "cube",
      "name": "Box1",
      "size": 2.0,
      "location": [0, 0, 1],
      "material": {
        "color": [1.0, 0.0, 0.0, 1.0]
      }
    }
  ],
  "animations": [
    {
      "object": "Box1",
      "property": "location",
      "start_value": [0, 0, 1],
      "end_value": [0, 0, 5],
      "start_frame": 1,
      "end_frame": 100
    }
  ]
}
```

**运行**:
```bash
blender --background --python blender_control.py -- --config config.json
```

### 示例 3: HTTP API 服务器

```bash
# 1. 启动服务器
blender --background --python blender_api_server.py -- --port 8000

# 2. 创建物体
curl -X POST http://localhost:8000/api/create \
  -H "Content-Type: application/json" \
  -d '{"type":"sphere","name":"Ball","location":[0,0,2],"radius":1.5}'

# 3. 设置颜色
curl -X POST http://localhost:8000/api/material \
  -H "Content-Type: application/json" \
  -d '{"name":"Ball","color":[0,1,0,1]}'

# 4. 添加动画
curl -X POST http://localhost:8000/api/animation \
  -H "Content-Type: application/json" \
  -d '{"object":"Ball","property":"location","start_value":[0,0,2],"end_value":[5,0,2],"start_frame":1,"end_frame":100}'
```

### 示例 4: 批处理渲染

```bash
#!/bin/bash

# 批量渲染不同配置的场景
for i in {1..5}; do
  blender --background --python blender_control.py -- --config config_$i.json \
    -- --render-output /output/frame_$i.png
done
```

---

## 常见问题

### Q1: 如何安装 bpy？

**A**: `bpy` 是 Blender 内置的 Python 模块，无需单独安装。只能在 Blender 的 Python 环境中使用。

### Q2: 可以在系统 Python 中使用吗？

**A**: 不可以。bpy 是 Blender 特有的模块。必须通过 Blender 运行脚本：

```bash
blender --python your_script.py
```

### Q3: 如何调试脚本？

**A**: 在 Blender 的 Scripting 工作区：
1. 打开 **Console** 面板
2. 点击 **Run Script**
3. 查看控制台输出

或使用 `print()` 语句，输出会显示在系统控制台。

### Q4: 如何批量处理多个文件？

**A**: 使用 `--background` 模式：

```bash
for file in *.blend; do
  blender --background --python process.py -- --input "$file"
done
```

### Q5: HTTP API 服务器如何远程访问？

**A**: 修改绑定地址：

```python
# 改为 0.0.0.0 监听所有接口
self.server = HTTPServer(('0.0.0.0', self.port), BlenderAPIHandler)
```

然后在防火墙中开放端口，就可以通过网络访问了。

### Q6: 如何导出场景为 glTF/GLB？

**A**: 在脚本中添加：

```python
# 导出为 glTF
bpy.ops.export_scene.gltf(
    filepath="/path/to/output.glb",
    export_format='GLB'
)
```

### Q7: 如何修改已有物体的属性？

**A**: 通过名称获取物体：

```python
obj = bpy.data.objects.get("MyCube")
if obj:
    obj.location = (5, 0, 0)
    obj.scale = (2, 2, 2)
```

---

## 📚 进阶资源

### 官方文档

- **Blender Python API**: https://docs.blender.org/api/current/
- **bpy 模块参考**: https://docs.blender.org/api/current/bpy.html
- **API 速查表**: https://docs.blender.org/api/current/info_quickstart.html

### 示例代码

- **Blender 官方示例**: https://docs.blender.org/api/current/info_tutorials.html
- **模板脚本**: https://docs.blender.org/api/current/info_tips_and_tricks.html

### 社区资源

- **Blender Artists**: https://blenderartists.org/
- **Python Scripting**: https://blender.stackexchange.com/

---

## 🔧 故障排除

### 问题：找不到模块 'bpy'

**解决**：确保通过 Blender 运行脚本，不要直接用系统 Python：

```bash
# ❌ 错误
python blender_control.py

# ✅ 正确
blender --python blender_control.py
```

### 问题：脚本运行但没有效果

**解决**：确保使用正确的上下文：

```python
# 在脚本开头添加
import bpy

# 切换到 Object 模式
if bpy.context.active_object:
    bpy.ops.object.mode_set(mode='OBJECT')
```

### 问题：动画不播放

**解决**：设置正确的帧范围：

```python
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 100
scene.frame_current = 1
```

---

## 📝 更新日志

### v1.0.0 (2026-07-04)

- ✅ 基础几何体创建（立方体、球体、圆柱体、圆环、平面）
- ✅ 物体变换（位置、旋转、缩放）
- ✅ 材质系统（颜色、金属度、粗糙度）
- ✅ 关键帧动画
- ✅ 相机和灯光控制
- ✅ JSON 配置文件支持
- ✅ HTTP API 服务器

---

**维护者**: Claude Code
**许可证**: MIT
**Blender 版本**: 3.0+
