#!/usr/bin/env python3
"""把 dev 模式 importmap 用的 vendor/three 镜像同步为 node_modules/three 的同构副本。

背景：index.html 的 importmap 把裸 "three" 与 "three/examples/jsm/..." 映射到
/vendor/three/...（dev 模式 npx serve . / node server.js 下裸导入的解析手段；
webpack 构建产物走 node_modules，不经过这里）。镜像与 node_modules/three 一旦
漂移，dev 与生产就跑在不同的 three 上，且不报错——本仓库历史上就漂过 26 个
版本（镜像停在 r160，package.json 早已 0.186），GLTFExporter 的 utils 相对路径
在平铺布局下也是断的。

做法：以一组入口文件（core 构建产物 + 源码实际 import 的 5 个 examples）做
BFS，沿相对导入（from './x' / from '../x'）求闭包，同构拷贝进 vendor/three/，
并清掉镜像里不在闭包内的残留文件。入口清单与 tests/vendor-three-test.mjs 的
期望清单、守卫断言三者对齐；升级 three 后跑 `npm run vendor:sync` 一次即可。

用法：python3 scripts/vendor_three_sync.py
"""

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "node_modules" / "three"
DEST = ROOT / "vendor" / "three"

# 源码实际 import 的 examples 入口（main.js + src/ 全量扫描见守卫测试）
ENTRIES = [
    "build/three.module.js",
    "examples/jsm/controls/OrbitControls.js",
    "examples/jsm/exporters/GLTFExporter.js",
    "examples/jsm/geometries/RoundedBoxGeometry.js",
    "examples/jsm/loaders/GLTFLoader.js",
    "examples/jsm/loaders/STLLoader.js",
]

REL_IMPORT = re.compile(r"""from\s+['"](\.{1,2}/[^'"]+)['"]""")


def resolve(spec: str, importer: Path) -> Path:
    return (importer.parent / spec).resolve()


def closure() -> set:
    seen = set()
    queue = [SRC / e for e in ENTRIES]
    while queue:
        f = queue.pop()
        rel = f.relative_to(SRC)
        if rel in seen:
            continue
        seen.add(rel)
        text = f.read_text(encoding="utf-8")
        for spec in REL_IMPORT.findall(text):
            target = resolve(spec, f)
            if target.exists() and SRC in target.parents:
                queue.append(target)
    return seen


def main() -> int:
    if not SRC.is_dir():
        print(f"ERROR: {SRC} 不存在，先 npm ci")
        return 1
    files = sorted(closure())
    for rel in files:
        src = SRC / rel
        dst = DEST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    # 清掉不在闭包内的残留（例如旧版平铺文件、上游已无人引用的 utils）
    stale = []
    if DEST.is_dir():
        for p in sorted(DEST.rglob("*")):
            if p.is_file() and p.relative_to(DEST) not in files:
                stale.append(p.relative_to(ROOT))
                p.unlink()
    print(f"synced {len(files)} files into {DEST.relative_to(ROOT)}/")
    for rel in files:
        print(f"  + {rel}")
    for s in stale:
        print(f"  - {s} (stale, removed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
