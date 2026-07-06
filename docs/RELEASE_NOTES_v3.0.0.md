# 🎨 v3.0.0 Release Notes — AI 绘画引擎全面升级

**发布日期**: 2026-07-06  
**版本号**: v3.0.0  
**状态**: ✅ Stable  
**代号**: "Creative Studio"

---

## 🎯 核心亮点

v3.0.0 是项目历史上最大规模的功能升级，将简单的 3D 拆解工具升级为完整的 **AI 驱动 3D 创作平台**。

### ✨ 四大新模块

| 模块 | 功能 | 技术亮点 |
|------|------|----------|
| 🧠 智能提示词 | 权重匹配算法 | 解决"超人≠女人"的语义冲突 |
| 🦸 超级英雄 | 5位英雄完整建模 | 布料模拟+布尔运算+位移修改器 |
| 🧱 乐高风格 | 积木拼接系统 | 凸点自动生成+塑料材质 |
| 🎬 渲染特效 | 8大高级效果 | 三点布光+AO+Bloom+SSR |

---

## 🧠 智能提示词匹配系统

### 权重算法

```python
PROMPT_TEMPLATES = [
    # 超级英雄类（最高优先级）
    {'keywords': ['超人', 'superman'], 'weight': 100},
    {'keywords': ['蝙蝠侠', 'batman'], 'weight': 100},
    
    # 角色类
    {'keywords': ['美女', '女性'], 'weight': 80},
    {'keywords': ['男人', '男性'], 'weight': 80},
    
    # 物体类
    {'keywords': ['机器人', 'robot'], 'weight': 70},
    {'keywords': ['汽车', 'car'], 'weight': 70},
    
    # 泛角色（兜底）
    {'keywords': ['人', 'person'], 'weight': 30},
]
```

### 解决的问题

**Before**: 输入"超人" → 匹配到"人" → 生成女性角色 ❌  
**After**: 输入"超人" → 权重 100 > 30 → 生成超人 ✅

---

## 🦸 超级英雄生成器

### 支持的超级英雄

| 英雄 | 特征 | 技术实现 |
|------|------|----------|
| **超人** | 蓝色紧身衣+红色披风+S胸章 | 布料模拟+文本布尔 |
| **蝙蝠侠** | 黑色战甲+蝙蝠披风+蝙蝠标志 | 细分曲面+布尔运算 |
| **钢铁侠** | 红金装甲+反应堆+头盔 | 倒角修改器+金属材质 |
| **蜘蛛侠** | 红蓝战衣+蛛网纹理 | 位移修改器+程序化纹理 |
| **美队** | 蓝色制服+星盾+条纹 | 布尔运算+阵列修改器 |

### 使用示例

```bash
# 生成超人
curl -X POST http://localhost:3001/api/ai-paint \
  -H "Content-Type: application/json" \
  -d '{"prompt":"超人"}'

# 生成蝙蝠侠
curl -X POST http://localhost:3001/api/ai-paint \
  -H "Content-Type: application/json" \
  -d '{"prompt":"蝙蝠侠"}'
```

---

## 🧱 乐高风格生成器

### 三种模型类型

#### 1. 乐高人仔
- 左腿、右腿（独立方块）
- 身体（主体方块）
- 左臂、右臂（小方块）
- 头部（圆柱）
- 头顶凸点

#### 2. 乐高汽车
- 底盘（长方块）
- 车身（中方块）
- 车顶（小方块）
- 轮子×4（圆柱）

#### 3. 乐高房子
- 地基（大方块）
- 一层、二层（递减方块）
- 金字塔屋顶（三层堆叠）
- 门（扁平方块）

### 技术细节

```python
# 凸点自动生成
def create_lego_brick(name, loc, size=(1, 1, 0.6)):
    # 主体方块 + 倒角
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    apply_bevel_mod(brick, width=0.02, segments=2)
    
    # 顶部凸点（根据大小自动计算数量）
    stud_count_x = max(1, int(size[0]))
    stud_count_y = max(1, int(size[1]))
    for i in range(stud_count_x):
        for j in range(stud_count_y):
            # 凸点位置计算...
```

### 颜色支持

支持 11 种乐高经典颜色：
🔴 红 | 🔵 蓝 | 🟢 绿 | 🟡 黄 | ⚪ 白 | ⚫ 黑 | 🟠 橙 | 🟣 紫 | 🩷 粉 | ⚪ 灰 | 🟤 棕

---

## 🖼️ 图片上传增强

### 特征提取

上传图片后，系统自动提取：

| 特征 | 用途 |
|------|------|
| **主色调** | 影响模型整体配色 |
| **亮度** | 影响材质明暗度 |
| **对称度** | 影响模型布局对称性 |
| **边缘密度** | 影响模型细节程度 |
| **宽高比** | 影响模型比例拉伸 |

### 使用方式

1. 在 AI 绘画区域点击"📎 添加参考图"
2. 上传图片（JPG/PNG）
3. 输入提示词
4. 生成的模型会融合图片特征

---

## 🎬 8大高级渲染特效

### 灯光系统
- **三点布光**: 主光(Key)+补光(Fill)+轮廓光(Rim)
- **环境光遮蔽(AO)**: 增强角落阴影

### 材质效果
- **辉光(Bloom)**: 高亮区域发光
- **屏幕空间反射(SSR)**: 真实反射
- **倒角(Bevel)**: 边缘圆角
- **加权法线**: 平滑着色

### 纹理与后期
- **程序化纹理**: 噪波/砖块/木纹
- **阴影捕捉地面**: 真实投影

---

## 🖥️ UI/UX 升级

### 精凑化布局

```css
/* CSS 变量间距系统 */
--sp-1: 4px;
--sp-2: 8px;
--sp-3: 12px;
--sp-4: 16px;
--sp-5: 24px;
```

### 可折叠面板

```html
<details class="panel collapsible">
  <summary class="panel-header">
    <span>🎨 AI 绘画</span>
    <span class="chevron">▾</span>
  </summary>
  <div class="panel-body">...</div>
</details>
```

### 步骤控制修复

**问题**: 爆炸视图模式下，上一步/下一步/重置按钮点击无反应

**根因**: 鼠标控制模式(`mouseControlEnabled`)下，部件位置由 `mouseFactor` 控制，而非 `currentStep`

**修复**: 
```javascript
function exitMouseControl() {
  mouseControlEnabled = false;
  displayedStep = Math.round(mouseFactor * totalSteps);
  currentStep = mouseFactor * totalSteps;
}
```

---

## 🔧 MCP 集成

CatPaw IDE 现在可以直接控制 Blender：

```javascript
// 获取场景信息
const scene = await mcp_tool_blender_get_scene_info();

// 执行 Blender Python 代码
await mcp_tool_blender_execute_blender_code({
  code: "bpy.ops.mesh.primitive_cube_add()"
});

// 截图预览
await mcp_tool_blender_get_viewport_screenshot();
```

### 支持的工具

- `mcp_tool_blender_get_scene_info` — 场景信息
- `mcp_tool_blender_get_object_info` — 对象详情
- `mcp_tool_blender_execute_blender_code` — 执行代码
- `mcp_tool_blender_get_viewport_screenshot` — 截图
- `mcp_tool_blender_search_polyhaven_assets` — Polyhaven 资产
- `mcp_tool_blender_download_polyhaven_asset` — 下载资产
- `mcp_tool_blender_generate_hyper3d_model_via_text` — Hyper3D 生成
- `mcp_tool_blender_search_sketchfab_models` — Sketchfab 搜索
- `mcp_tool_blender_download_sketchfab_model` — 下载模型

---

## 📊 统计

```
新功能:     4 大模块
Bug 修复:   3 个
代码变更:   +800/-200 行
影响文件:   5 个核心文件
提交次数:   8 次
开发时间:   2 天
```

---

## 🚀 快速开始

```bash
# 1. 启动服务器
node server.js

# 2. 打开浏览器
open http://localhost:3001

# 3. 尝试 AI 绘画
# 输入: "乐高跑车"、"超人"、"红色房子"
```

---

## 📝 已知问题

- 乐高房子模型的门凸点需要优化位置
- 图片上传后特征提取对复杂图片效果有限
- 超级英雄胸章在细分曲面后可能变形

---

## 🔮 未来计划

- [ ] 更多超级英雄（雷神、绿巨人、黑寡妇）
- [ ] 乐高机械组（齿轮、连杆）
- [ ] 风格迁移（像素风、low-poly）
- [ ] 语音输入提示词
- [ ] 批量生成模式

---

## 🙏 致谢

感谢以下开源项目：
- [Three.js](https://threejs.org/) — 3D 渲染引擎
- [Blender](https://www.blender.org/) — 3D 创作套件
- [Polyhaven](https://polyhaven.com/) — 免费 HDRI 和纹理
- [Hyper3D](https://hyper3d.ai/) — AI 3D 生成
- [Sketchfab](https://sketchfab.com/) — 3D 模型平台

---

**Full Changelog**: [v2.0.0...v3.0.0](https://github.com/cpufreestyle/blender-auto-3d-explode/compare/v2.0.0...v3.0.0)
