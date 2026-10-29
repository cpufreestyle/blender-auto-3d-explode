# Blender Auto 3D Explode — 验证面与评审台账 (harness.md)

> 配套 `spec.md`：`spec.md` 定义「应当具备的契约」，本文件记录「如何验证 + 最近一次核验结论」。
> 最近核验：**2026-10-30**（v3.3.3，切口封盖）

## 1. 一键验证命令

```bash
npm ci                  # 安装依赖（`npm test` 需要 node_modules/three，缺了会在 ar-preview 处 ERR_MODULE_NOT_FOUND）

npm run lint:all:check  # ESLint + StyleLint，只检查不改文件（CI 用的就是这组）
npm test                # 56 个 .mjs 套件串行（unit → … → desktop-launcher）
npm run test:py         # Python 侧 unittest（36 项，零依赖）
npm run build           # webpack 生产构建（CI 也跑）

# 需要真机 / 真 Blender 的（不进 npm test 链）：
npm run test:e2e        # 需先 npm run server + Blender
npm run smoke:ui        # 5 条 CDP 冒烟：parts / sidebar / narrow / teaching / print
BLENDER_PATH=/Applications/Blender.app/Contents/MacOS/Blender npm run test:blender
```

## 2. 覆盖率快照（手工盘点，未接 coverage 工具）

| 层 | 文件 | 规模 | 测试覆盖 |
|----|------|------|----------|
| 前端外壳 | `main.js` | 681 行 | 无直接单测（靠模块级单测 + 真机冒烟） |
| 前端模块 | `src/` | 63 个 .js（含 print-analyze / print-export / print-panel） | 大部分有对应 `tests/*-test.mjs` |
| 后端引导 | `server.js` | 408 行 | 无直接单测（逻辑已抽到 `src/routes-*.js` 等工厂，注入 deps 后可测） |
| 后端模块 | `src/routes-generate.js`、`src/routes-blender.js`、`src/static-server.js` 等 | — | 有对应单测 |
| Blender 脚本 | `blender_*.py`、`scripts/*.py` | — | 纯逻辑走 stub 单测；真实版本行为走 `blender-smoke` |

## 3. 只读冒烟（手动，零副作用）

```bash
BASE=http://localhost:3001
curl -s -o /dev/null -w '%{http_code}\n' $BASE/                       # 200 静态首页
curl -s $BASE/api/identity | python3 -m json.tool                       # 即时、不 exec Blender
curl -s $BASE/api/health   | python3 -m json.tool                       # 最长 10s（exec blender --version）
curl -s $BASE/api/ai-config | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/nope                # 404
```

真机冒烟（需 Chrome）：

```bash
npm run smoke:ui     # parts / sidebar / narrow / teaching / print 五条
```

## 4. 最近验证结论（2026-10-30，HEAD 待提交 — 切口封盖）

| 项 | 命令 | 结论 |
|----|------|------|
| 工作区 | `git status` | 干净（commit `18d7449` 已推送 origin/main，含 vendor/ 两个新目录） |
| JS 单元测试 | `npm test` | **62 套件 / 3967 断言 / 0 失败**（print-export-test 71 → 92，新增封盖两组 21 断言） |
| Python 单测 | `npm run test:py` | **36 项 OK** |
| JS lint | `npm run lint:all:check` | **0 errors / 53 warnings**（既有 no-console 基线） |
| CSS lint | `npm run lint:css:check` | 0 errors |
| 生产构建 | `npm run build` | compiled successfully |
| 3D 打印真机冒烟 | `node scripts/ci_print_ui_smoke.mjs` | **25 条全绿**（15 部件 STL 真下载，CSG + 封盖默认开启未破坏导出路径；预检 11 个需处理件中头带的 24 条开放边在导出时自动封盖为水密） |
| 桌面运行时 | launcher restart 后 curl | `/api/identity` 3.3.3 / `/api/health` Blender 5.1.2 OK / `vendor/three-bvh-csg/index.js` 200 |

本轮修掉的三个 CSG 真 bug（详见 `docs/OSS_LEARNING.md` 优化 12）：Brush 的
`updateMatrixWorld` 用本地变换重写手工矩阵（改把世界变换烘进几何体）、销长
`len*1.5` 超出孔深（改凸出量 = 孔深 = pinLength）、`findJoinPairs` 的 `a`/`b`
下标被误当部件对象做 Map 键（改按下标分配销/孔）。CSG 输出经 1e-6 桶哈希焊接
后孔件/销件均完全水密（0 开放边 / 0 非流形边），体积账逐 mm³ 对上。

---
### 上一轮（2026-10-28，HEAD `31096ee` — 3D 打印通道）

| 项 | 命令 | 结论 |
|----|------|------|
| 工作区 | `git status` | 仅本轮新增/修改（print-* 三模块 + 三套测试 + UI 接线 + 文档），无旧遗留（print-* 三模块 + 三套测试 + UI 接线 + 文档），无旧遗留 |
| JS 单元测试 | `npm test` | **61 套件 / 3774 断言 / 0 失败**（含新增 print 三套件 132 断言） |
| Python 单测 | `npm run test:py` | **36 项 OK** |
| JS lint | `npm run lint:check` | **0 errors / 1 warning**（main.js 既有 no-console 基线，新文件 0 warning） |
| CSS lint | `npm run lint:css:check` | 0 errors |
| 生产构建 | `npm run build` | compiled successfully |
| 测试文件盘点 | `ls tests/*.mjs` | 63 个，其中 62 个在 `npm test` 链内，`e2e-test.mjs` 有意排除 |
| 静态守卫 | `tests/dead-markup-test.mjs` / `tests/vendor-three-test.mjs` | 绿（id 数量 92、class 131、版本键一致、vendor 镜像 10 个文件逐字节一致） |
| 3D 打印真机冒烟 | `node scripts/ci_print_ui_smoke.mjs` | **25 条全绿**（15 部件 / 972 三角形 / 11 个因切口开放边报需处理；导出真触发 15 次 .stl 下载） |
| 其余四条冒烟 | `npm run smoke:ui` | parts 18 / sidebar 21 / narrow 24 / teaching 26，均绿 |

本轮修掉的四个真 bug（详见 `docs/OSS_LEARNING.md` 优化 11）：`setIndex` 传裸
`Uint32Array`（r186 下开放边恒为 0，预检永远报水密）、非索引几何顶点索引漏偏移（四处）、
STL 缩放与对位顺序（部件被撑到板下）、vendor 同步脚本在 symlink worktree 下剥离了
`three.core.js`。

| 项 | 命令 | 结论 |
|----|------|------|
| 工作区 | `git status` | 干净（本次仅新增 `spec.md` / `harness.md`） |
| JS 单元测试 | `npm test` | **56 套件 / 3328 断言 / 0 失败** |
| Python 单测 | `npm run test:py` | **36 项 OK**（ai_paint 9 + vlm_out_path 11 + img2depth 14 + blender6_compat 2） |
| JS lint | `npm run lint:check` | **0 errors / 52 warnings**（warning 不阻断，CI 未加 `--max-warnings 0`） |
| CSS lint | `npm run lint:css:check` | 0 errors |
| 生产构建 | `npm run build` | compiled successfully |
| 测试文件盘点 | `ls tests/*-test.mjs` | 57 个，其中 56 个在 `npm test` 链内，`e2e-test.mjs` 有意排除 |
| 静态守卫 | `tests/dead-markup-test.mjs` / `tests/vendor-three-test.mjs` | 绿（id 数量 85、版本键一致、vendor 镜像逐字节一致） |

## 5. CI 质量门（`.github/workflows/ci.yml`，仓库唯一 workflow）

| job | 步骤 | 阻断 |
|-----|------|------|
| `frontend` | `lint:check` → `lint:css:check` → `npm test` → `build` → `npm audit` → 上传 `dist/` | 前四步阻断；`audit` 为 `continue-on-error` |
| `python` | `ruff==0.16.8 check *.py scripts/*.py blender_scripts/*.py tests/*.py` → `pytest==8.4.2`（显式装 numpy） | 阻断 |
| `blender-smoke` | 下载官方 Blender 5.1.2 → `scripts/ci_blender_smoke.py`（拆解 + 程序化建模并对产物断言） | 阻断 |

> 触发：`push` 到 main/master，以及 base 为 main/master/`stack/**` 的 PR（`stack/**` 是历史堆叠栈遗留）。

## 6. Drift 台账（spec ↔ 代码偏差）

| # | 偏差 | 状态 | 处理 |
|---|------|------|------|
| D1 | `docs/HANDOVER.md` §3 称 `main.js` 2855 行、§7 称 2886 行；`AGENTS.md` 称 2886 行 | 已修复 | 实测 681 行；两份文档已同步 |
| D2 | `scripts/blender_control.py` / `scripts/blender_api_server.py` 用 argparse 读全量 `sys.argv`，违反 §I8 的 `--` 分隔约定 | 待解决 | 既有缺陷（非回归）；见 `spec.md` §4，未修 |
| D3 | `AGENTS.md` 称 Python 单测 15 项；`HANDOVER.md` 称 20/34 项 | 已修复 | 实测 36 项；两份文档已同步 |
| D4 | `HANDOVER.md` §8 期望「0 error / 26 warnings」 | 已修复 | 实测 52 warnings；§8 已改 |
| D5 | `docs/ARCH-ROADMAP.md` 称 `server.js` 391 行、`main.js` 625/688 行 | 已修复 | 实测 408 / 681 行；已同步 |
| D6 | `docs/README.md` 与根 `README.md` 版本停在 v3.0.0 (2026-07-06) | 已修复 | 改为指向 3.3.3 并说明 docs/ 的阶段性文档只作历史参考 |
| D7 | `AGENTS.md` 端点清单只有 6 条 | 已修复 | 实测 16 条；已同步并指向 `spec.md` §3 |

## 7. 未决 / 下一步

1. **补测试**：`main.js` 应用外壳与 `server.js` 引导仍无直接单测（见 `spec.md` §7）。
2. **D2**：修 `scripts/blender_control.py` / `scripts/blender_api_server.py` 的参数解析，使其走 `--` 分隔。
3. **快照漂移**：本文件与 `spec.md` 的行数 / 计数是快照；代码演进后按 §6 记账并更新。
4. **可选**：引入 coverage 工具，把 §2 的手工快照升级为可复现数字。
