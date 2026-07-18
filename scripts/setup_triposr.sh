#!/usr/bin/env bash
# 本地「单图转3D」真重建环境准备（TripoSR）
#
# 做四件事：
#   1. 克隆 TripoSR 仓库到 external/TripoSR
#   2. 创建独立 venv 并安装 PyTorch + TripoSR 依赖（含 torchmcubes 源码编译）
#   3. 预下载模型权重（首次推理也会自动下载，这里只是加速）
#   4. 提示 macOS 编译工具链
#
# 支持 macOS (MPS/CPU) 与 Linux (CPU)，纯离线推理（运行时无需任何云端 API）。
#
# 用法：
#   bash scripts/setup_triposr.sh
#   TRIPOSR_DIR=/path/to/TripoSR bash scripts/setup_triposr.sh
#
# 如遇 HuggingFace 访问慢，可设置镜像后重跑：
#   HF_ENDPOINT=https://hf-mirror.com bash scripts/setup_triposr.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 允许用兼容的 Python 创建 venv（系统默认可能是过新的 3.14，
# TripoSR/PyTorch/torchmcubes 不一定支持；优先 3.11）
PYTHON_BIN="${PYTHON_BIN:-python3}"
TRIPOSR_DIR="${TRIPOSR_DIR:-$REPO_ROOT/external/TripoSR}"
VENV="$TRIPOSR_DIR/.venv"

echo "==> TripoSR 目录: $TRIPOSR_DIR"

# 1. 克隆仓库（若未存在）
if [ ! -d "$TRIPOSR_DIR/.git" ]; then
  echo "==> 克隆 TripoSR 仓库..."
  git clone https://github.com/VAST-AI-Research/TripoSR.git "$TRIPOSR_DIR"
else
  echo "==> TripoSR 仓库已存在，跳过克隆"
fi

# 2. 创建 venv
if [ ! -x "$VENV/bin/python" ]; then
  echo "==> 创建虚拟环境 $VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "==> 升级 pip / setuptools"
pip install --upgrade pip setuptools

# 预装 numpy<2 与 cmake（TripoSR 生态固定依赖，避免拉到不兼容的最新版）
echo "==> 预装 numpy==1.26.4 / cmake"
pip install "numpy==1.26.4" cmake

# 3. 安装 PyTorch（固定 2.1.1，与 torchmcubes / transformers==4.35 兼容的经典组合）
if [ "$(uname)" = "Darwin" ]; then
  echo "==> 安装 PyTorch (macOS, MPS/CPU)..."
  pip install torch==2.1.1 torchvision==0.16.1
else
  echo "==> 安装 PyTorch (CPU)..."
  pip install torch==2.1.1 torchvision==0.16.1 --index-url https://download.pytorch.org/whl/cpu
fi

# 4. 安装 TripoSR 依赖（固定版本；torchmcubes 需从源码编译）
echo "==> 安装 TripoSR 依赖 (requirements.txt，跳过 gradio 演示 UI)..."
# gradio 仅用于 TripoSR 自带 demo Web UI；本项目的 server.js 走 triposr_infer.py
# 直接推理，完全不需要 gradio。去掉它可避免 pip 在 gradio 依赖树上长时间 backtracking。
grep -vE '^(gradio|gradio-client)' "$TRIPOSR_DIR/requirements.txt" > /tmp/triposr_reqs_nogradio.txt

# 兼容性修正：
#  - 新 cmake(>=4) 与 xatlas/pybind11 的 cmake_minimum_required 不兼容，需放宽策略版本。
#  - numpy 钉在 <2，避免 numpy2 与 transformers==4.35 / trimesh==4.0.5 冲突。
export CMAKE_POLICY_VERSION_MINIMUM=3.5
pip install "numpy<2" -r /tmp/triposr_reqs_nogradio.txt

# 5. 编译工具链提示（torchmcubes 需要 C++ 编译器）
if [ "$(uname)" = "Darwin" ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "!! 注意：torchmcubes 需要 Xcode Command Line Tools，请先运行：xcode-select --install"
  fi
elif [ "$(uname)" = "Linux" ]; then
  if ! command -v gcc >/dev/null 2>&1; then
    echo "!! 注意：torchmcubes 需要 gcc/g++，请先安装（如 apt install build-essential）"
  fi
fi

# 6. 预下载模型权重（可选；首次推理会自动重试）
echo "==> 预下载 TripoSR 权重 (stabilityai/TripoSR)..."
python - <<'PY'
try:
    from huggingface_hub import snapshot_download
    snapshot_download("stabilityai/TripoSR")
    print("==> 权重预下载完成")
except Exception as e:
    print("WARN: 权重预下载失败（首次推理会自动重试）: " + str(e))
PY

echo ""
echo "✅ 本地真重建环境就绪。"
echo "   server.js 的本地图片转3D 现在走 TripoSR 真重建（有体积/背面）。"
echo "   前端「图片转3D」选择「本地 TripoSR（真重建）」即可使用。"
