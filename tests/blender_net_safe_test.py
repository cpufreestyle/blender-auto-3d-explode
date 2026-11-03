#!/usr/bin/env python3
"""单元测试 — scripts/blender_net_safe.py（出站 URL/路径安全校验共享模块）。

与各脚本内联版本的语义一致：
  _safe_url：仅 http(s)、无凭证段、IP 字面量边界（非全局 IP 需 allow_private 豁免）
  _safe_path：拒绝含父目录穿越段的写法，返回规范化绝对路径
  _open_url：同函数内校验后打开出站 URL（校验与请求物理相邻）

测试直接 import 真实模块（纯 stdlib，无 bpy 依赖），全部为功能测试。
"""

import importlib
import os
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
bns = importlib.import_module("blender_net_safe")


class SafeUrlTest(unittest.TestCase):
    def test_accepts_public_https(self):
        self.assertEqual(bns._safe_url("https://api.stepfun.com/v1"), "https://api.stepfun.com/v1")

    def test_rejects_non_http_scheme(self):
        with self.assertRaises(ValueError):
            bns._safe_url("ftp://example.com/x")

    def test_rejects_credentials(self):
        with self.assertRaises(ValueError):
            bns._safe_url("https://user:pass@example.com/")

    def test_rejects_non_global_ip_unless_exempted(self):
        with self.assertRaises(ValueError):
            bns._safe_url("https://127.0.0.1:11434/")
        # 本地推理（Ollama 等）走显式豁免
        self.assertEqual(bns._safe_url("http://127.0.0.1:11434/", allow_private=True), "http://127.0.0.1:11434/")

    def test_rejects_link_local_even_when_exempted(self):
        with self.assertRaises(ValueError):
            bns._safe_url("http://169.254.169.254/meta", allow_private=True)

    def test_rejects_garbage(self):
        for bad in ["", None, "::::"]:
            with self.assertRaises((ValueError, TypeError)):
                bns._safe_url(bad)


class SafePathTest(unittest.TestCase):
    def test_accepts_normal_path(self):
        p = bns._safe_path("/tmp/ok/model.glb")
        self.assertTrue(os.path.isabs(p))

    def test_rejects_parent_segment(self):
        with self.assertRaises(ValueError):
            bns._safe_path("../escape.json")
        with self.assertRaises(ValueError):
            bns._safe_path("a/b/../../escape.json")

    def test_rejects_none(self):
        with self.assertRaises((ValueError, TypeError)):
            bns._safe_path(None)


class OpenUrlTest(unittest.TestCase):
    """用假 urllib.request 验证：校验失败不触网，校验通过才发起。"""

    class _FakeURLOpener:
        calls = []
        resp = "RESP"

        def __call__(self, req, timeout=None):
            type(self).calls.append(getattr(req, "full_url", req))
            return type(self).resp

    def setUp(self):
        self._orig = bns.urllib.request.urlopen
        bns.urllib.request.urlopen = self._FakeURLOpener()
        type(self)._FakeURLOpener.calls = []

    def tearDown(self):
        bns.urllib.request.urlopen = self._orig

    def test_blocked_before_request(self):
        req = type("R", (), {"full_url": "https://user:pass@example.com/"})()
        with self.assertRaises(ValueError):
            bns._open_url(req)
        self.assertEqual(self._FakeURLOpener.calls, [], "被拒 URL 不应触网")

    def test_allowed_goes_through(self):
        req = type("R", (), {"full_url": "https://api.stepfun.com/v1"})()
        self.assertEqual(bns._open_url(req, timeout=5), "RESP")
        self.assertEqual(self._FakeURLOpener.calls, ["https://api.stepfun.com/v1"])


if __name__ == "__main__":
    unittest.main()
