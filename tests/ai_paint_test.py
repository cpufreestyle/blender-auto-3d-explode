#!/usr/bin/env python3
"""
blender_ai_paint.py 的纯逻辑单测（无需 Blender）。

通过向 sys.modules 注入 bpy/bmesh/mathutils 的 stub，使模块可在 Blender 外导入，
仅验证提示词 -> 生成器 的派发逻辑（不实际执行 Blender 几何生成）。

运行:
  python3 -m unittest discover -s tests -p 'ai_paint_test.py'
  python3 tests/ai_paint_test.py
"""
import os
import sys
import types
import unittest

# 在导入 blender_ai_paint 之前注入 Blender 专有模块的 stub
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

for _name in ('bpy', 'bmesh', 'mathutils'):
    _mod = types.ModuleType(_name)
    sys.modules[_name] = _mod
sys.modules['mathutils'].Vector = object  # 仅占位，导入期不调用

import blender_ai_paint as m  # noqa: E402


class MatchPromptDispatchTest(unittest.TestCase):
    """验证 match_prompt 把预设关键词派发到对应的真实生成器（回归锁）。"""

    def test_airplane_dispatches_to_create_airplane(self):
        # 本次修复的核心：飞机必须调用真实 create_airplane，而非乐高兜底
        self.assertIs(m.match_prompt('飞机'), m.create_airplane)
        self.assertIs(m.match_prompt('airplane'), m.create_airplane)
        self.assertIs(m.match_prompt('一架客机'), m.create_airplane)

    def test_car_dispatches_to_create_car(self):
        self.assertIs(m.match_prompt('汽车'), m.create_car)
        self.assertIs(m.match_prompt('car'), m.create_car)

    def test_robot_dispatches_to_create_robot(self):
        self.assertIs(m.match_prompt('机器人'), m.create_robot)
        self.assertIs(m.match_prompt('robot'), m.create_robot)

    def test_house_dispatches_to_create_house(self):
        self.assertIs(m.match_prompt('房子'), m.create_house)

    def test_rocket_dispatches_to_create_rocket(self):
        self.assertIs(m.match_prompt('火箭'), m.create_rocket)

    def test_quest3_dispatches_to_create_quest3(self):
        self.assertIs(m.match_prompt('quest'), m.create_quest3)

    def test_case_insensitive(self):
        # 关键词匹配统一 lower，英文大小写都应命中
        self.assertIs(m.match_prompt('AIRPLANE'), m.create_airplane)
        self.assertIs(m.match_prompt('Robot'), m.create_robot)

    def test_lego_returns_callable_not_marker_string(self):
        # 回归：修复 creator 派发后，乐高模板曾错误地返回字符串 'lego_style'，
        # 导致 main() 中 creator() 抛 TypeError。此处锁死它必须返回可调用对象。
        result = m.match_prompt('乐高')
        self.assertNotEqual(result, 'lego_style')
        self.assertTrue(callable(result))

    def test_unmatched_prompt_falls_back_to_lego_style(self):
        # 未命中任何预设时返回可调用（默认走 create_lego_style）
        result = m.match_prompt('一只完全随机的独角兽xyz')
        self.assertTrue(callable(result))


if __name__ == '__main__':
    unittest.main(verbosity=2)
