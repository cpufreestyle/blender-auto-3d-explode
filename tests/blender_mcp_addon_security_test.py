#!/usr/bin/env python3
"""单元测试 — blender_mcp_addon.py 安全硬化（零外部依赖，纯源码扫描）。

Mimosa 对 addon 标记 16 项（1 代码注入 + 4 路径穿越 + 11 SSRF），修复三件套：
safe_get（协议 + 闭合主机白名单）、validate_asset_id（ID 字符白名单）、
safe_join（路径包含性校验，防 zip-slip）。本测试用正向源码断言钉住不变量，
功能用例待实现落地后以小块追加（避免在测试源码出现 exec/恶意 URL 字面量）。
"""

import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADDON = os.path.join(REPO, "scripts", "blender_mcp_addon.py")


class AddonSourceInvariantsTest(unittest.TestCase):
    """源码扫描：正向断言钉住 addon 的安全不变量。"""

    @classmethod
    def setUpClass(cls):
        with open(ADDON, "r", encoding="utf-8") as f:
            cls.src = f.read()

    def test_outbound_requests_routed_through_safe_get(self):
        self.assertGreaterEqual(
            self.src.count("safe_get("),
            11,
            "11 个出站请求点必须全部走 safe_get（协议+主机白名单校验）",
        )

    def test_exec_gated_by_preference(self):
        """execute_code 必须有偏好项门禁（默认关，插件偏好显式开启才可用）。"""
        m = re.search(r"def execute_code\(.*?(?=\n    def |\nclass |\Z)", self.src, re.S)
        self.assertIsNotNone(m, "找不到 execute_code")
        self.assertIn("allow_remote_code_exec", m.group(0), "execute_code 缺少偏好项门禁")

    def test_zip_extraction_safe(self):
        self.assertIn("extract_member_safe(", self.src, "zip 解包必须逐成员校验（防 zip-slip）")

    def test_helpers_block_exists(self):
        self.assertIn("def is_allowed_url(", self.src, "缺少 URL 白名单校验函数")
        self.assertIn("def validate_asset_id(", self.src, "缺少资产 ID 校验函数")
        self.assertIn("def safe_join(", self.src, "缺少路径包含性校验函数")


if __name__ == "__main__":
    unittest.main()
