# 🤖 Claude Code + Blender 自动化集成

让 Claude Code 自动控制 Blender 的完整方案

---

## 📋 目录

1. [方案概述](#方案概述)
2. [快速开始](#快速开始)
3. [使用示例](#使用示例)
4. [进阶：HTTP API](#进阶http-api)
5. [实际工作流程](#实际工作流程)
6. [常见问题](#常见问题)

---

## 方案概述

### 已实现的方案

| 方案 | 文件 | 复杂度 | 实时性 |
|------|------|--------|--------|
| **文件监听** | `blender_watcher.py` | ⭐ 简单 | ⚡ 准实时 |
| **HTTP API** | `blender_api_server.py` | ⭐⭐ 中等 | ⚡ 实时 |
| **命令行** | `blender_control.py` | ⭐ 简单 | ⏱️ 延迟 |

### 工作流程

```
你: "帮我创建一个红色立方体"
    ↓
我: 生成 Python 脚本
    ↓
保存到 blender_scripts/ 目录
    ↓
Watchdog 监听检测到变化
    ↓
自动在 Blender 中执行
    ↓
返回结果给你
```

---

## 快速开始

### 前置要求

1. ✅ Blender 已安装（版本 3.0+）
   ```bash
   # 检查
   /Applications/Blender.app/Contents/MacOS/Blender --version
   ```

2. ✅ Python 3.7+
   ```bash
   python3 --version
   ```

3. ✅ 安装依赖
   ```bash
   pip3 install watchdog
   ```

### 方法 1：文件监听（推荐）

#### 启动监听器

```bash
# 1. 进入项目目录
cd /Users/a1-6/quest3-exploded

# 2. 运行启动脚本
chmod +x start_blender_watcher.sh
./start_blender_watcher.sh

# 或直接运行
python3 blender_watcher.py
```

**监听器启动后会显示：**
```
========================================
  Blender 文件监听自动执行器
========================================
📂 监听目录: /Users/a1-6/quest3-exploded/blender_scripts
📂 输出目录: /Users/a1-6/quest3-exploded/blender_output
🔧 Blender: /Applications/Blender.app/Contents/MacOS/Blender
📝 测试模式: 否
========================================

👀 开始监听文件变化...
💡 提示：
   - 将 Python 脚本保存到 /Users/a1-6/quest3-exploded/blender_scripts
   - 保存后会自动在 Blender 中执行
   - 按 Ctrl+C 停止监听
```

#### 使用示例

**步骤 1：** 创建 Python 脚本

```python
# 保存到: blender_scripts/my_first_script.py
import bpy

# 创建蓝色球体
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.5, location=(0, 0, 1))
sphere = bpy.context.active_object

# 应用蓝色材质
mat = bpy.data.materials.new(name="BlueMat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs['Base Color'].default_value = (0.2, 0.4, 0.8, 1.0)
sphere.data.materials.append(mat)

print("✅ 蓝色球体创建成功！")
```

**步骤 2：** 保存文件

**步骤 3：** 观察自动执行
```
📝 检测到脚本变化: my_first_script.py
🚀 正在 Blender 中执行: my_first_script.py
📄 输出保存到: ./blender_output/my_first_script_output.txt

✅ 示例脚本执行完成
📦 Blender 版本: (5, 1, 2)
🎯 场景物体数量: 1
🎬 创建物体: Sphere
```

---

## 使用示例

### 示例 1：创建 Quest 3 爆炸视图

```python
# blender_scripts/quest3_exploded.py
import bpy

# 清空场景
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# 创建 15 个部件（简化版）
parts = []
for i in range(15):
    # 创建立方体
    bpy.ops.mesh.primitive_cube_add(size=0.5, location=(i * 1.2, 0, 0))
    cube = bpy.context.active_object
    cube.name = f"Part_{i+1}"

    # 应用材质
    mat = bpy.data.materials.new(name=f"Mat_{i+1}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]

    # 随机颜色
    import random
    bsdf.inputs['Base Color'].default_value = (*random.random(), 1.0)
    cube.data.materials.append(mat)

    parts.append(cube)

# 设置爆炸动画
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 100

for i, part in enumerate(parts):
    # 起始位置（合体）
    scene.frame_set(1)
    part.location = (0, 0, 0)
    part.keyframe_insert(data_path="location", frame=1)

    # 结束位置（爆炸）
    scene.frame_set(100)
    part.location = (i * 1.5, i * 0.3, i * 0.2)
    part.keyframe_insert(data_path="location", frame=100)

print(f"✅ 创建了 {len(parts)} 个部件并设置爆炸动画")
```

保存后，Blender 会自动创建 15 个部件并生成爆炸动画！

---

### 示例 2：自动修复材质（基于错误日志）

当 Blender 报错时，我可以：

1. **分析错误日志**
   ```
   KeyError: 'bpy_prop_collection[key]: key "Transmission" not found'
   ```

2. **自动修复代码**
   ```python
   # 在 create_materials() 函数中添加检查
   if 'Transmission' in bsdf.inputs:
       bsdf.inputs['Transmission'].default_value = 0.95
   ```

3. **保存并重新执行**
   - 保存修复后的脚本
   - Watchdog 自动检测
   - Blender 重新执行
   - 错误消失 ✅

---

### 示例 3：从 JSON 配置生成场景

```python
# blender_scripts/load_config.py
import bpy
import json

# 读取配置
config_path = "/Users/a1-6/quest3-exploded/quest3_explode_config.json"
with open(config_path) as f:
    config = json.load(f)

# 创建场景
for part_config in config['parts']:
    # 创建立方体
    bpy.ops.mesh.primitive_cube_add(
        size=0.5,
        location=part_config['home_pos']
    )

    # 应用材质
    mat = bpy.data.materials.new(name=part_config['material'])
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]

    # 根据材质类型设置颜色
    if 'body' in part_config['material']:
        bsdf.inputs['Base Color'].default_value = (0.12, 0.12, 0.13, 1.0)  # 黑色
    elif 'frontPlate' in part_config['material']:
        bsdf.inputs['Base Color'].default_value = (0.97, 0.97, 0.97, 1.0)  # 白色

    bpy.context.active_object.data.materials.append(mat)

print(f"✅ 从配置创建了 {len(config['parts'])} 个部件")
```

---

## 进阶：HTTP API

### 启动 Blender HTTP 服务器

```bash
# 在 Blender 中启动 API 服务器
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python blender_api_server.py \
  -- --port 8000
```

### 使用 API

#### 1. 创建物体

```bash
curl -X POST http://localhost:8000/api/create \
  -H "Content-Type: application/json" \
  -d '{"type":"cube","name":"MyCube","location":[0,0,0],"size":2.0}'
```

#### 2. 应用材质

```bash
curl -X POST http://localhost:8000/api/material \
  -H "Content-Type: application/json" \
  -d '{"name":"MyCube","color":[0.8,0.2,0.2,1.0],"metallic":0.3}'
```

#### 3. 添加动画

```bash
curl -X POST http://localhost:8000/api/animation \
  -H "Content-Type: application/json" \
  -d '{"object":"MyCube","property":"location","start_value":[0,0,0],"end_value":[5,0,0],"start_frame":1,"end_frame":100}'
```

#### 4. 查看所有物体

```bash
curl http://localhost:8000/api/objects
```

---

## 实际工作流程

### 工作流程 1：开发调试

```
1. 你：在 Blender 中写 Python 脚本
2. 我：监听文件变化
3. 自动：在 Blender 中执行
4. 自动：保存输出到 blender_output/
5. 你：查看结果，继续修改
```

### 工作流程 2：AI 辅助开发

```
1. 你："帮我创建一个 Quest 3 爆炸视图"
2. 我：生成完整脚本
3. 保存到: blender_scripts/quest3.py
4. 自动执行
5. 返回结果和日志
```

### 工作流程 3：错误自动修复

```
1. Blender 报错: KeyError 'Transmission' not found
2. 我：读取日志，分析错误
3. 我：自动修复代码
4. 保存脚本
5. 自动重新执行
6. 确认修复成功
```

---

## 常见问题

### Q1: 监听器启动失败

**错误：** `No module named 'watchdog'`

**解决：**
```bash
pip3 install watchdog
```

### Q2: Blender 找不到

**错误：** `找不到 Blender`

**解决：** 修改 `blender_watcher.py` 中的路径：
```python
BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender"
```

### Q3: 文件变化太频繁

**问题：** 保存一次触发多次执行

**解决：** 调整防抖时间：
```python
self.debounce_seconds = 2.0  # 改为 2 秒
```

### Q4: 输出在哪里？

**答案：** 所有输出保存到 `blender_output/<script_name>_output.txt`

查看最新输出：
```bash
tail -f blender_output/example_red_cube_output.txt
```

---

## 🎯 下一步

### 立即可用

1. **启动监听器**
   ```bash
   ./start_blender_watcher.sh
   ```

2. **创建你的第一个脚本**
   ```bash
   # 使用示例脚本
   cp blender_scripts/example_red_cube.py blender_scripts/my_test.py
   # 编辑 my_test.py
   # 保存，观察自动执行
   ```

3. **让我帮你创建脚本**
   - 告诉我你想在 Blender 中做什么
   - 我生成 Python 脚本
   - 保存到 `blender_scripts/`
   - 自动执行

---

## 🚀 高级：完整集成方案

### 自动化流水线

```
用户请求
  ↓
我生成 Blender Python 脚本
  ↓
保存到 blender_scripts/
  ↓
[Watchdog 监听]
  ↓
自动执行 Blender
  ↓
保存输出到 blender_output/
  ↓
我读取输出
  ↓
分析结果
  ↓
如有错误 → 自动修复 → 重新执行
  ↓
成功 → 通知用户
```

### 我可以自动化

- ✅ 生成 Blender Python 脚本
- ✅ 保存到指定目录
- ✅ 读取执行结果
- ✅ 分析错误日志
- ✅ 自动修复代码
- ✅ 重新执行验证
- ⚠️ **启动监听器**（需要您执行一次）

---

**准备好测试了吗？**

1. 运行 `./start_blender_watcher.sh`
2. 告诉我你想创建什么
3. 看我来写脚本 🚀
