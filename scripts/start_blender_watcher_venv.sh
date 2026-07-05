#!/bin/bash
# Blender 自动化启动脚本（虚拟环境版本）

echo "========================================"
echo "  Blender 自动化启动（虚拟环境）"
echo "========================================"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
BLENDER_PATH="/Applications/Blender.app/Contents/MacOS/Blender"

# 检查 Blender
if [ ! -f "$BLENDER_PATH" ]; then
    echo "❌ 找不到 Blender: $BLENDER_PATH"
    exit 1
fi
echo "✅ Blender: $BLENDER_PATH"

# 创建虚拟环境
if [ ! -d "$VENV_DIR" ]; then
    echo ""
    echo "📦 首次运行，创建虚拟环境..."
    python3 -m venv "$VENV_DIR"
    if [ $? -ne 0 ]; then
        echo "❌ 虚拟环境创建失败"
        exit 1
    fi
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"

# 安装依赖
echo "📦 检查依赖..."
pip install watchdog --quiet
if [ $? -ne 0 ]; then
    echo "❌ watchdog 安装失败"
    exit 1
fi
echo "✅ watchdog 已安装"

# 启动监听器
echo ""
echo "🚀 启动 Blender 文件监听器..."
echo ""
python3 blender_watcher.py --watch-dir ./blender_scripts --output-dir ./blender_output
