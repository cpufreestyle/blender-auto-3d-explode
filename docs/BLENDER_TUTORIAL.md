# Quest 3 Blender 手动拆分完整教程

**目标**：将 Quest3.glb 拆分为 15 个独立部件，用于爆炸图
**预计时间**：2-3 小时
**难度**：⭐⭐⭐ 中等
**软件**：Blender 3.0+（免费）

---

## 📋 目录

1. [安装 Blender](#1-安装-blender)
2. [导入 Quest 3 模型](#2-导入-quest-3-模型)
3. [模型分析](#3-模型分析)
4. [拆分步骤](#4-拆分步骤)
5. [标记部件名称](#5-标记部件名称)
6. [导出 GLB](#6-导出-glb)
7. [集成到项目](#7-集成到项目)

---

## 1. 安装 Blender

### 下载

1. 访问 https://www.blender.org/download/
2. 下载最新版本（Windows/Mac/Linux）
3. 安装（解压即可使用，无需安装）

### 首次启动

1. 打开 Blender
2. 会看到默认场景（立方体、相机、灯光）
3. 点击 **File → New** 清空场景

---

## 2. 导入 Quest 3 模型

### 步骤

1. **File → Import → glTF 2.0 (.glb/.gltf)**

   ![File → Import → glTF](https://docs.blender.org/manual/en/latest/_images/io_gltf_import.png)

2. 选择文件：
   ```
   /Users/a1-6/quest3-exploded/models/Quest3.glb
   ```

3. 点击 **"Import glTF"**

4. **等待加载**（8.2 MB，可能需要几秒）

### 导入后检查

**预期看到**：
- ✅ Quest 3 完整模型显示在 3D 视图中
- ✅ 模型可能是灰色的（缺少材质）
- ✅ 可能很大或很小

**如果模型太大/太小**：
- 选中模型
- 按 **S** 键缩放
- 输入合适的数值（如 0.01 或 100）

---

## 3. 模型分析

### 切换视图

**常用视图快捷键**：
- `1`：前视图（Front）
- `3`：侧视图（Right）
- `7`：顶视图（Top）
- `5`：切换透视/正交
- `~`（波浪线）：切换视图菜单

### 观察模型结构

**按 `Z` 键** 切换渲染模式：
- **Solid**：实体模式（默认）
- **Material Preview**：材质预览（需要纹理）
- **Wireframe**：线框模式（查看结构）

**推荐**：先使用 **Wireframe** 模式看清结构

### 旋转查看

- **按住鼠标中键**拖动：旋转视角
- **滚轮**：缩放
- **Shift + 鼠标中键**拖动：平移

### 识别部件

Quest 3 的**主要部件**（从上到下）：

```
1. 头带（顶部和后部）
   ├─ 柔性头带主体
   └─ 头带连接臂（左右）

2. 前面板（脸面）
   ├─ 白色外壳
   ├─ 摄像头（4颗：2 RGB + 1 ToF + 1 IR）
   └─ Meta 标志

3. 透镜区域
   ├─ 透镜外环（左右）
   └─ 透镜玻璃（左右）

4. 面罩海绵（与脸接触）
   ├─ 记忆海绵
   └─ 磁性边框

5. 主机身（黑色主体）
   ├─ 散热通风口
   └─ 侧边按钮

6. 主板/显示屏（内部）
   └─ 不直接可见，但在拆解时会暴露
```

---

## 4. 拆分步骤

### ⚠️ 重要提示

**拆分原则**：
- ✅ 沿"自然裂缝"拆分
- ✅ 保持每个部件的完整性
- ✅ 不要切穿部件本身
- ✅ 为每个部件添加**独立材质**用于识别

### 4.1 进入编辑模式

1. **选中整个模型**
2. 按 **`Tab`** 键进入 **Edit Mode**

**Edit Mode vs Object Mode**：
- **Object Mode**（默认）：操作整个对象
- **Edit Mode**（`Tab`）：编辑模型的顶点、边、面

### 4.2 拆分头带（Top Strap）

**识别头带**：
- 位于模型的**最顶部**
- 通常是**弧形结构**
- 连接左右两侧

**操作步骤**：

1. **切换到侧视图**：按 `3`

2. **框选头带部分**
   - 按 `B` 激活框选
   - 拖动鼠标框选顶部区域
   - 只选中头带部分

3. **分离（P）**
   - 按 **`P`** 键
   - 选择 **"Selection"**
   - 头带会变成独立对象

4. **命名**
   - 在右侧 **Outliner** 面板
   - 重命名为 **"头带"**

5. **返回 Object Mode**
   - 按 **`Tab`**

**重复此流程**拆分所有 15 个部件...

### 4.3 拆分头带臂（Strap Arms）

**左右各一个**

1. 在 **Object Mode** 选中包含头带臂的部分
2. 按 `Tab` 进入 **Edit Mode**
3. 使用 **框选（B）** 或 **套索选（Ctrl + 左键拖动）**
4. 按 **`P`** → **"Selection"** 分离
5. 重命名为 **"左头带臂"** / **"右头带臂"**

### 4.4 拆分前面板（Front Cover）

**前面板是最大的白色外壳**

1. 切换到 **前视图**：按 `1`
2. 选中前面的白色面板部分
3. 注意：**不要选中摄像头和透镜**
4. 按 `P` → "Selection" 分离
5. 命名为 **"前面板"**

### 4.5 拆分摄像头（Cameras）

**4 颗摄像头**：
- 左上：RGB 摄像头（彩色透视）
- 右上：RGB 摄像头
- 正中：ToF 深度传感器
- 底部：IR 追踪摄像头

**每颗单独拆分**：
1. 在 **Wireframe** 模式下找到圆形的小模块
2. 精确框选摄像头部分
3. 按 `P` → "Selection"
4. 命名：**"左摄像头"**、**"右摄像头"**、**"中置摄像头"**、**"下置追踪摄像头"**

### 4.6 拆分透镜模组（Lens Modules）

**左右各一个**

1. 找到透镜部分（通常在侧面）
2. 框选透镜外环和玻璃
3. 按 `P` → "Selection"
4. 命名：**"左透镜模组"**、**"右透镜模组"**

### 4.7 拆分面罩海绵（Face Interface）

**位于模型底部/后部**

1. 找到与脸接触的海绵部分
2. 框选整个海绵区域
3. 按 `P` → "Selection"
4. 命名：**"面罩海绵"**

### 4.8 拆分主机身（Main Body）

**剩余的黑色主体部分**

1. 选中除了以上所有部件外的部分
2. 按 `P` → "Selection"
3. 命名：**"主机身"**

### 4.9 拆分主板/显示屏（Motherboard）

**内部部件**

1. 如果有内部结构，分离出来
2. 命名：**"主板/显示屏"**

---

## 5. 标记部件名称

### 为什么需要标记？

Three.js 通过 `name` 属性识别部件，用于：
- 爆炸动画
- 步骤指示
- 部件高亮

### 如何标记

**方法 1：在 Outliner 中重命名**
1. 在右侧 **Outliner** 面板
2. 选中对象
3. 按 **`F2`** 重命名

**方法 2：在 Object Properties 中**
1. 选中对象
2. 在右侧 **Properties** 面板（橙色方块图标）
3. 在 **"Object"** 标签页顶部
4. 修改 **"Name"** 字段

### 必须标记的部件名称

```
✅ 必须有的名称（用于爆炸图）：

1. 前面板
2. 主机身
3. 左透镜模组
4. 右透镜模组
5. 左摄像头
6. 右摄像头
7. 中置摄像头
8. 下置追踪摄像头
9. 左头带臂
10. 右头带臂
11. 头带
12. 面罩海绵
13. 主板/显示屏

可选：
14. 左透镜
15. 右透镜
```

**重要**：名称必须与 `main.js` 中的 `stepGroups` 配置匹配！

---

## 6. 导出 GLB

### 准备导出

1. **选中所有部件**
   - 按 **`A`** 全选

2. **应用变换**（重要！）
   - 按 **`Ctrl + A`**
   - 选择 **"All Transforms"**
   - 这会重置位置、旋转、缩放到原点

3. **检查原点**
   - 所有部件的原点应该在 **(0, 0, 0)**
   - 如果有偏移，按 **`Ctrl + A`** 再应用一次

### 导出设置

1. **File → Export → glTF 2.0 (.glb/.gltf)**

2. **选择格式**：
   - 选择 **".glb"**（二进制，推荐）
   - 不要选 ".gltf"（会生成多个文件）

3. **导出设置**（右侧面板）：

   **General（常规）**：
   - ✅ **Selected Objects**：只导出选中的对象
   - ✅ **Apply Modifiers**：应用修改器
   - ✅ **Include UVs**：包含 UV
   - ✅ **Include Normals**：包含法线
   - ✅ **Include Materials**：包含材质

   **Geometry（几何体）**：
   - ✅ **Triangulated Faces**：三角化面
   - ✅ **Loose Edges**：保留松散边

   **Animation（动画）**：
   - ❌ 不需要动画，保持默认

   ** Draco Compression**：
   - 可选：启用压缩（减小文件大小）

4. **点击 "Export glTF 2.0"**

5. **保存文件**：
   ```
   /Users/a1-6/quest3-exploded/models/Quest3-real.glb
   ```

   **注意**：用新名字 `Quest3-real.glb`，保留原文件备份

---

## 7. 集成到项目

### 7.1 替换模型

**将导出的文件复制到项目**：
```bash
# 你的导出文件
Quest3-real.glb

# 复制到
/Users/a1-6/quest3-exploded/models/Quest3-real.glb
```

### 7.2 修改 main.js

**需要添加的功能**：

#### 1. 添加模型切换按钮

在 `index.html` 中添加：
```html
<button id="model-toggle" class="step-btn">
  🎨 切换模型
</button>
```

#### 2. 修改模型加载逻辑

在 `main.js` 中：

```javascript
// 添加模型选择
let useRealModel = false; // 默认使用简化版

// 加载真实模型
async function loadRealModel() {
  const response = await fetch('./models/Quest3-real.glb');
  const buffer = await response.arrayBuffer();

  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject);
  });

  const realModel = gltf.scene;

  // 统计部件
  const parts = [];
  realModel.traverse((child) => {
    if (child.isMesh) {
      parts.push({
        mesh: child,
        name: child.name || `Part_${parts.length}`
      });
    }
  });

  console.log(`✅ 真实模型加载: ${parts.length} 个部件`);

  // 隐藏简化版，显示真实版
  questGroup.visible = false;
  realModelGroup.visible = true;
  realModelGroup.add(realModel);

  // 更新爆炸逻辑
  updateExplodeParts(parts);

  return parts;
}

// 切换模型按钮
const modelToggleBtn = document.getElementById('model-toggle');
if (modelToggleBtn) {
  modelToggleBtn.addEventListener('click', () => {
    useRealModel = !useRealModel;

    if (useRealModel) {
      loadRealModel();
      modelToggleBtn.textContent = '🔄 简化版';
    } else {
      questGroup.visible = true;
      realModelGroup.visible = false;
      modelToggleBtn.textContent = '🎨 真实版';
    }
  });
}
```

#### 3. 更新爆炸逻辑

需要为真实模型计算爆炸点：

```javascript
function updateExplodeParts(parts) {
  // 清空旧部件
  partsArray = [];

  // 为每个部件计算爆炸位置
  parts.forEach((part, index) => {
    // 计算包围盒
    const box = new THREE.Box3().setFromObject(part.mesh);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // 爆炸方向：从中心向外辐射
    const direction = center.clone().normalize();
    const distance = center.length() * 2;

    partsArray.push({
      mesh: part.mesh,
      name: part.name,
      homePos: part.mesh.position.clone(),
      explodePos: center.clone().add(direction.multiplyScalar(distance)),
      homeRot: part.mesh.rotation.clone(),
      explodeRot: new THREE.Euler(0, 0, 0)
    });
  });
}
```

---

## 🎯 测试

### 加载后检查

1. **部件数量**
   - 打开浏览器控制台
   - 应该看到 `✅ 真实模型加载: XX 个部件`
   - **期望**：13-15 个部件

2. **部件名称**
   - 检查是否所有部件都有正确的名称
   - 名称应该与 `stepGroups` 匹配

3. **爆炸动画**
   - 点击"下一步"按钮
   - 每个部件应该独立爆炸
   - 点击"爆炸视图"应该完全炸开

4. **自动旋转**
   - 模型应该自动旋转

### 故障排除

**问题 1：部件数量不对**
- 检查 Blender 中是否正确分离了所有部件
- 检查导出时是否选中了所有对象

**问题 2：名称不匹配**
- 修改部件名称以匹配 `main.js` 中的配置
- 或修改 `stepGroups` 以匹配你的名称

**问题 3：爆炸方向错误**
- 调整爆炸距离乘数（`* 2` → `* 3`）
- 手动设置爆炸位置

---

## 📝 完整检查清单

### Blender 操作

- [ ] 导入 Quest3.glb
- [ ] 切换到 Wireframe 模式
- [ ] 按 Tab 进入 Edit Mode
- [ ] 拆分头带（顶部弧形）
- [ ] 拆分头带臂（左右）
- [ ] 拆分前面板（白色外壳）
- [ ] 拆分摄像头（4颗，圆形小模块）
- [ ] 拆分透镜模组（左右两侧）
- [ ] 拆分面罩海绵（底部接触部分）
- [ ] 拆分主机身（黑色主体）
- [ ] 拆分主板（内部，如果可见）
- [ ] 应用所有变换（Ctrl + A）
- [ ] 检查所有 13 个部件名称

### 导出

- [ ] File → Export → glTF 2.0
- [ ] 格式：.glb
- [ ] 勾选"Selected Objects"
- [ ] 勾选"Apply Modifiers"
- [ ] 勾选"Triangulated Faces"
- [ ] 导出到 `models/Quest3-real.glb`

### 集成

- [ ] 复制到项目 `models/` 目录
- [ ] 修改 `main.js` 添加模型切换
- [ ] 测试加载
- [ ] 测试爆炸动画
- [ ] 测试所有步骤

---

## ⏱️ 时间估算

| 步骤 | 预计时间 |
|------|---------|
| 安装 Blender | 5 分钟 |
| 导入模型 | 2 分钟 |
| 分析结构 | 10 分钟 |
| 拆分 13 个部件 | 60-90 分钟 |
| 标记名称 | 10 分钟 |
| 导出 GLB | 5 分钟 |
| 集成到项目 | 30 分钟 |
| 测试调整 | 20 分钟 |
| **总计** | **2.5-3 小时** |

---

## 🆘 遇到问题？

### 常见问题

**Q1：模型加载后是黑色的**
- 检查是否启用了 **"Material Preview"**（按 `Z`）
- 确认纹理路径是否正确

**Q2：无法精确选择部件**
- 使用 **X-Ray 模式**（Alt + Z）
- 或使用 **框选 + Ctrl** 加减选择

**Q3：分离后看不到对象**
- 检查是否在 **Object Mode**
- 按 `A` 全选查看

**Q4：导出后文件太大**
- 启用 **Draco Compression**
- 或降低纹理分辨率

**Q5：导出的模型在 Three.js 中看不到**
- 检查名称是否正确
- 检查是否应用了变换
- 查看浏览器控制台错误

---

## 📚 参考资源

### Blender 官方教程
- [Blender 入门](https://docs.blender.org/manual/en/latest/getting_started/index.html)
- [Edit Mode 基础](https://docs.blender.org/manual/en/latest/modeling/index.html)

### 快捷键参考
- `Tab`：切换 Object/Edit Mode
- `A`：全选
- `B`：框选
- `Ctrl + 左键`：套索选择
- `P`：分离（Separate）
- `G`：移动（Grab）
- `S`：缩放（Scale）
- `R`：旋转（Rotate）
- `Ctrl + A`：应用变换
- `F2`：重命名
- `Z`：切换渲染模式
- `1/3/7`：切换视图

---

## ✨ 完成后的效果

拆分完成后，你将拥有：

- ✅ **15 个独立部件**的 Quest 3 模型
- ✅ **真实的爆炸效果**（每个部件独立运动）
- ✅ **完整的教学体验**（对应 7 步拆解）
- ✅ **专业的视觉效果**

**这是实现高质量爆炸图的唯一可靠方法！**

---

**开始吧！有任何问题随时问我！** 🚀

**下一步**：下载 Blender，然后开始拆分！
