# Quest 3 爆炸拆解 - Blender 使用指南

## 📋 概述

这套脚本可以在 Blender 中创建完整的 Quest 3 爆炸拆解模型，包含 15 个独立部件和爆炸动画。

### 15 个部件

1. **主机身** - 黑色主体
2. **前面板** - 白色外壳
3. **面罩海绵** - 后面泡沫垫
4. **左透镜模组** - 深蓝色金属环
5. **右透镜模组** - 深蓝色金属环
6. **左透镜玻璃** - 透明蓝色镜片
7. **右透镜玻璃** - 透明蓝色镜片
8. **主板** - 绿色 PCB
9. **左摄像头** - 前置左侧
10. **右摄像头** - 前置右侧
11. **中置摄像头** - 前置中间
12. **下置追踪摄像头** - 底部追踪
13. **左头带臂** - 左侧连接臂
14. **右头带臂** - 右侧连接臂
15. **头带** - 顶部头带

---

## 🚀 快速开始

### 方法 1: 在 Blender UI 中运行

1. **打开 Blender**
2. **切换到 Scripting 工作区**
3. **点击 "New" 创建新脚本**
4. **删除默认代码，粘贴 `quest3_exploded_blender.py`**
5. **点击 "Run Script"** ▶️

**预期结果**：
- ✅ 15 个部件自动创建
- ✅ 材质自动应用
- ✅ 爆炸动画设置完成
- ✅ 可以按 Space 播放动画

---

### 方法 2: 命令行运行

```bash
# 后台运行（无界面）
blender --background --python quest3_exploded_blender.py

# 指定输出文件
blender --background --python quest3_exploded_blender.py -- --output quest3.blend
```

---

## 🎮 使用说明

### 播放爆炸动画

1. **打开 Blender 时间轴**（底部）
2. **按 Space 播放**
3. **观察爆炸效果**：
   - 帧 1-100：合体 → 爆炸
   - 帧 101-250：360° 旋转
   - 循环播放

### 手动控制

- **拖动时间轴滑块**：查看特定帧的爆炸状态
- **帧 1**：完全合体
- **帧 50**：半爆炸状态
- **帧 100**：完全爆炸
- **帧 250**：旋转一圈

### 调整动画速度

编辑脚本中的参数：

```python
# 爆炸持续时间（秒）
play_exploded_animation(duration_seconds=5.0)

# 旋转持续时间（秒）
setup_rotation_animation(parts, frame_start=1, frame_end=500)
```

---

## 🎨 自定义爆炸效果

### 修改爆炸距离

编辑 `quest3_explode_config.json` 中的 `explode_pos`：

```json
{
  "name": "前面板",
  "home_pos": [0, 0, 0.55],
  "explode_pos": [0, 0, 2.5]  // 修改这里的 Z 值
}
```

**数值越大，爆炸距离越远**

### 调整爆炸时间

```python
# 修改帧范围
setup_exploded_view(parts, frame_start=1, frame_end=200)  # 更慢的爆炸
setup_exploded_view(parts, frame_start=1, frame_end=50)   # 更快的爆炸
```

### 添加爆炸延迟

```python
# 在 config.json 中为每个部件设置 delay
{
  "name": "主板",
  "delay": 10  // 延迟 10 帧开始爆炸
}
```

---

## 📊 渲染输出

### 设置渲染参数

```python
setup_render_settings(
    resolution_x=1920,  # 宽度
    resolution_y=1080,  # 高度
    frame_rate=30       # 帧率
)
```

### 渲染单帧

1. 拖动时间轴到想要的帧
2. 点击 **Render → Render Image**

### 渲染动画

1. 点击 **Render → Render Animation**
2. 等待渲染完成
3. 输出在 `//render_####.png`

---

## 🎬 关键帧控制

### 查看关键帧

1. 选择物体
2. 打开 **Graph Editor**
3. 查看位置曲线

### 编辑动画曲线

1. 打开 **Graph Editor**
2. 选择关键帧
3. 按 **V** 改变插值类型：
   - `Linear` - 线性
   - `Bezier` - 贝塞尔（平滑）
   - `Constant` - 阶梯

### 导出动画

```python
# 导出为 FBX（带动画）
bpy.ops.export_scene.fbx(
    filepath="/path/to/quest3_exploded.fbx",
    use_selection=False
)
```

---

## 🔧 高级技巧

### 1. 添加相机动画

```python
# 在脚本中添加
def setup_camera_animation():
    scene = bpy.context.scene
    camera = bpy.data.objects["Main Camera"]

    # 关键帧 1
    scene.frame_set(1)
    camera.location = (4, -4, 2.5)
    camera.keyframe_insert(data_path="location", frame=1)

    # 关键帧 2
    scene.frame_set(100)
    camera.location = (6, 0, 3)
    camera.keyframe_insert(data_path="location", frame=100)

    # 旋转相机
    scene.frame_set(1)
    camera.rotation_euler = (math.radians(70), 0, math.radians(45))
    camera.keyframe_insert(data_path="rotation_euler", frame=1)

    scene.frame_set(100)
    camera.rotation_euler = (math.radians(60), 0, math.radians(90))
    camera.keyframe_insert(data_path="rotation_euler", frame=100)
```

### 2. 分层爆炸

修改脚本，让部件分批次爆炸：

```python
# 第一批：前面板、主板
# 第二批：摄像头
# 第三批：头带
```

### 3. 材质动画

```python
# 改变金属度
scene.frame_set(1)
mat = bpy.data.materials["LensBarrel"]
mat.node_tree.nodes["Principled BSDF"].inputs['Metallic'].default_value = 0.0
mat.keyframe_insert(...)

scene.frame_set(100)
mat.node_tree.nodes["Principled BSDF"].inputs['Metallic'].default_value = 1.0
mat.keyframe_insert(...)
```

---

## 📝 从配置加载

使用 JSON 配置文件动态加载爆炸配置：

```python
import json

def load_explode_config(config_path: str):
    """加载爆炸配置"""
    with open(config_path, 'r') as f:
        config = json.load(f)

    # 应用配置
    for part_config in config['parts']:
        part = bpy.data.objects.get(part_config['name'])
        if part:
            part['home_pos'] = Vector(part_config['home_pos'])
            part['explode_pos'] = Vector(part_config['explode_pos'])
            # 重新设置动画...

load_explode_config("quest3_explode_config.json")
```

---

## 🐛 常见问题

### Q: 部件太多，卡顿怎么办？

**A**: 降低视图质量：
- 点击 **Viewport Shading → Solid**
- 减少细分段数
- 使用 **Limit Selection to Visible**

### Q: 如何只渲染爆炸动画（不包含旋转）？

**A**: 删除或注释掉 `setup_rotation_animation()` 调用

### Q: 如何调整爆炸方向？

**A**: 修改 `quest3_explode_config.json` 中的 `explode_pos`

### Q: 如何导出为 GLB/GLTF？

**A**:
```python
bpy.ops.export_scene.gltf(
    filepath="/path/to/output.glb",
    export_format='GLB'
)
```

---

## 📚 相关文档

- **Blender Python API**: https://docs.blender.org/api/current/
- **动画指南**: https://docs.blender.org/manual/en/latest/animation/
- **渲染设置**: https://docs.blender.org/manual/en/latest/render/

---

## 🎯 下一步

1. **运行脚本**：在 Blender 中执行 `quest3_exploded_blender.py`
2. **播放动画**：按 Space 查看爆炸效果
3. **自定义配置**：修改 `quest3_explode_config.json`
4. **渲染输出**：渲染高质量图片或动画

---

**祝你使用愉快！有任何问题随时问我！** 🎉
