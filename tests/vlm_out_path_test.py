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
import importlib
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

    def test_default_follows_platform_tempdir(self):
        # 不能断言 EXPORT_PATH 不以 "/tmp/" 开头：POSIX 上 gettempdir() 本身就返回 /tmp，
        # 那种写法只在本机 macOS（/var/folders/...）成立，到 Linux CI 必红。
        # 真正的回归锁是「路径跟着平台临时目录走」：改 TMPDIR/TEMP/TMP 后重导入模块，
        # 若源码里写死了 /tmp，新目录不会被采用，测试立刻失败。
        with tempfile.TemporaryDirectory() as fake_tmp:
            saved_env = {k: os.environ.get(k) for k in ("TMPDIR", "TEMP", "TMP")}
            saved_cache = tempfile.tempdir
            for key in ("TMPDIR", "TEMP", "TMP"):
                os.environ[key] = fake_tmp
            try:
                # gettempdir() 有缓存；不清掉 tempfile.tempdir，重导入拿到的还是旧目录
                tempfile.tempdir = None
                importlib.reload(m)
                self.assertEqual(
                    os.path.dirname(m.EXPORT_PATH),
                    os.path.abspath(fake_tmp),
                    "默认导出路径必须取自 tempfile.gettempdir()，而不是写死的 /tmp",
                )
            finally:
                tempfile.tempdir = saved_cache
                for key, value in saved_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
                importlib.reload(m)


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
