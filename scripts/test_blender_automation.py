#!/usr/bin/env python3
"""
快速测试 Blender 自动化

测试 Blender 是否能正常执行
"""

import subprocess
import sys

BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender"
TEST_SCRIPT = """
import bpy
print("✅ Blender Python 环境正常")
print(f"📦 Blender 版本: {bpy.app.version}")
print(f"🎯 场景物体数量: {len(bpy.context.scene.objects)}")
"""

def test_blender():
    print("🧪 测试 Blender 执行...")

    try:
        result = subprocess.run(
            [BLENDER_PATH, '--background', '--python-expr', TEST_SCRIPT],
            capture_output=True,
            text=True,
            timeout=30
        )

        print("\n=== STDOUT ===")
        print(result.stdout)

        if result.stderr:
            print("\n=== STDERR ===")
            print(result.stderr)

        if result.returncode == 0:
            print("\n✅ Blender 自动化测试通过！")
            return True
        else:
            print(f"\n❌ 测试失败（退出码 {result.returncode}）")
            return False

    except Exception as e:
        print(f"\n❌ 错误: {e}")
        return False


if __name__ == '__main__':
    success = test_blender()
    sys.exit(0 if success else 1)
