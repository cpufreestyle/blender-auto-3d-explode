# Blender Python API 快速入门

5 分钟上手 Blender Python 参数化控制！

---

## 🚀 3 步快速开始

### 第 1 步：打开 Blender

1. 启动 Blender
2. 删除默认立方体（按 Delete）

### 第 2 步：打开 Scripting 工作区

1. 点击顶部菜单 **Scripting**
2. 点击 **New** 创建新脚本
3. 删除默认代码

### 第 3 步：运行演示

粘贴以下代码：

```python
from blender_control import BlenderController

# 创建控制器
controller = BlenderController()

# 清空场景
controller.clear_scene()

# 创建红色立方体
cube = controller.create_cube("RedCube", size=2.0, location=(0, 0, 1))
controller.apply_material("RedCube", color=(0.8, 0.2, 0.2, 1.0))

# 创建蓝色球体
sphere = controller.create_sphere("BlueSphere", radius=1.0, location=(3, 0, 1))
controller.apply_material("BlueSphere", color=(0.2, 0.4, 0.8, 1.0))

# 添加动画
controller.add_animation("BlueSphere", "location",
                        start_value=(3, 0, 1),
                        end_value=(3, 0, 3),
                        start_frame=1,
                        end_frame=50)

print("✅ 完成！按 Space 播放动画")
```

点击 **Run Script** 🎉

---

## 📋 常用操作

### 创建物体

```python
# 立方体
controller.create_cube("Cube", size=2.0, location=(0, 0, 0))

# 球体
controller.create_sphere("Sphere", radius=1.0, location=(3, 0, 0))

# 圆柱体
controller.create_cylinder("Cylinder", radius=1.0, depth=2.0, location=(-3, 0, 0))
```

### 设置材质

```python
# 红色金属
controller.apply_material("Cube", color=(0.8, 0.2, 0.2, 1.0), metallic=0.8)

# 蓝色塑料
controller.apply_material("Sphere", color=(0.2, 0.4, 0.8, 1.0), roughness=0.9)

# 金色
controller.apply_material("Cylinder", color=(1.0, 0.84, 0.0, 1.0), metallic=1.0)
```

### 添加动画

```python
# 移动
controller.add_animation("Cube", "location",
                        start_value=(0, 0, 0),
                        end_value=(5, 0, 0),
                        start_frame=1,
                        end_frame=100)

# 旋转
controller.add_animation("Sphere", "rotation_euler",
                        start_value=(0, 0, 0),
                        end_value=(0, 0, 3.14),
                        start_frame=1,
                        end_frame=50)

# 缩放
controller.add_animation("Cylinder", "scale",
                        start_value=(1, 1, 1),
                        end_value=(2, 2, 2),
                        start_frame=1,
                        end_frame=60)
```

---

## 🎯 进阶：使用 JSON 配置文件

### 创建 config.json

```json
{
  "description": "我的第一个场景",
  "clear_scene": true,
  "objects": [
    {
      "type": "cube",
      "name": "GoldCube",
      "size": 2.0,
      "location": [0, 0, 1],
      "material": {
        "color": [1.0, 0.84, 0.0, 1.0],
        "metallic": 1.0,
        "roughness": 0.2
      }
    },
    {
      "type": "sphere",
      "name": "BlueBall",
      "radius": 1.2,
      "location": [3, 0, 1],
      "material": {
        "color": [0.2, 0.4, 0.8, 1.0],
        "metallic": 0.5,
        "roughness": 0.3
      }
    }
  ],
  "animations": [
    {
      "object": "GoldCube",
      "property": "location",
      "start_value": [0, 0, 1],
      "end_value": [0, 0, 4],
      "start_frame": 1,
      "end_frame": 100
    }
  ]
}
```

### 运行

```bash
blender --background --python blender_control.py -- --config config.json
```

---

## 🌐 高级：HTTP API 服务器

### 启动服务器

```bash
blender --background --python blender_api_server.py -- --port 8000
```

### 使用示例

```bash
# 1. 创建立方体
curl -X POST http://localhost:8000/api/create \
  -H "Content-Type: application/json" \
  -d '{"type":"cube","name":"MyCube","location":[0,0,0],"size":3.0}'

# 2. 设置金色材质
curl -X POST http://localhost:8000/api/material \
  -H "Content-Type: application/json" \
  -d '{"name":"MyCube","color":[1,0.84,0,1],"metallic":1}'

# 3. 添加移动动画
curl -X POST http://localhost:8000/api/animation \
  -H "Content-Type: application/json" \
  -d '{"object":"MyCube","property":"location","start_value":[0,0,0],"end_value":[5,0,0],"start_frame":1,"end_frame":100}'

# 4. 查看所有物体
curl http://localhost:8000/api/objects
```

---

## 🎨 颜色速查表

```python
# 基础颜色
红色:    (1.0, 0.0, 0.0, 1.0)
绿色:    (0.0, 1.0, 0.0, 1.0)
蓝色:    (0.0, 0.0, 1.0, 1.0)
黄色:    (1.0, 1.0, 0.0, 1.0)
青色:    (0.0, 1.0, 1.0, 1.0)
洋红:    (1.0, 0.0, 1.0, 1.0)
白色:    (1.0, 1.0, 1.0, 1.0)
黑色:    (0.0, 0.0, 0.0, 1.0)

# 金属颜色
金色:    (1.0, 0.84, 0.0, 1.0)
银色:    (0.75, 0.75, 0.75, 1.0)
铜色:    (0.72, 0.45, 0.2, 1.0)

# Quest 3 颜色
机身黑色: (0.12, 0.12, 0.13, 1.0)
前面板白: (0.97, 0.97, 0.97, 1.0)
透镜蓝:   (0.1, 0.18, 0.29, 1.0)
```

---

## 💡 实用技巧

### 1. 快速复制代码到 Blender

**在 Blender 中**：
1. 打开 Scripting 工作区
2. 点击 **New**
3. 粘贴代码
4. 按 **Ctrl+P** 运行

### 2. 查看控制台输出

**在 Blender 中**：
1. 切换到 **Scripting** 工作区
2. 右下角 **Console** 面板
3. 看到 `print()` 输出

### 3. 保存为 Blender 文件

```python
# 在脚本最后添加
bpy.ops.wm.save_as_mainfile(filepath="/path/to/save.blend")
```

### 4. 渲染单帧

```python
# 设置输出路径
bpy.context.scene.render.filepath = "/tmp/render.png"

# 渲染
bpy.ops.render.render(write_still=True)
```

---

## 📚 更多资源

- **完整文档**: [BLENDER_PYTHON_API.md](BLENDER_PYTHON_API.md)
- **代码示例**: `blender_control.py`
- **配置文件**: `blender_config.json`
- **API 服务器**: `blender_api_server.py`

---

## 🆘 获取帮助

遇到问题？

1. **查看控制台输出** - Blender 会显示错误信息
2. **检查文档** - [BLENDER_PYTHON_API.md](BLENDER_PYTHON_API.md)
3. **Blender 官方文档** - https://docs.blender.org/api/current/

---

**祝你使用愉快！** 🎉
