#!/usr/bin/env python3
"""
vlm_img_to_blender.py 的 --out 导出路径单测（无需 Blender / 无网络）。

锁定两个缺陷的回归：
  1. 导出路径曾硬编码 "/tmp/vlm_img_to_3d.glb"，在 win32 上不存在该目录；
  2. 路径需真正穿透进发给 Blender 的导出代码，否则 server.js 传的 --out 会被忽略。
  3. 最终生成的代码同样不能落到固定文件名上（旧行为写死 scripts/ 下的名字，
     并发调用会互相覆盖，还会弄脏仓库工作区）。

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


class GeneratedCodePathFollowsOut(unittest.TestCase):
    """最终生成代码的落盘路径必须随 --out 走，不能是固定文件名。"""

    def test_derives_from_out_path(self):
        out = os.path.join(tempfile.gettempdir(), "a.glb")
        expected = os.path.join(tempfile.gettempdir(), "a_generated.py")
        self.assertEqual(m.generated_code_path(out), expected)

    def test_two_out_paths_produce_two_paths(self):
        # 固定名会让两个并发调用互相覆盖对方的代码文件
        self.assertNotEqual(
            m.generated_code_path("/tmp/one.glb"),
            m.generated_code_path("/tmp/two.glb"),
        )

    def test_default_derived_path_is_next_to_output(self):
        # 默认（不显式给 --code-out）时，代码文件挨着产物，而不是写死在 scripts/ 里
        self.assertEqual(
            os.path.dirname(m.generated_code_path(m.EXPORT_PATH)),
            os.path.dirname(m.EXPORT_PATH),
        )


class ParseArgsAcceptsCodeOut(unittest.TestCase):
    """调用方可显式指定最终代码的落盘路径（server.js 就是这么传的）。"""

    def test_code_out_flag_is_accepted(self):
        args = m.parse_args(["--out", "/d/o.glb", "--code-out", "/d/o_generated.py"])
        self.assertEqual(args.code_out, "/d/o_generated.py")

    def test_code_out_defaults_to_none(self):
        # 缺省为空，由 generated_code_path(args.out) 派生
        self.assertIsNone(m.parse_args([]).code_out)


class ParseArgsAcceptsOut(unittest.TestCase):
    """--out 可被解析，且缺省时回落到平台临时目录。"""

    def test_out_flag_is_accepted(self):
        args = m.parse_args(["--out", "/custom/dir/model.glb"])
        self.assertEqual(args.out, "/custom/dir/model.glb")

    def test_out_defaults_to_export_path(self):
        self.assertEqual(m.parse_args([]).out, m.EXPORT_PATH)


if __name__ == "__main__":
    unittest.main(verbosity=2)
