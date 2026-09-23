#!/usr/bin/env python3
"""
Blender 6.0 兼容性守卫测试（纯静态扫描，无需 Blender）。

Blender 5.x 已对 Material.use_nodes / World.use_nodes 报弃用警告，6.0 将移除该属性。
本机 5.1.2 探针确认：新建材质与世界默认就带 node_tree（含原理化 BSDF + 材质输出），
GLB 导入的材质同样全部带节点树，因此兼容写法就是直接用 node_tree，不再赋值 use_nodes。

这里把迁移成果锁死：
- 仓库所有 Blender 脚本不得再出现 .use_nodes 读写（防止回潮）
- 关键脚本仍在使用 node_tree（防止有人为消警告把用法一并删掉，那会让材质变默认灰）

运行:
  python3 -m unittest discover -s tests -p 'blender6_compat_test.py'
  python3 tests/blender6_compat_test.py
"""
import os
import re
import unittest

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与 ruff 检查范围一致：仓库根、scripts/、blender_scripts/ 下的 Python 脚本（不含 tests/）
_SCAN_DIRS = (".", "scripts", "blender_scripts")

# 迁移后仍应直接使用 node_tree 的关键文件
_KEY_FILES_WITH_NODE_TREE = (
    "blender_image_to_3d.py",
    "quest3_exploded_blender.py",
    "blender_scripts/quest3_exploded.py",
    "blender_ai_paint.py",
    "blender_split_glb.py",
)


def _repo_python_files():
    for rel in _SCAN_DIRS:
        base = os.path.join(_PROJECT_ROOT, rel)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            if name.endswith(".py"):
                yield os.path.join(rel, name)


class DeprecatedUseNodesScanTest(unittest.TestCase):
    """扫描仓库 Blender 脚本，确保不再读写已弃用的 use_nodes 属性。"""

    def test_no_use_nodes_attribute_usage(self):
        pattern = re.compile(r"\.use_nodes\b")
        offenders = []
        for rel in _repo_python_files():
            with open(os.path.join(_PROJECT_ROOT, rel), encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    if pattern.search(line):
                        offenders.append(f"{rel}:{lineno}: {line.strip()}")
        self.assertEqual(
            offenders, [],
            "以下位置仍在读写 use_nodes（Blender 6.0 将移除）：\n" + "\n".join(offenders),
        )

    def test_key_scripts_still_use_node_tree(self):
        for rel in _KEY_FILES_WITH_NODE_TREE:
            with open(os.path.join(_PROJECT_ROOT, rel), encoding="utf-8") as fh:
                content = fh.read()
            self.assertIn(
                "node_tree",
                content,
                f"{rel} 应直接使用 node_tree（use_nodes 迁移不应把节点树用法一并删掉）",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
