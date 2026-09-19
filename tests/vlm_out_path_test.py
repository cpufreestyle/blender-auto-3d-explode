#!/usr/bin/env python3
"""
vlm_img_to_blender.py 的 --out 导出路径单测（无需 Blender / 无网络）。

锁定两个缺陷的回归：
  1. 导出路径曾硬编码 "/tmp/vlm_img_to_3d.glb"，在 win32 上不存在该目录；
  2. 路径需真正穿透进发给 Blender 的导出代码，否则 server.js 传的 --out 会被忽略。

运行:
  python3 tests/vlm_out_path_test.py
  pytest tests/vlm_out_path_test.py -v
"""
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_ROOT, os.path.join(_ROOT, "scripts")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import vlm_img_to_blender as m  # noqa: E402


class DefaultExportPathIsPlatformTemp(unittest.TestCase):
    """默认导出路径必须跟随平台临时目录，而非写死 /tmp。"""

    def test_default_matches_platform_tempdir(self):
        expected = os.path.join(tempfile.gettempdir(), "vlm_img_to_3d.glb")
        self.assertEqual(m.EXPORT_PATH, expected)

    def test_default_is_not_hardcoded_posix_tmp(self):
        # 在非 POSIX 平台上，写死的 /tmp 路径是错的；默认值不得含硬编码前缀
        self.assertFalse(m.EXPORT_PATH.startswith("/tmp/"))


class BuildExportCodeThreadsPath(unittest.TestCase):
    """导出代码必须由调用方传入路径，而不是引用旧的模块级常量。"""

    def test_generated_code_embeds_given_path(self):
        custom = os.path.join(tempfile.gettempdir(), "server-passed-123.glb")
        code = m.build_export_code(custom)
        self.assertIn(custom, code)
        self.assertIn("export_scene.gltf", code)

    def test_two_paths_produce_two_snippets(self):
        # 若仍读模块级常量，两次调用会得到完全相同的字符串
        self.assertNotEqual(
            m.build_export_code("/a/one.glb"),
            m.build_export_code("/a/two.glb"),
        )


class ParseArgsAcceptsOut(unittest.TestCase):
    """--out 可被解析，且缺省时回落到平台临时目录。"""

    def test_out_flag_is_accepted(self):
        args = m.parse_args(["--out", "/custom/dir/model.glb"])
        self.assertEqual(args.out, "/custom/dir/model.glb")

    def test_out_defaults_to_export_path(self):
        self.assertEqual(m.parse_args([]).out, m.EXPORT_PATH)


if __name__ == "__main__":
    unittest.main(verbosity=2)
