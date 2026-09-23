# 项目交接文档（HANDOVER）

> 交接对象：`blender-auto-3d-explode` / 本地目录名 `quest3-exploded`
> 远程：`https://github.com/cpufreestyle/blender-auto-3d-explode.git`
> 文档日期：2026-09-20（末次修订 2026-09-23，见下方「复核后落地」）
> 交接时状态（2026-09-20，三条不同指针，别搞混）：
> - 本地 `main` = `dc0678b`，**落后 origin/main 恰好 1 个提交、无分叉**（`gh api compare` 实测 ahead_by=1 / behind_by=0，可快进）
> - 远程 `origin/main` = `101e7ec`（v3.2.13 拆解状态导出 GLB，由另一会话/机器推入；因 git 直连被墙，本地 `origin/main` 引用仍是过期的 `dc0678b`，见 §6）
> - 本地分支 `fix/python-ruff-lint` = `e2eb2fb`（基于 `dc0678b`），**尚未推送、尚未开 PR**
> - CI 现状：`main` 上 **CI workflow 连续失败**，失败点是 `Python — Lint & Test` job 的 **Lint Python** 步骤；`Build and Test` workflow 为绿
>
> **2026-09-23 复核后**：上述待办已全部处理（见 §1 末尾「复核后落地」与 §7）。当前 `origin/main` = `cb48590`，CI 双 job 全绿。

---

## 1. 交接概览

一个基于 **Three.js + Node.js + Blender** 的交互式 3D 拆解教学工具：加载/生成模型 → 爆炸视图动画 → 分步骤拆解教学 → WebXR AR 预览。当前版本 `3.2.12`（本地）/ `3.2.13`（远程）。

**最近一轮成果：**

| 主题 | 内容 | 提交 |
|---|---|---|
| Python lint 质量门 | `ruff.toml` 把规则集收窄到真实缺陷类，93 项历史报错清零，CI 锁定 ruff 版本 | `e2eb2fb`（**未推送**） |
| CI 静默失败 | 移除 lint 步骤的 `continue-on-error`，让失败真正阻断 | `dc0678b` |
| 图片转 3D 缺陷 | VLM 子进程无超时导致请求永久挂起、win32 硬编码 `/tmp` 导出路径、三处逐字重复 | `fceaae5` |
| 教案导出 | 拆解教案复制到剪贴板 | `e7ca032` |
| 拆解状态导出 | 导出当前拆解状态为二进制 glTF（`GLTFExporter` + `exportGLB()`） | `101e7ec`（仅远程） |
| 技术选型 | Unity 迁移可行性评估：**暂不迁移** | `bd33c92` |

### 复核后落地（2026-09-23，把上文待办逐个收掉）

| 主题 | 内容 | 提交 / PR |
|---|---|---|
| Python 质量门转绿 | ruff 规则集收窄到 `E4/E7/E9/F` + 修掉 93 项真实缺陷；CI 固定 `ruff==0.16.8`、移除 `continue-on-error`、检查范围覆盖 `scripts/` 与 `blender_scripts/` | `89ad413` / #10 |
| Linux CI 必红的测试 | `test_default_is_not_hardcoded_posix_tmp` 用 `startswith("/tmp/")` 判断「是否写死 /tmp」，只在 macOS 成立；改为改 `TMPDIR/TEMP/TMP` 后重导入模块断言跟随平台临时目录（已做变异验证） | 同上，stack 在 #10 |
| 唯一质量门 | 删除 `build-and-test.yml`（与 `ci.yml` 重复且信号互相矛盾），质量门收拢到 `ci.yml`；lint 步骤改用 `lint:check` / `lint:css:check`，CI 只检查不在 runner 上边跑边改；固定 `pytest==8.4.2` | `f712c8c` / #12 |
| 被 `--fix` 掩盖的缺陷 | 新增 `lint:check` 系列前提是把存量 4 处（`main.js` 尾逗号、`style.css` 3 处空行）落成显式修复，否则 main 当场变红；`validate` 改为 `lint:all:check`，不再顺手改文件 | 同上 |
| `test:py` 静默漏测 | 收集模式 `'ai_paint_test.py'` → `'*_test.py'`，零依赖跑满 15 项（原先只跑 9 项还报 OK） | 同上 |
| VLM 并发产物互踩 | 固定临时文件名改为每请求唯一（`createVlmJobPaths()` 提取到 `src/server-utils.js` 并可单测），请求结束在 `finally` 清理；Python 侧新增 `--code-out`，不再写死 `scripts/_vlm_generated_blender.py` | `cb48590` / #13 |
| Blender 5.x 兼容 | 两个控制器脚本改为解析 `--` 之后的参数（原先照文档用法执行必报 `unrecognized arguments`）；21 处 `nodes["Principled BSDF"]` 改为按节点类型查找（中文界面下节点叫 `原理化 BSDF`，按名索引不是 KeyError 就是静默失效） | #14 |

---

## 2. 环境准备与启动

```bash
npm install          # 安装依赖
npm run dev          # 前端静态服务（npx serve . ，默认 3000）
npm run server       # Node 后端（server.js，默认 3001，调用 Blender）
npm test             # 单元（209 项）+ provider（38 项）测试
npm run test:py      # Python 侧单测（20 项，零依赖，与 CI 的 pytest tests/ 同一批）
npm run test:e2e     # E2E
npm run lint:all     # ESLint + StyleLint（带 --fix，会改文件）
npm run lint:all:check  # 同上但不改文件，CI 用的就是这组
npm run validate     # lint:all:check + test（提交前跑，不会改任何文件）
```

Python 侧工具**本机没装、也不必 pip 安装到系统环境**，用 `uvx` 复现 CI：

```bash
uvx ruff@0.16.8 check *.py scripts/*.py blender_scripts/*.py tests/*.py
uvx pytest@8 tests/ -q      # 15 passed（= ai_paint 9 + vlm_out_path 6）
```

> ⚠️ **Python 测试入口三件套并不等价**（实测）：`npm run test:py` 只按 `-p 'ai_paint_test.py'`
> 收集，跑 **9** 项；`python3 -m unittest discover -s tests` 因默认模式 `test*.py` 不匹配仓库里的
> `*_test.py` 命名，跑 **0** 项且仍然输出 OK（静默空跑）；只有 CI 用的 `pytest tests/` 跑满 **15** 项。
> 本地验 Python 侧请用 `uvx pytest@8 tests/`，别用 discover。

- **必须安装 Blender**。本机实测二进制是 `/Applications/Blender.app/Contents/MacOS/Blender`
  （**大写 B**，小写 `blender` 找不到），版本 5.1.2；未加入 PATH。
- 可用 `BLENDER_PATH` 覆盖自动探测。
- 健康检查：`GET http://localhost:3001/api/health`
- `server.js` 依赖 `undici`（`package.json` 声明 `^8.10.0`）。曾出现**声明了但 node_modules 里缺失**，
  导致后端启动即 `ERR_MODULE_NOT_FOUND`；`npm install undici` 可补，但会把 package.json 顶到 `^8.10.2`，
  注意别让这种版本号漂移混进提交。

---

## 3. 架构速览

| 模块 | 文件 | 职责 |
|---|---|---|
| 3D 场景引擎 | `main.js`（实测 2855 行） | Three.js 场景、OrbitControls、GLB/STL 加载、爆炸动画、乐高砖块、WebXR AR、导出 |
| Node 后端 | `server.js`、`src/server-utils.js`、`src/body.js`、`src/logger.js` | 零外部依赖 HTTP 服务，调用 Blender CLI |
| 数据/步骤 | `src/quest3-data.js`、`src/quest3-steps.js` | Quest 3 规格、分步骤拆解教学方案 |
| 几何/材质 | `src/geometry-split.js`、`src/lego-materials.js`、`src/utils.js` | 连通分量/材质分组拆分、UnionFind、原生与乐高材质 |
| 云端适配 | `src/providers/image-to-3d.js`、`src/provider-models.js` | Meshy / Tripo / Hyper3D / Replicate 图片转 3D |

**可测试性惯例（重要）**：`server.js` **零导出**，无法直接单测。历史上遇到需要测的服务端逻辑，
一律**提取到 `src/server-utils.js`** 再测——本轮新增 `elapsedSeconds`（9 处计时格式化收口）、
复用 `waitForChildExit`（子进程带超时等待）就是这个套路。

**providers 内部去重**：`pollTask` 已导出供 `server.js` 的 Replicate 轮询复用；
Hyper3D 图生/文生共用模块私有的 `finishHyper3DTask`（轮询 → 取下载列表 → 拿 GLB 字节）。

**关键后端端点**

| 端点 | 说明 |
|---|---|
| `POST /api/split` | 接收 GLB，Blender 拆解，返回二进制 GLB + manifest |
| `POST /api/ai-paint` | 提示词生成 3D 模型 |
| `POST /api/image-to-3d` | 图片转 3D（本地 / 云端 / VLM） |
| `POST /api/text-to-3d` | 文生 3D |
| `GET /api/health` | Blender 健康检查 |
| `GET /api/assembly/sequence`、`/api/assembly/analysis` | 装配拆解顺序与分析 |

---

## 4. 图片转 3D：三条路径与默认行为（重点）

| 路径 | 触发条件 | 是否可拆解 | 依赖 |
|---|---|---|---|
| **本地 relief/voxel（默认）** | `deploy: "local"` | ✅ 天生切成 `tiles×tiles` 个独立网格 | 仅需 Blender |
| TripoSR「真重建」 | 显式勾选 / `real: true` | ❌ 单网格 | 需 venv + 权重（CPU 慢） |
| 云端 Meshy / Tripo / Hyper3D / Replicate / VLM | 配置 Key 或 `auto` 回退 | 视 provider | 需 API Key |

**服务端关键参数与硬上限**（`runLocalReliefImageTo3D`，`server.js`）：

- `mode`：`relief`（亮度挤出高度图）｜ `voxel`（像素方块）
- `tiles`：默认 **3**（→ 9 块，拼合即还原、爆炸即分离）；上限 8
- `resolution`：默认 128，上限 **512**（防 Blender 内存爆炸）
- `depth`：默认 0.35，上限 2
- `texture`：**默认 `true`**，GLB 内嵌原图，保留颜色

> ⚠️ **重大认知前提**：本地 relief/voxel 是**高度图挤出/像素量化**，属于"示意图 3D"，**不是真几何重建**——
> 无背面、无遮挡、立体感有限。它存在的意义是"离线即用 + 天生可拆解"。若要真实几何，走 TripoSR / 云端 / VLM。

**VLM 路线（`scripts/vlm_img_to_blender.py`）本轮修的两处，理解成本最高：**

1. **超时**：改用 `waitForChildExit(child, VLM_IMAGE_TO_3D_TIMEOUT_MS, ...)`，上限 **30 分钟**
   （= `MAX_RETRIES(4)` 轮「大模型生成代码 + Blender 执行 + 自动修复」的最坏耗时）。
   此前 Blender addon 或大模型请求一挂，该 HTTP 请求就永久占住连接，并留下孤儿 python 进程。
2. **win32 导出路径**：不再硬编码 `/tmp/vlm_img_to_3d.glb`，改为 `tempfile.gettempdir()` 且新增 `--out`
   参数由调用方指定。Windows 上没有 `/tmp`，旧写法在该平台必然读不到 GLB。

---

## 5. 关键决策与已知坑位（踩过的雷，别再踩）

1. **`execFileAsync` 参数数组**：曾把 `BLENDER_PATH` 误放进 `args` 开头，Blender 把自身路径当 `.blend`
   解析 → 报"文件格式不支持"。`args` 必须从 `--background` 起。
2. **Blender 退出码**：后台模式常因无关 addon（tripo_addon / BlenderMCP）卸载清理以**非零码退出**，
   但产物往往已成功写出。判定成功以 **GLB 是否产出**为准，不要只看退出码。
3. **Blender MCP addon**：启用模块名必须叫 `blender_mcp_addon`（与文件同名）；**后台模式（`blender -b`）
   下 addon 不启动 MCP server**，那条日志属正常。
4. **GLB 导出**：GLB 模式自动内嵌贴图，**不要**传 `export_textures`（会报错）。
5. **自动打开 Blender GUI**：默认**关闭**，由 `OPEN_IN_BLENDER=0/1` 或 `ai-config.json` 的 `openInBlender` 控制。
6. **磁盘增长**：生成物落 `models/generated`，已有 TTL 清理（启动 + 每小时，1 小时过期）。
7. **测试用图**：手写 PNG base64 极易 CRC 损坏（`IDAT: CRC error` + `IndexError`）。E2E 请用 `zlib.deflateSync`
   程序生成有效 PNG。
8. **Python 脚本约定**：`blender --background --python x.py -- args`；参数在 `--` 之后**手动解析**（不用 argparse）；
   日志必须 `print(..., flush=True)`（Blender 后台缓冲 stdout）；除 `bpy/bmesh/mathutils` 外零 pip 依赖假设。
9. **不要让 lint 反向改造容错结构**：ruff 出厂规则在本仓库报 373 项，其中 141 项与 AGENTS.md 直接冲突
   （BLE001 禁裸 `Exception` 106 项、S110 禁 `try/except/pass` 27 项、TRY002 8 项），另 41 项 UP/pyupgrade
   与「同一脚本跑在 Blender 4.x/5.x 自带 Python 上」相悖。已用 `ruff.toml` 收窄为 `E4/E7/E9/F`，
   只修真缺陷（HEAD 93 项 → 0）。
10. **`npm run validate` 会改文件**：其中 stylelint `--fix` 曾把 `style.css` 顶出两个空行。跑完先
    `git status` 再提交。
11. **两个脚本违反 argparse 约定（既有缺陷，未修）**：`scripts/blender_control.py` 与
    `scripts/blender_api_server.py` 直接 `parse_args()` 读全量 `sys.argv`，不走 `--` 分隔，
    所以 `blender -b --python 它 -- --demo` 必报 `unrecognized arguments`。`dc0678b` 前后行为一致，
    不是新引入的回归。要验证这两个脚本，用 `runpy.run_path(..., run_name=...)` 注入 `sys.argv`。
12. **Blender 5.1 兼容性缺口（既有缺陷）**：`blender_control.apply_material()` 取
    `mat.node_tree.nodes["Principled BSDF"]` 在 5.1 下抛 `KeyError`，即 `--demo` 路径跑不完。
13. **VLM 固定临时文件名（已发现，未修）**：`vlm_in.png` / `vlm_img_to_3d.glb` 是常量名，
    并发请求会互相覆盖产物。要修得改成唯一目录或带 pid/uuid 的文件名。
14. **本机 shell 有坏函数**：`ls / grep / tail / head / find / git / gh` 会被一个不存在 `_lc` 函数接管。
    用 `command <bin>`，或 `grep` 用内置 Grep 工具；`gh` 走绝对路径 `/opt/homebrew/bin/gh`。
15. **`git commit -m "$(cat <<EOF…)"` 会静默变成空信息并放弃提交**：把消息写进文件用 `git commit -F <file>`。

---

## 6. 仓库协作 / 推送约束（重要）

- ⚠️ **本沙箱直连 GitHub HTTPS(443) 被防火墙拦截**。实测：`git fetch origin main` →
  `LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443`。
  推送需先连上 **MacPacket / VPN**（SOCKS 代理 `127.0.0.1:1082`，由 `~/.ssh/config` 的 `ProxyCommand` 引用）。
  - 判据：`curl --socks5 localhost:1082 https://github.com` 返回 **"SOCKS error 1"** 即 VPN 未接通。
  - 端口 8898 的 "Agnes fix proxy" **不是** git 可用出口，勿用作 git 代理。
- **`gh` CLI 与 `git` 走的通道不同**：git 被拦时 `/opt/homebrew/bin/gh run list` / `gh api` 仍可正常读取
  远程状态。所以"远程到哪了""CI 为什么红"这类问题优先用 `gh` 查，不必等 VPN。
- **远程会被其他会话/机器推进**（本次交接就已发生：origin/main 已到 `101e7ec`）。push 报
  **non-fast-forward** 时的标准流程：
  ```bash
  git fetch origin main
  git rebase origin/main     # 有冲突则解决后 git rebase --continue
  git push origin main
  ```
  **禁止 `--force` 强推。** 动手前先 `git fetch` 确认指针，别信本地缓存的 `origin/main`。
- 提交信息风格：`type(scope):` + 中文摘要（feat / fix / perf / refactor / docs / test / chore）。

---

## 7. 待办与后续建议（按优先级）

> **2026-09-23 复核**：原 P0（同步并推送 lint 修复）与三条 **Next**（合并 workflow、VLM 并发互踩、修 `test:py` 收集范围）已全部落地并合入，见 §1「复核后落地」。下表只留仍未处理的部分。

| 优先级 | 事项 | 说明 |
|---|---|---|
| **Next** | 本地"真实深度"模式 | 当前本地是亮度挤出/像素量化，属"示意图 3D"，无背面、无遮挡。可接轻量单图深度估计（Depth Anything 一类）或复用 VLM 路径，但别破坏"离线即用 + 天生可拆解"这两个既有优点 |
| Later | `main.js` 继续拆分 | 实测 2886 行（`AGENTS.md` 已同步为 2886）；已抽出 `model-loaders.js`、`quest3-parts.js`、`explode-geometry.js`，建议继续拆爆炸动画 / AR / 面板 |
| Later | 统一图片转3D调度器 | 本地 / 云端 / VLM 三条路径散落在 `handleImageTo3D`，回退与超时逻辑重复，建议抽象 `generateImageTo3D()` |
| Later | E2E / Blender 冒烟进 CI | 本轮只收敛了 workflow，没加新门禁。`blender_split_glb.py` 冒烟是最硬的证据，但 runner 上装 Blender 会明显变慢，值得单独评估 |
| Later | `Material.use_nodes` 迁移 | Blender 6.0 计划移除该属性（本机 5.1 已报 DeprecationWarning），涉及仓库所有材质创建处 |
| Later | 清理 `scripts/_vlm_generated_blender.py` | 该文件是纳入版本控制的生成产物；改为按 `--out` 派生后已不再被覆盖，可考虑 gitignore 或直接删除 |

---

## 8. 交接验收清单

```bash
# 1) Python 质量门（与 CI 的 Lint Python 完全一致）
uvx ruff@0.16.8 check *.py scripts/*.py blender_scripts/*.py tests/*.py   # 期望 All checks passed!
uvx pytest@8 tests/ -q                                                    # 期望 20 passed

# 2) JS 质量门
npm run lint:check  # 期望 0 errors（既有 26 条 warning 不阻断：CI 未加 --max-warnings 0）
npm test         # 期望 unit 209/0、provider 38/0

# 3) Blender 实跑（最硬的一条证据，证明 Python 侧行为没被改坏）
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python blender_split_glb.py -- \
  --input "$PWD/models/quest3_model.glb" --output /tmp/split_out.glb --manifest /tmp/split_manifest.json
# 期望：✅ 拆解完成！15 个部件，GLB ≈ 113 KB，manifest.total_parts = 15

# 4) 后端健康 + 本地图片转3D（需先 npm run server）
curl -s http://localhost:3001/api/health
node /tmp/e2e_img3d.mjs    # 期望 200 / X-Success: true / X-Total-Parts: 9
```

上述数字是**本地分支 `e2eb2fb` 上的实测值**。origin/main 已前进一个提交，其测试计数可能略有差异。

---

## 9. 参考文档索引

- 项目规范（**接手先读**）：`AGENTS.md` — 构建命令、模块架构、编码与 Python 脚本约定
- Python 质量门：`ruff.toml`（规则集收窄理由写在文件头注释里）
- Blender 相关：`BLENDER_QUICK_START.md`、`BLENDER_MCP_INTEGRATION.md`、`BLENDER_MCP_TROUBLESHOOTING.md`、`BLENDER_PYTHON_API.md`
- AR/WebXR：`WEBXR_AR_IMPLEMENTATION.md`、`AR_FEATURE_COMPLETE.md`、`AR_TEST_QUICKSTART.md`
- 图片转 3D：`VLM_IMAGE_TO_3D.md`、`LOCAL_IMAGE_TO_3D.md`
- 排障：`TROUBLESHOOTING.md`、`EXPLOSION_TROUBLESHOOTING.md`、`BUG_REPORT.md`
- 选型：`UNITY_MIGRATION_PLAN.md`（暂不迁移）
- 版本：`CHANGELOG.md`、`RELEASE_NOTES_v3.0.0.md`

> 本文档已于 2026-09-23 纳入版本控制（随本轮复核一起提交）。后续改动请直接改这里，别另起新文档——
> `docs/` 下已经有 40+ 个阶段性总结文件，信息重复是最大的维护成本。
