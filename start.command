#!/bin/bash

# Quest 3 3D 拆解工具启动脚本（macOS）
# 双击此文件即可启动；会自动检测并（在您确认后）安装所需软件。

cd "$(dirname "$0")"

echo "========================================"
echo "  Quest 3 3D 拆解工具"
echo "========================================"
echo ""

# 交互提示：返回 0=确认(yes)，1=取消。
# 当以非交互方式运行（无 tty，例如被脚本调用）时默认视为 yes，
# 保证无人值守启动时也能完成环境准备。
prompt_yes() {
  local msg="$1"
  if [ ! -t 0 ]; then return 0; fi
  read -p "$msg (y/N) " -n 1 -r; echo
  [[ $REPLY =~ ^[Yy]$ ]]
}

# 确保 Homebrew 可用（macOS 包管理器），缺失则提示安装。
ensure_brew() {
  if command -v brew &>/dev/null; then
    return 0
  fi
  echo "⚠️ 未检测到 Homebrew（macOS 包管理器）。"
  if prompt_yes "是否自动安装 Homebrew？"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  else
    return 1
  fi
  command -v brew &>/dev/null
}

# 检测并在确认后安装一个软件。
# $1=显示名  $2=检测命令  $3=brew 包(--cask 前缀表示 GUI 应用)  $4=是否必需(0/1)
ensure_tool() {
  local name="$1" test="$2" pkg="$3" required="$4"
  if eval "$test" &>/dev/null; then
    echo "✅ 已检测到 $name"
    return 0
  fi
  echo "⚠️ 未检测到 $name"
  if [ "$required" = "1" ]; then
    echo "   $name 是运行本工具所必需的。"
  fi
  if ! prompt_yes "是否自动安装 $name？"; then
    if [ "$required" = "1" ]; then
      echo "❌ 已取消安装 $name，无法继续。请手动安装后重试。"
      exit 1
    fi
    echo "   跳过 $name（部分功能可能不可用）。"
    return 1
  fi
  if [[ "$pkg" == --cask* ]]; then
    ensure_brew || { echo "无法安装 Homebrew，跳过 $name。"; [ "$required" = "1" ] && exit 1 || return 1; }
    brew install --cask "${pkg#--cask }"
  else
    ensure_brew || { echo "无法安装 Homebrew，跳过 $name。"; [ "$required" = "1" ] && exit 1 || return 1; }
    brew install "$pkg"
  fi
  # 安装后重新检测
  if eval "$test" &>/dev/null; then
    echo "✅ $name 安装成功"
  elif [ "$required" = "1" ]; then
    echo "⚠️ $name 安装后仍未在 PATH 中检测到，请关闭终端重开后重试。"
    exit 1
  else
    echo "⚠️ $name 安装后仍未在 PATH 中检测到，可能需要重开终端。"
    return 1
  fi
}

# 1. Node.js（必需）—— 运行 server.js 的基础
ensure_tool "Node.js" "command -v node" "node" 1

# 2. Blender（可选）—— AI 绘画 / 3D 生成需要
ensure_tool "Blender" "[ -d /Applications/Blender.app ] || command -v blender" "--cask blender" 0

# 3. 安装 npm 依赖（首次运行）
if [ ! -d "node_modules" ]; then
  echo "📦 首次运行，安装依赖..."
  npm install
  echo ""
fi

# 4. 启动服务
echo "🚀 启动服务..."
echo ""
echo "  服务地址:"
echo "    - 本地: http://localhost:3001"
echo "    - 网络: http://$(ifconfig | grep "inet " | grep -v 127.0.0.1 | head -1 | awk '{print $2}'):3001"
echo ""
echo "  按 Ctrl+C 停止服务"
echo ""

node server.js

# 服务停止后保持窗口打开
echo ""
read -p "服务已停止，按回车键退出..."
