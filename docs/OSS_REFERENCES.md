# 可参考的优秀开源项目（OSS_REFERENCES）

> 起念：2026-09-30 用户问「Tripo AI 已经能拆 3D 了，这个软件还有什么意义」。
> 结论是先承认冲击（生成与重建这一层确实被商品化了），再把力气放到它给不了的东西上：
> 可复现的教学结构、可分发的进度、可投影的课堂现场。本文登记为做这些事而调研过的
> 开源项目，以及各自借了什么、落在哪个文件。
>
> **数据均为 2026-09-30 当天 GitHub REST API 实测**（`api.github.com/repos/<owner>/<repo>`
> 与 `/search/repositories`），不是凭印象写的；复现命令见文末。

## 1. 先说一个关键发现：这个细分领域没有同类实现

| 检索词 | 头名（按 star） | star | 许可 | 最近推送 |
|---|---|---|---|---|
| `blender exploded view` | `ehsun-sh/blender-exploded-assembly-studio` | 2 | GPL-2.0 | 2026-08-30 |
| `blender exploded view addon` | `design3d-blender/exploder` | 1 | GPL-3.0 | 2021-01-11 |
| `exploded view threejs` | `MaximilianKellner/exploded-view-web-package` | 2 | MIT | 2026-02-24 |

最高 2 星、多数是个人练手项目且多年不更新。也就是说：**「爆炸视图 + 分步教学」
这件事在开源社区还没有可抄的作业**，能参考的只有相邻领域各自做到最好的项目。
这反过来也是本项目的立足点——空白意味着没人把「课程」这件事做进去。

## 2. 参考清单（按与本项目的相关度排序）

| 项目 | star | 许可 | 最近推送 | 借什么 | 落在哪 |
|---|---|---|---|---|---|
| `nilbuild/driver.js` | 26,860 | MIT | 2026-07-18 | 导览时「只留当前焦点」：一步一件事，其余界面让位 | `src/teaching-mode.js` |
| `47ng/nuqs` | 10,863 | MIT | 2026-09-29 | **URL 即状态**：进度只有一份，落在地址栏里，复制链接等于复制现场 | `src/step-link.js` |
| `usablica/intro.js` | 23,460 | 自定义（API 报 NOASSERTION） | 2026-09-21 | 单向引导的克制：学生机打开不该先面对满屏生成面板 | `src/teaching-mode.js` |
| `mrdoob/three.js` | 116,062 | MIT | 2026-09-29 | 底子本身（含 `examples/jsm` 的 GLTFExporter / OrbitControls） | `vendor/three`、`main.js` |
| `google/model-viewer` | 8,260 | Apache-2.0 | 2026-07-07 | 对照基线：hotspot 标注、camera-controls、AR 一条链路 | 下一轮候选（见 §4） |
| `gkjohnson/three-mesh-bvh` | 3,496 | MIT | 2026-09-29 | 射线拾取加速：部件一多，逐 mesh 穷举会掉帧 | 下一轮候选（见 §4） |
| `focus-trap/focus-trap` | 1,562 | MIT | 2026-09-23 | 弹层焦点收束（弹窗开着时 Tab 不该跑到背后的面板里） | `#first-config-modal` 下一轮候选 |
| `mrdoob/stats.js` | 9,152 | MIT | 2024-10-11 | 性能 HUD：帧时间 / 显存涨落一眼看见 | 下一轮候选（见 §4） |

### 借来的两处，以及与原作者做法的差异

**nuqs：URL 即状态。** 本项目把「学到第几步」写进 `location.hash`（`#step=3`），
复制链接即可把同一节课的进度分发出去；换模型、刷新、粘贴链接都落在同一步。
与 nuqs 的两处刻意差异，理由都写在 `src/step-link.js` 的头部注释里：

1. 用 **hash 而不是 search**：静态托管与 `file://` 直接打开都能用，不需要服务端配合；
   也不会让 `?step=` 参与缓存键——本仓库对带 `?v=` 的资产给的是
   `immutable + max-age=31536000`（`src/static-server.js` 的 `staticCacheControl`），
   多一个查询参数就多一份长期缓存副本。
2. 写回用 **replaceState 而不是 pushState**：逐步点下来不会把浏览器历史灌成几十条，
   学生按「后退」离开的是上一页，而不是教案的上一步。

另外坚持一条边界：**深链只是 `currentStep` / `displayedStep` 的镜像，永远不反向当真相**。
`hashchange` 只触发一次 `goToStep`，其余仍走控制器，避免两边互相覆盖。
（这条不是从谁那借的，是 `a49341b`「深度滑块篡改教学步骤」那次踩过之后的教训。）

**driver.js：只留当前焦点。** 授课模式把 AI 生成、上传、配置入口与页脚提示整块收起，
只留 3D 视图与教学控件。与 driver.js 的差别是它收的是「一个导览步骤的注意力」，
这里收的是「一节课的注意力」——焦点不是某个按钮，是模型本身。
实现上有个 driver.js 不需要考虑的坑：被收起的目标里 `#blender-banner` 常态就是
`.hidden`（没检测到 Blender 时也不显示），一刀切地减类会把它「还」出来，
所以 `src/teaching-mode.js` 收起前先记原状、还原时按原状决定去不去类。

## 3. 调研时踩到的两个名字坑（下次别再撞）

- `kamranahmedse/driver.js` **已迁到 `nilbuild/driver.js`**，按旧 owner 查是 404。
- `davidtheclark/tabbable` **已迁到 `focus-trap/tabbable`**（同组织还有 `focus-trap/focus-trap`），旧名同样 404。

## 4. 还没借、值得下一轮借的

| 候选 | 具体做什么 | 为什么现在不做 |
|---|---|---|
| `three-mesh-bvh` | 给部件拾取建 BVH， raycast 不再逐 mesh 穷举 | 当前部件量（15 件）测不出收益，等自定义模型拆分出上百件再上 |
| `mrdoob/stats.js` | 帧时间 / 绘制调用常驻 HUD | 与「教学工具」的定位有冲突，课堂上看不到更干净 |
| `driver.js` 的聚焦环 | 导览模式：高亮当前步骤对应的 UI 控件 | 与授课模式职责重叠，需要先想清楚两者边界 |
| `model-viewer` 的 hotspot | 在模型表面钉讲解点（「这里是ToF 传感器」） | 需要先有部件级锚点数据，属新功能而非优化 |
| `focus-trap` | 「首次配置」弹窗打开时把 Tab 收在弹窗里 | 弹窗当前是首屏可选引导，优先级低于导出与分发 |

## 5. 复现实测数据

```bash
# 单仓指标（star / license / 最近推送 / 是否归档）
curl -s https://api.github.com/repos/nilbuild/driver.js | python3 -m json.tool | head -20

# 细分领域检索（按 star 排序）
curl -s "https://api.github.com/search/repositories?q=blender+exploded+view&sort=stars&per_page=5"
```

> 未认证的 GitHub API 检索限额是 10 次/分钟，且偶发 `IncompleteRead`（响应被截断）。
> 需要连查多个时加重试与间隔，别把截断当成「没有结果」。

## 6. 一句话立场

Tripo AI 把「生成一个爆炸图」变得不值钱了；这个项目的价值在它旁边：
**确定性的拆分 + 可复现的步骤 + 可分发的那一条链接**。参考项目都是为这三件事服务的，
不是为了把生成做得更像 Tripo。
