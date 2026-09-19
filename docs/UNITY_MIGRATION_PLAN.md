# 3D 拆解教学 → Unity 迁移评估与方案

> 生成：2026-09-18 · 仅评估，未改任何代码。
> 结论先行：**别直接"全盘 Unity 重写"。** 现有 Web 栈的绝大部分价值不在"渲染引擎"而在"Blender 拆分后端 + AI 图片转3D + 浏览器零安装即用"。真正值得用 Unity 的只有一件事——**Quest 3 原生 VR 体验**。

---

## 1. 现状速览

| 项 | 现状 |
|---|---|
| 技术栈 | Three.js（前端）+ Node `server.js`（Blender 联动 / AI）+ Blender Python 脚本 |
| 规模 | 236 文件，核心代码 ~1.8 万行（main.js 2656 + server.js 2163 + src/* + blender*.py） |
| Unity 痕迹 | **无**（无 .cs/.unity/.asset/.unitypackage/.meta） |
| VR/AR | 已支持 WebXR AR 预览（Quest 3 浏览器内） |
| 核心能力 | 爆炸视图 / 分步拆解教学 / 部件高亮 / 乐高拼接 / 自定义模型上传 / AI 绘画 / 图片转3D（云端+本地 TripoSR）/ Blender MCP 联动 |

**关键认知**：这个项目的"灵魂"是 Blender 拆分 + 云端 3D 生成 + 浏览器即开即用，**Three.js 只是渲染壳**。换成 Unity 后这三块后端可以（也应该）原样复用，重写只发生在"前端渲染 + 交互层"。

---

## 2. 四种"改成 Unity"的真实含义

| 方案 | 做什么 | 代价 | 收益 | 适合场景 |
|---|---|---|---|---|
| **A 完全 Unity 重写** | 新建 C# Unity 工程，弃 Three.js/Node/Web，做桌面/VR 应用 | 极大：1.8万行全重写 + 丧失 Web 分享/MCP 联动 | 仅获得"用 Unity"本身 | 想彻底脱离 Web 栈 |
| **B 保留 Web + 加 Unity 导出** | Web 照跑，新增把拆解结果导出 `.unitypackage`/GLB→Unity 工作流 | 小：增量开发 | Web 与 Unity 各取所长 | 既要在浏览器用，又要在 Unity 二次开发 |
| **C Unity WebGL 替换渲染层** | 浏览器照访问，渲染从 Three.js 换 Unity WebGL | 中：渲染层替换 + 交互重写 | 几乎无（WebGL 性能不如 Three.js 直接） | 不推荐 |
| **D 原生 Unity VR 应用（混合）** | 做独立 Quest 3 VR/APK 应用，**复用现有 Blender 拆分后端 + 云端图片转3D 后端** | 中-大：C# 重写渲染/交互 + Quest 部署链路 | **Quest 3 原生 VR 体验**，远超 WebXR | **目标就是 VR 教学** |

> 你选了"先出方案"。如果最终目标是 **Quest 3 VR 教学**，D 是唯一值得的；如果只是想在网页用，A/C 都是负收益。

---

## 3. 能力映射：Web → Unity（以方案 D 为例）

| 现有能力 | Unity 实现方式 | 复用度 |
|---|---|---|
| 爆炸视图 / 拆解动画 | 每个部件 = 独立 GameObject，用 DOTween/Animation 沿 `explodeFactor` 插值偏移 | 算法移植（C#） |
| 分步拆解教学 | ScriptableObject 存 `quest3-steps`，UI 面板驱动 | 数据直接搬 |
| 部件高亮 | `Renderer.material.emissive` + scale 动画 | 直接等价 |
| 乐高砖块拼接 | Prefab 实例化 | 直接等价 |
| **Blender 拆分** | **保留 Node `server.js` 调 Blender**，Unity 侧 HTTP 拉 GLB | ✅ 后端原样复用 |
| **图片转3D** | **保留云端 Tripo/Meshy/Hyper3D + 本地 TripoSR 后端**，Unity 调 API | ✅ 后端原样复用 |
| WebXR AR 预览 | → Unity **OpenXR + Meta XR Plugin**，打 Quest APK | 替换但更强 |
| AI 绘画 | 走现有 provider 后端 | ✅ 复用 |

> `geometry-split.js`（面提取 / 连通分量 / 材质拆分 / 空间拆分）和 `quest3-*.js`（数据/步骤）是**纯逻辑**，必须移植成 C#；`server.js` 与云端 provider 是**服务**，别动。

---

## 4. 关键技术风险

1. **Blender 联动桥**：Unity 不能像 Node 那样 `blender --background --python`。保留一个常驻后端服务（沿用 `server.js` 或 Python FastAPI）做 Blender 拆分，Unity 用 `UnityWebRequest` 调它。这反而比现在更干净。
2. **拆解算法移植**：`geometry-split.js` + `explode-geometry.js`（~280 行）要改写成 C#，含 UnionFind、连通分量拆分。逻辑已验证，移植风险中等。
3. **Quest 部署链路**：从"浏览器打开"变成"Meta Quest Developer Hub 签名 APK"，需要 Android SDK / Keystore / 设备授权——这是 Web 没有的新成本。
4. **AI 图片转3D 在 VR 内**：VR 里上传图片再等云端生成，涉及输入法/文件选择，体验要重新设计。

---

## 5. 工作量粗估（方案 D，单人）

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | Unity 工程脚手架 + 导入 GLB + Orbit 相机 + Blender 后端联调 | 3–5 天 |
| P1 | 拆解动画 / 分步教学 / 部件高亮 / 乐高（移植 geometry-split + quest3-*） | 1–2 周 |
| P2 | 图片转3D / AI 绘画接入（复用后端） | 3–4 天 |
| P3 | OpenXR + Quest 部署 + VR 交互（手柄/凝视） | 1–2 周 |
| P4 | 收尾、性能、真机验证 | 3–5 天 |
| **合计** | | **约 4–7 周** |

---

## 6. 推荐路径（有立场）

- **目标 = Quest 3 VR 教学** → 走 **方案 D（混合）**：Unity 只重写"渲染+交互+VR"，Blender 拆分与 AI 3D 生成后端原样复用。这是唯一让"改成 Unity"有意义的路线。
- **目标 = 网页用 / 分享** → **不要改**，Web 栈已最优。
- **想要 Unity 资源** → 走 **方案 B**：在现有项目加一个"导出 .unitypackage"按钮即可，半天活。

---

## 7. 下一步（等你拍板）

1. 确认目标：VR 应用 / Unity 资源导出 / 还是只是评估看看？
2. 若选 D：我可以先搭 Unity 工程骨架 + 联调 Blender 后端（P0），给你一个能转模型的空场景跑通再继续。
3. 若选 B：我直接在 `index.html` 加"导出当前模型为 .unitypackage/GLB"按钮（复用 `THREE.GLTFExporter`）。
