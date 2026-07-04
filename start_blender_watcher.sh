#!/bin/bash
# Blender 自动化启动脚本

echo "========================================"
echo "  Blender 自动化启动"
echo "========================================"

# 检查 Blender
BLENDER_PATH="/Applications/Blender.app/Contents/MacOS/Blender"
if [ ! -f "$BLENDER_PATH" ]; then
    echo "❌ 找不到 Blender: $BLENDER_PATH"
    exit 1
fi
echo "✅ Blender: $BLENDER_PATH"

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "❌ 找不到 python3"
    exit 1
fi
echo "✅ Python: $(which python3)"

# 安装依赖
echo ""
echo "📦 检查依赖..."
pip3 install watchdog --quiet --break-system-packages 2>/dev/null || pip3 install watchdog --user --quiet
if [ $? -eq 0 ]; then
    echo "✅ watchdog 已安装"
else
    echo "❌ watchdog 安装失败"
    exit 1
fi

# 启动监听器
echo ""
echo "🚀 启动 Blender 文件监听器..."
echo ""
python3 blender_watcher.py --watch-dir ./blender_scripts --output-dir ./blender_output
