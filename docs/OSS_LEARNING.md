# 开源对标学习与优化路线图

> 2026-10-12 | 静态源码学习：四个宽松许可的优秀开源项目 → quest3-exploded 优化映射。
> 本文档只记录公开许可源码的机制学习与自研实现，不涉及任何闭源软件反编译。

## 对标项目与许可

| 项目 | 许可 | 学习重点 |
|---|---|---|
| @google/model-viewer | Apache-2.0 | CachingGLTFLoader 的 in-flight promise 去重与缓存、模型加载进度事件、AR 会话生命周期 |
| three-mesh-bvh | MIT | Worker 并行几何计算、SharedArrayBuffer 零拷贝、WorkerBase 任务队列/dispose 生命周期 |
| gltf-transform | MIT | 纯函数几何变换函数集（get-bounds/join/partition）、Document 图式资源 dispose 事件链 |
| three.js | MIT | GLTFLoader 的 onProgress 回调、插件注册机制、Draco/KTX2/meshopt 可选解码器动态挂载 |

## 已落地优化 1：生成库模型下载去重与缓存

借鉴 model-viewer `CachingGLTFLoader`：url → Promise<ArrayBuffer> 去重 + 成功缓存 + 失败清除。

- 文件：`src/generated-library.js`
- 测试：`tests/generated-library-test.mjs`（26 → 36 断言，原 26 全保）
- 行为：同一 URL 并发点击只发一次 fetch；成功后重复点击直接复用 buffer；404/网络异常后缓存不留错误可重试。

## 已落地优化 2：连通分量拆分 Worker 化（three-mesh-bvh 分层范式）

对标 `ParallelMeshBVHWorker` 的三层结构，把 `splitByConnectedComponents` 的主线程卡顿搬进 Worker：

- `src/connected-components-core.js`：零依赖纯函数核心（typed array 进、分量分组出），Worker 与 Node 共用；
- `src/connected-components.worker.js`：Worker 壳，transferable buffers 双向零拷贝；
- `src/connected-components-client.js`：客户端守卫（running 重入拒绝 / dispose / Worker 不可用返回 null）；
- `src/geometry-split.js`：`splitByConnectedComponentsAsync` + `autoSplitModelAsync`，Worker 失败自动回退同步同算法；
- `main.js` 注入异步版；`custom-model-loader` 的注入面签名不变（await 兼容同步返回值）。

测试：`tests/connected-components-test.mjs`（31 断言）覆盖核心算法、Worker 替身路径、失败回退、Node 无 Worker 回退、客户端 running/dispose 守卫。

## 已落地优化 3：AR 位姿阻尼平滑（model-viewer ARRenderer Damper）

对标 model-viewer 的 `Damper`（二阶临界阻尼精确解 + nil-speed 吸附），给 AR 放置链路加位姿平滑：

- `src/ar-damper.js`：纯数学模块。单轴 `Damper`（临界阻尼 ODE 精确单步解，收敛后 velocity 清零停止计算）+ `smoothingAlpha`（帧率无关的指数平滑系数，用于四元数 slerp）；
- `src/ar-preview.js`：hit-test 命中不再 `setFromMatrixPosition` 瞬移，改为设置目标位姿后每帧阻尼收敛（首次命中直接落位，避免从原点长距离滑移）；自动旋转从"每帧固定 +0.005"（帧率相关）改为按真实时间积分 rad/s；
- 会话启动重置阻尼状态，`onAREnd` 统一清理。

测试：`tests/ar-damper-test.mjs`（17 断言）覆盖收敛单调性、nil-speed 精确吸附、正负对称、60Hz/120Hz 帧率无关性、smoothingAlpha 边界。

## 已落地优化 4：模型加载统一进度事件（three.js onProgress + model-viewer progress event）

三条加载路径（上传 / AI 生成 / 生成库）共用一套字节级进度：

- `src/model-progress.js`：纯逻辑模块。`computePercent`（非法输入返回 null，分块响应回退文案而非 0%）、`formatProgressText`（MB/KB 自适应单位 + 无 Content-Length 时显示已接收）、`createProgressReporter`（节流 + 相同值去重，流式 chunk 回调不打爆 DOM）、`fetchArrayBufferWithProgress`（reader 流式读取，无流式 body 的环境回退 arrayBuffer）；
- 生成库下载接 `fetchArrayBufferWithProgress`（与优化 1 的缓存去重共用，缓存命中不发进度）；
- AI 面板两条 GLB 请求（图片转3D / 文本转3D）经 `postGlbRequest` 新增的 `onDownloadProgress` 上报下载进度；
- 上传路径原有的 XHR 进度文案统一改走 `formatProgressText`，单位与百分比格式三路径一致。

测试：`tests/model-progress-test.mjs`（26 断言）覆盖百分比边界、文案单位、节流/去重/complete 直通、流式 chunk 上报与字节拼接、无流回退、状态码错误透传。

## 已落地优化 5：GPU 资源释放审计（gltf-transform dispose 事件链 + three-mesh-bvh 释放细节）

`disposeNodeTree` 三个真实缺口的修复与锁死：

- **共享资源去重**：GLTF 场景常有多 mesh 共享同一材质/几何体/贴图，原先重复 dispose 会触发冗余 GPU 删除与 WebGL warning；现在同一棵树内用 Set 保证每个资源只释放一次（机制对应 gltf-transform 图式 dispose 的资源唯一性）；
- **骨骼资源**：SkinnedMesh 的 `skeleton.boneTexture` 不在材质属性里、Object.values 遍历不到，泄漏整张骨骼矩阵纹理；现在经 `skeleton.dispose()`（three 0.186 的 Skeleton 自带，内部释放 boneTexture）兜住；
- **ShaderMaterial uniforms 嵌套贴图**：贴图嵌在 `uniforms.<name>.value` 里，材质自有属性遍历不到；现在先扫 uniforms 再扫自有属性，两处都走去重集合。

测试新增 10 断言（41 总）：共享 geo/mat/tex/skeleton 各只释放一次、skeleton 释放路径、uniforms 嵌套贴图先于材质释放、非贴图 uniform 不误释放。期间测试驱动出一个实现 bug（uniforms 检测条件写在 Object.values 循环里永远不成立），修正为直接检查材质自身的 uniforms 字段。

## 已落地优化 6：mergeGeometries 属性合并扩展（gltf-transform join/joinPrimitives）

`mergeGeometries` 从只拼 position/normal/uv 扩展到支持蒙皮与形变：

- **skin 属性**（`skinIndex` / `skinWeight`）加入交集合并：带骨骼的部件合并后保留蒙皮数据；带骨骼与不带骨骼的部件混合合并时，皮肤属性整体丢弃（部件退化为静止网格），不产出半套蒙皮权重——错误权重的渲染症状是模型炸开或扭曲，比静默退化更糟；
- **morph attributes**（形变目标）：按属性名与 morph 数量取交集拼接，`morphTargetsRelative` 透传；数量不一致时该属性整体丢弃；
- 既有交集语义不变（缺 normal 的输入合并时仍丢弃 normal）。

测试：`tests/explode-geometry-test.mjs` 41 → 52 断言，新增 skin 拼接正确性（顶点接续、两输入区分值）、skin 半套丢弃、morph 拼接与 relative 透传、morph 数量不一致丢弃。

## 已落地优化 7：部件级可交换清单（split manifest）

路线图第 1 项落地。借鉴 gltf-transform 的 `partition` 思想——把几何操作的结果降为
纯数据，使其可序列化、可离线重放、可被别的工具消费。

- `src/split-manifest.js`：`buildSplitManifest(parts, {model, camera})` 把 autoSplitModel
  的 three 对象数组转成 JSON。每部件记 index / name / isOriginal / triangles /
  volume / surfaceArea / bounds / size / centroid / explodePos；非法输入逐项跳过并在
  `summary` 记账，不抛错。
- 关键设计：`explodePos` 复用 `calculateExplodePos`，无相机时沿「质心相对整体中心」
  外扩——整体中心已扣除模型整体偏移，剩下的正是该部件在装配体里的偏心方向。
  单部件时该向量为零，退化到沿整体最大轴，仍是确定值。
- `src/export-panel.js` 新增 `exportSplitManifest` + index.html「🧾 导清单」按钮；
  `buildManifest` 走注入缝（与 `GLTFExporterClass` 同套路），Node 里可测接线。
- 测试：`tests/split-manifest-test.mjs`（62 断言）。数值期望以 three 官方
  `BoxGeometry` 为金标准（12 面 / 体积 1 / 表面积 6）——本仓库既有测试里的手搓
  「焊接方块」有几个 quad 是蝶式顶序，切出的两个三角形面积不相等，表面积与体积都
  不是标称值；拿它当数值期望会把夹具缺陷误报成模块缺陷。
- 门禁：`npm run validate` 57 套件 3418 断言 0 失败、`test:py` 36 项 OK；
  测试链 56 → 57，`dead-markup` 守卫 id 85 → 86。

## 已落地优化 8：manifest 离线重放（split manifest replay）

路线图第 2 项落地。上一条把拆分结果导成了 JSON，本条补上消费端——不然导出的
文件还要人自己写脚本才能看。

- `src/manifest-replay.js` 三个导出按可测性分层：
  - `replayPlan`：manifest → 带插值端点的计划（纯数据，不碰 three 对象图）；
  - `replayPartTransforms`：按 progress 求每个部件位置（纯函数）。**用线性插值
    而非缓动**——进度条本身就是时间的函数，缓动应由调用方在喂 progress 之前做；
    在这里做会让「同一进度对应两个位置」，拖滑块时无法复现；
  - `createReplayScene`：three 工厂，每部件一个包围盒代理网格，色相按 index 均分
    保证相邻不撞色，带 `setProgress` / `dispose`。
- `replay.html`：静态重放页，`?manifest=<json 地址>` 载入，进度滑块 + 播放 + 复位，
  射线拾取显示当前部件名，相机按整体包围盒自动摆位。
- 语义边界写进页面提示：manifest 只有几何摘要，重放还原的是「布局与拆解关系」
  而非精确网格，不让使用者误以为这就是原模型。
- 测试：`tests/manifest-replay-test.mjs`（79 断言）覆盖进度钳制、计划容错、
  插值端点与可复现性、代理网格命名 / 初始位置 / setProgress / dispose、色相均分。
- 门禁：`npm run validate` 58 套件 3497 断言 0 失败、`test:py` 36 项 OK。

踩过的两个坑（都记在测试注释里）：

1. **three 的 `Vector3.cross` 是原地修改并返回自身**。`b.cross(c)` 会污染下一轮
   循环复用的 `b`——这类 bug 在小例子上不暴露，必须用官方 `BoxGeometry` 这种
   已知正确结果的输入才能逼出来。
2. **`new Mesh(geo, mat)` 会读 `geometry.morphAttributes`**。测试里用假几何替身时
   少这个字段就抛 "Cannot convert undefined or null to object"，报错点在三里
   之外，很容易误判成自己的模块有 bug。

## 已落地优化 9：导出后一键跳转重放（manifest 落盘端点）

路线图第 3 项前半落地。上一条做出了重放页，但它要 `?manifest=<可寻址 URL>`，
而 `exportSplitManifest` 走的是 `URL.createObjectURL(blob)`——刷新即失效、也没法
分享给别人。缺口在「可寻址的落点」。

- `POST /api/manifest`（`src/routes-blender.js` 的 `handleManifestSave`）：把 manifest
  写进 `models/generated/`。选这个目录是因为静态服务以仓库根为 ROOT 天然托管它，
  不需要新开路由或新开目录；返回的 `url` 可直接拼进重放页查询参数。
- 模型名消毒：只保留 `[a-zA-Z0-9\u4e00-\u9fa5_-]`，超长截断，落盘后再校验
  `outPath.startsWith(GENERATED_DIR)`——模型名是用户输入，可能含 `../` 或
  shell 元字符。上限 1MB（manifest 是几何摘要，正常远小于此；上限防的是误传
  整个 GLB 的 base64 写满磁盘）。
- `handleGeneratedList` 的白名单加 `.json`，落盘的清单才会出现在生成库里。
- 前端 `saveManifestAndReplay`：POST 落盘 → `window.open(replay.html?manifest=...)`；
  **失败时回退到下载**，不让用户白点一次。
- UI：`index.html` 新增「🎬 存并重放」按钮。

过程中修掉一个真实的 UX 缺陷：降级提示原本写在 `exportSplitManifest()` **之前**，
被后者的「清单已导出」成功 toast 盖掉——用户会以为已经存进服务端，实际只拿到
本地文件。调整为先导出、后补降级说明。

另一个发现：`handleGeneratedList` 的测试原先拿**上传白名单** `ALLOWED_EXTENSIONS`
断言生成库列表，这是错的耦合（上传收 `.obj`、生成库不收；生成库收 `.json`、上传
不收），只是夹具里没有 `.json` 才没暴露。已改为独立的 `LIB_EXTS` 并在夹具里补
`.obj` 与 `.json` 两个反向样本。

测试：`tests/routes-blender-test.mjs` 136 → 164（新增 8 条：正常落盘、url 编码、
消毒与路径穿越、两类 400、缺 name 回落、空 parts）；`tests/export-panel-test.mjs`
155 → 172（新增 5 条：空部件短路、成功跳转与编码、`success:false` 降级、网络异常
降级、自定义模型取数）。

门禁：`npm run validate` 57 套件 3548 断言 0 失败、`test:py` 36 项 OK。

## 已落地优化 10：manifest 版本协商（version negotiation）

问题：manifest 的 `version` 字段从写进去那天起就没有消费者——
`parseSplitManifest` 与 `replayPlan` 都不看它。一个 v2 的文件会被静默按 v1
语义解析：字段含义变了不报错，用户看到的是一个「看起来对但其实是错的」
重放结果。

- `src/manifest-version.js`：`inspectManifestVersion` / `isManifestCompatible`，
  把「这个文件我能不能正确解读」变成可判定的。三种状态：
  - `compatible`：已知版本，放心用；
  - `missing`：没有 `version` 字段，**按兼容处理**。v1 是第一个版本，早期文件
    与手写文件都可能没有它，为此拒绝加载会让老文件全部失效，代价大于收益；
  - `unsupported`：版本比我们支持的更新、或不是正整数，**拒绝**。我们无法
    知道它新增/改变了哪些字段，硬解析的产物是错的，而错比重更糟。
- 接入点选在 `replayPlan` 内部而不是只让调用方检查：「按错误语义解析出来的
  计划」比「没有计划」更危险——前者看起来能用。
- `replay.html` 面板新增「清单版本」行，`missing` 时如实标注「未声明（按 v1
  兼容读取）」并降低不透明度，不让用户误以为文件本身带版本号。

刻意**不**做降级读取 `version < 1`：那需要为每个历史版本写迁移函数，而目前
只有一个版本。等真有第二个版本时再补迁移表，比现在凭空造一套用不上的机制诚实。

测试：`tests/manifest-version-test.mjs`（66 断言）；`manifest-replay-test.mjs`
79 → 103（新增版本协商 5 条）。门禁：58 套件 3638 断言 0 失败。

踩过的坑：写 `missing` 用例时夹具 `makeManifest` 自带 `version: 1`，导致测的
一直是 `compatible` 分支、断言假绿。改为显式 `delete m.version`，并把原因写进
注释——夹具的默认值会悄悄改变你测的是哪条路径。

## 已落地优化 11：3D 打印通道（可打印性预检 + 逐部件 STL 导出）

用户需求「结合 3D 打印来做一些功能」的直接落地。GLB 导出回答的是「看得见的
几何」，而切片软件（Bambu Studio / PrusaSlicer / Cura）要的是**水密实体**：
每条三角形边必须被恰好两个三角形共享，才能沿 Z 轴求出闭合轮廓。本项目产出的
模型有三类常见不打印源——拆解切口留下的开放边、零面积退化面、以及 STL 没有
单位字段导致的尺度不明。

三个模块，按可测性分层，全部纯函数或带 DI 接缝的工厂：

- `src/print-analyze.js`：`analyzePart` / `analyzePrintability`。边邻改用排序
  顶点对做键（避免哈希浮点坐标），统计前先按 1e-4 焊接顶点——不焊接的话接缝处
  因顶点复制，全部边都记成「只有 1 个三角形」，开放边数远大于真实值。
  退化面**在原始网格上数**而非焊接后：焊接会合并重复顶点从而「修掉」退化面，
  但那是拓扑修复不是用户决策。体积用散度定理（有向体积之和），非水密网格结果
  无物理意义，页面标注清楚。构建体积超限是 warning 不阻断。
- `src/print-export.js`：`exportPartSTL` / `exportModelSTL`。用 three 官方
  `STLExporter` 而非自己拼二进制（它处理法线重算、matrixWorld 应用、颜色剔除）。
  打印朝向：three/GLTF 是 Y-up、构建板是 Z-up，故绕 X 转 -90° 把 +Y 落到 +Z，
  再 XY 居中、min.z = 0 贴底。**只改 clone 不动现场 mesh**——现场 mesh 带
  homePos/explodePos，爆炸动画还在跑。
- `src/print-panel.js`：UI 接线层。部件来源与导出面板同源（经 `getState()`
  惰性读，切换模型后点预检分析的是新数组），结果表格复用 `asm-*` 视觉语言，
  逐部件下载分批让出宏任务（连续 programmatic click 会被浏览器合并/吞掉）。

过程中修掉三个真 bug，都不是「测试写错」：

1. **`setIndex` 传裸 `Uint32Array`**（three r186）。r186 起 `setIndex` 不再自动
   包成 `BufferAttribute`，存进去后 `index.count` 是 `undefined`，`countEdges`
   静默循环 0 次、开放边恒为 0——预检会永远报「水密」。仓库既有正确写法见
   `src/geometry-split.js:239`。
2. **非索引几何的顶点索引退化成 `i`**。`index ? index.getX(i+1) : i` 漏了偏移，
   非索引几何（所有 STL 风格、所有 `toNonIndexed()` 夹具）把同一个顶点读三遍，
   面积极值判退化、边统计全错。四处（焊接 / 退化 / 体积 / 表面积）同犯。
3. **缩放与对位顺序**。克隆矩阵是 `T*R*S`，先平放板底再 `scale.setScalar(1000)`
   会把贴底部件撑到板下（实测首顶点 z = -49.95 而非 0）。缩放必须移到
   `updateMatrixWorld(true)` 之前。

还有一个只在 worktree 里现形的同步脚本缺陷：`node_modules` 是指向主仓库的
symlink 时，`scripts/vendor_three_sync.py` 的 `resolve()` 产出主仓库路径，
`SRC in target.parents` 永远为假，整个 BFS 把跨文件 import 全部剪掉——
r186 的 `three.module.js` 正是靠 `./three.core.js` 活的，剪掉后 dev 模式
importmap 直接 404。修法是 `SRC` 自身也 `resolve()`。

测试：`tests/print-analyze-test.mjs`（57 断言）、`tests/print-export-test.mjs`
（33）、`tests/print-panel-test.mjs`（42）。数值期望以 three 官方 `BoxGeometry`
为金标准；手搓「焊接方块」有几个 quad 是蝶式顶序，切出的两个三角形面积不相等，
拿它当数值期望会把夹具缺陷误报成模块缺陷。浮点比对在 float32 几何下用
`1e-6` 容差（仓库惯例见 `tests/explode-geometry-test.mjs:121`）。

真机门禁：`scripts/ci_print_ui_smoke.mjs`（25 断言，Chrome CDP）。单测里的
`analyze` 是注入的假实现，从没有任何断言碰过「真 Quest 3 几何 + 真
analyzePart」这条链路，而上面第 1、2 两个 bug 正是假 DOM 看不见的。
真机实测：15 个部件、972 三角形、11 个因切口开放边报需处理（诚实报告，
不是误报——封闭几何体在同模块下全部报 watertight）。

门禁：`npm run validate` 61 套件 / 3774 断言 0 失败、`test:py` 36 项 OK、`build` 通过、
`lint:all:check` 0 error。

## 已落地优化 12：装配定位销（three-bvh-csg vendored + 真 CSG 布尔）

打印预检回答「打得出来吗」之后，下一个自然问题是「装得回去吗」。拆解件打印
出来后靠胶水/卡扣对位，教学场景里既慢又不可逆。本优化在导出 STL 时自动给
装配位相邻部件加**定位销**：A 侧贴合面挖孔（含 0.4mm FDM 收缩间隙）、B 侧加
半露圆柱销（凸出量 = 孔深 = 6mm），徒手压入即可对位，界面 ≥4×minFaceSize 时
放 2 根定死朝向。

CSG 选型：不引 npm 依赖，与 vendor/three 同策略把 three-bvh-csg 0.0.18 的
闭包子集（22 文件）和 three-mesh-bvh 的闭包子集（39 文件）vendored 进
`vendor/`（各带 MIT LICENSE），import 路径 patch 成仓库相对路径。实测三个坑，
全部写进 `tests/print-export-test.mjs` 的水密断言：

1. **Brush 的 matrix 传递不可靠**——`updateMatrixWorld` 会用本地变换重写
   matrixWorld，手工塞 matrix 会被吞掉。统一改为把世界变换 `applyMatrix4`
   烘进几何体，Brush 保持单位阵。
2. **必须 `useCDTClipping = true`**——默认 LegacyTriangleSplitter 在圆环缝处
   留 250 条假开放边，CDT 模式只剩 12 条。
3. **浮点残差焊接容差必须 1e-6**——CSG 输出在共享圆环处有 ≤2e-8 的坐标残差，
   1e-7 焊接后仍有 8 条假开放边；1e-6 桶哈希焊接后全部边 use=2，完全水密。

装配契约钉在 spec I10：只在世界包围盒贴合（某轴重叠 <1e-3）、界面两向 ≥
2×minFaceSize 的部件对上放销；孔件与销件 CSG 后必须水密；CSG 失败退回无销
导出；现场 mesh 不被触碰（I9 对 CSG 同样成立）。

## 已落地优化 13：自动拼板（Skyline Bottom-Left 排版）

打印预检与定位销解决「打得出来、装得回去」之后，剩下一个纯体力活：15 个部件
逐个导出后要在切片软件里手动摆板。本优化在导出时按目标打印机的板面尺寸自动
排版——每块板用 Skyline Bottom-Left 启发式（维护一条「天际线」，每个件放进去
后把对应段抬高），高件先放的 FFDH 排序让天际线更平，同板件名前缀 `B01-` 让
切片软件按名字排序时天然相邻。

实现里钉住三个容易踩的坑：

1. **件间 5mm 间距不能靠缩放**——FDM 下人工掰件需要安全距离。做法是占位高度
   预加间距，首排贴后墙的中心位置再减回来，保证首排贴墙、其余排之间恒有间距。
2. **回填必须按下标**——FFDH 排序会重排输出，部件名又可能重复（同名件是
   常态），按名字对齐会张冠李戴。排版项携带原始下标，输出前按输入顺序回排。
3. **放不进任何朝向的巨件直接跳过**——排版失败不能卡住导出，宁可让用户手动摆
   那一个大件。

## 已落地优化 14：切口封盖（boundary capping）

预检只回答「能不能打」，路线图第 6 条问的是「前端能不能顺手修」。答案是把
修复面收窄到最高价值的一类：拆解切口。切开的面剖面是平面，沿边界环补一圈
封面三角形就是水密实体，不需要重网格化；其余问题（非流形、非平面开口）仍
交给 Blender 3D-Print Toolbox。

实现钉住四个坑，全部有测试背书（tests/print-export-test.mjs）：

1. **焊接拓扑必须与预检同源**——print-export.js 从 print-analyze.js 导入
   `WELD_TOLERANCE`/`weldPositions`/`countEdges`（三者改为 export），保证
   「预检看到的开放边」和「封盖修的开放边」是同一套 1e-4 焊接拓扑。分叉、
   断头、use>2 的边一律拒绝封盖，宁可退回也不猜。
2. **封面朝向不能信 earcut**——耳切输出不保证绕向。做法是提取边界边的「面侧
   走向」（水密表面每条边两个方向各一次，封面必须与面侧相反），以边界约束
   为种子沿封面共享边传播翻转，最后自检每条边恰好两个方向，不满足整体退回。
3. **嵌套环要合成带洞封面**——空心管的端面是「外环 + 内环」，逐环封会得到
   两张重叠圆盘（非流形）。共面环按法线平行 + 质心同面分组，射线法定父环、
   偶数深度做耳切、洞里再有环递归封新封面。
4. **封盖时机在缩放前**——焊接容差与平面度阈值按场景单位定义，缩放后数值
   含义会变。exportPartSTL 在旋转后先烘世界变换封盖，再缩放贴底。

契约钉在 spec I12：`capHoles:false` 关闭；封盖失败（任何自检不过）退回原几何；
现场 mesh 逐字节不变（I9 对封盖同样成立）。

## 后续路线图（按价值/成本排序）

1. ~~**拆分结果可交换格式**~~ ✅ 已落地（优化 7）。
2. ~~**manifest 驱动的离线重放**~~ ✅ 已落地（优化 8）。
3. ~~**导出后一键跳转重放**~~ ✅ 已落地（优化 9）。
4. ~~**manifest 版本协商**~~ ✅ 已落地（优化 10）。
5. **下一步候选**：生成库条目上直接给「重放」入口（现在要手动拼 URL）；
   manifest 的 `version` 真出现 v2 时补迁移表。
6. ~~**可打印性修复——切口封盖**~~ ✅ 已落地（优化 14）。

## 桌面快捷方式（Quest3 拆解.app）

- [scripts/make_desktop_shortcut.sh] 打包完整 .app：`Contents/MacOS/quest3-launcher`（326 行 LaunchAgent 启动器）+ `Resources/AppIcon.icns`（爆炸视图立方体图标）+ `Info.plist`（LSUIElement 无 Dock 图标），ad-hoc 签名 + lsregister 刷图标缓存；
- 双击链路：定位 node → `/api/identity` 确认端口归属 → LaunchAgent 拉起 `PORT=3011 node server.js`（launchd 托管，不受启动进程生命周期影响）→ 打开 `launcher.html?api=http://localhost:3011` → 重定向 `index.html?api=...`；
- 端口身份识别：server.js 新增 `GET /api/identity`（app/version/pid/port）。端口被别的程序占用时启动器拒绝打开它的页面，也不把别人的 HTTP 200 当就绪——这正是项目自己踩过的坑（端口被占时误把别家服务当自己）；
- 端口固定 3011：3001 在这台机器上常被其它项目占用；前端 `?api=` 查询参数（config.js 解析优先于 meta 标签）保证页面指向实际端口。

