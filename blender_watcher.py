#!/usr/bin/env python3
"""
Blender 文件监听自动执行器

监听指定目录下的 Python 脚本文件变化，自动在 Blender 中执行

使用方法：
python3 blender_watcher.py --watch-dir ./blender_scripts --output-dir ./output

依赖：
pip3 install watchdog
"""

import os
import sys
import time
import json
import argparse
import subprocess
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler


class BlenderScriptHandler(FileSystemEventHandler):
    """监听 Python 脚本文件变化"""

    def __init__(self, blender_path, output_dir):
        self.blender_path = blender_path
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        self.last_modified = {}
        self.debounce_seconds = 1.0  # 防抖：1秒内的多次修改只执行一次

    def on_modified(self, event):
        """文件修改时触发"""
        if event.is_directory:
            return

        filepath = Path(event.src_path)

        # 只处理 .py 文件
        if not filepath.suffix == '.py':
            return

        # 防抖：检查是否在短时间内重复触发
        now = time.time()
        last_time = self.last_modified.get(str(filepath), 0)
        if now - last_time < self.debounce_seconds:
            return
        self.last_modified[str(filepath)] = now

        print(f"\n📝 检测到脚本变化: {filepath.name}")
        self.execute_in_blender(filepath)

    def execute_in_blender(self, script_path):
        """在 Blender 中执行脚本"""
        script_path = script_path.resolve()
        output_file = self.output_dir / f"{script_path.stem}_output.txt"

        print(f"🚀 正在 Blender 中执行: {script_path.name}")
        print(f"📄 输出保存到: {output_file}")

        try:
            # 后台执行 Blender
            result = subprocess.run(
                [
                    self.blender_path,
                    '--background',
                    '--python', str(script_path)
                ],
                capture_output=True,
                text=True,
                timeout=300  # 5分钟超时
            )

            # 保存输出
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write("=== STDOUT ===\n")
                f.write(result.stdout)
                f.write("\n=== STDERR ===\n")
                f.write(result.stderr)
                f.write(f"\n=== 退出码: {result.returncode} ===\n")

            # 打印输出
            if result.stdout:
                print(result.stdout)
            if result.stderr:
                print(f"⚠️  {result.stderr}")

            if result.returncode == 0:
                print(f"✅ 执行成功！")
            else:
                print(f"❌ 执行失败（退出码 {result.returncode}）")

        except subprocess.TimeoutExpired:
            print(f"⏰ 执行超时（>5分钟）")
        except Exception as e:
            print(f"❌ 执行出错: {e}")


def main():
    parser = argparse.ArgumentParser(description='Blender 文件监听自动执行器')
    parser.add_argument('--watch-dir', default='./blender_scripts',
                        help='监听目录（默认: ./blender_scripts）')
    parser.add_argument('--output-dir', default='./blender_output',
                        help='输出目录（默认: ./blender_output）')
    parser.add_argument('--blender-path', default='/Applications/Blender.app/Contents/MacOS/Blender',
                        help='Blender 可执行文件路径')
    parser.add_argument('--test', action='store_true',
                        help='测试模式：执行一次就退出')

    args = parser.parse_args()

    # 创建监听目录
    watch_dir = Path(args.watch_dir)
    watch_dir.mkdir(exist_ok=True)

    print("=" * 60)
    print("  Blender 文件监听自动执行器")
    print("=" * 60)
    print(f"📂 监听目录: {watch_dir.resolve()}")
    print(f"📂 输出目录: {Path(args.output_dir).resolve()}")
    print(f"🔧 Blender: {args.blender_path}")
    print(f"📝 测试模式: {'是' if args.test else '否'}")
    print("=" * 60)

    # 测试模式
    if args.test:
        handler = BlenderScriptHandler(args.blender_path, args.output_dir)

        # 查找目录下的 Python 脚本
        scripts = list(watch_dir.glob('*.py'))
        if scripts:
            print(f"\n找到 {len(scripts)} 个脚本，开始测试执行...")
            for script in scripts:
                handler.execute_in_blender(script)
                time.sleep(1)
        else:
            print(f"\n⚠️  在 {watch_dir} 中没有找到 Python 脚本")
            print(f"请将 .py 文件放到该目录，或使用 --test <script.py>")
        return

    # 监听模式
    observer = Observer()
    handler = BlenderScriptHandler(args.blender_path, args.output_dir)

    observer.schedule(handler, str(watch_dir), recursive=False)
    observer.start()

    print(f"\n👀 开始监听文件变化...")
    print(f"💡 提示：")
    print(f"   - 将 Python 脚本保存到 {watch_dir}")
    print(f"   - 保存后会自动在 Blender 中执行")
    print(f"   - 按 Ctrl+C 停止监听\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\n👋 停止监听")
        observer.stop()

    observer.join()


if __name__ == '__main__':
    main()
