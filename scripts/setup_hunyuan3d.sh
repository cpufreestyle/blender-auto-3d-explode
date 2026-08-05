#!/usr/bin/env bash
# 本地「文本转3D」环境准备（腾讯开源 Hunyuan3D-2，免费文生3D，无需云端 Key）
#
# 自动检测 GPU 并安装匹配的 PyTorch + hy3dgen：
#   - NVIDIA GPU (Linux/Windows) → CUDA 版 PyTorch（text-to-3D 真正可用）
#   - Apple Silicon (macOS arm64) → MPS 版 PyTorch（⚠️ text-to-3D 在 MPS 上不可用，仅装好环境）
#   - 其它 / 无 GPU              → CPU 版 PyTorch（⚠️ text-to-3D 跑不动，仅装好环境）
#
# 用法：
#   bash scripts/setup_hunyuan3d.sh
#   HUNYUAN3D_DIR=/path/to/dir bash scripts/setup_hunyuan3d.sh
#   HF_ENDPOINT=https://hf-mirror.com bash scripts/setup_hunyuan3d.sh   # 国内拉权重加速
#
# 装好后：前端「文生3D」选「🖥️ 本地 Hunyuan3D-2」，或 server 端 mode=local 即零成本文生3D。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
HUNYUAN3D_DIR="${HUNYUAN3D_DIR:-$REPO_ROOT/external/Hunyuan3D-2}"
VENV="$HUNYUAN3D_DIR/.venv"

echo "==> Hunyuan3D-2 目录: $HUNYUAN3D_DIR"

# ---- 1. 检测 GPU 类型 ----
detect_gpu() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    echo "nvidia"
  elif [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    echo "apple"
  else
    echo "none"
  fi
}

GPU="$(detect_gpu)"
echo "==> 检测到 GPU 类型: $GPU"

# ---- 2. 创建 venv（建在 external/Hunyuan3D-2/.venv，对上 server.js 的 venv 探测）----
mkdir -p "$HUNYUAN3D_DIR"
if [ ! -x "$VENV/bin/python" ]; then
  echo "==> 创建虚拟环境 $VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "==> 升级 pip / setuptools"
pip install --upgrade pip setuptools wheel

# ---- 3. 按 GPU 安装匹配的 PyTorch ----
case "$GPU" in
  nvidia)
    echo "==> 安装 PyTorch (CUDA 12.1，text-to-3D 可用)..."
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
    ;;
  apple)
    echo "==> 安装 PyTorch (macOS MPS)..."
    pip install torch torchvision
    ;;
  *)
    echo "==> 安装 PyTorch (CPU)..."
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
    ;;
esac

# ---- 4. 安装 Hunyuan3D-2 官方生成包（会拉取模型权重依赖）----
echo "==> 安装 hy3dgen (Hunyuan3D-2)..."
pip install "numpy<2" hy3dgen

# CUDA 下补 xformers（Hunyuan3D-2 注意力加速，可选）
if [ "$GPU" = "nvidia" ]; then
  echo "==> 安装 xformers（CUDA 加速，可选）..."
  pip install xformers || echo "WARN: xformers 安装失败（不影响基础功能）"
fi

# ---- 5. 预下载模型权重（首次推理也会自动下载，这里加速）----
echo "==> 预下载 Hunyuan3D-2 权重 (tencent/Hunyuan3D-2)..."
python - <<'PY'
try:
    from huggingface_hub import snapshot_download
    snapshot_download("tencent/Hunyuan3D-2")
    print("==> 权重预下载完成")
except Exception as e:
    print("WARN: 权重预下载失败（首次推理会自动重试）: " + str(e))
PY

echo ""
if [ "$GPU" = "nvidia" ]; then
  echo "✅ 本地文生3D 环境就绪（CUDA）。前端「文生3D」选「🖥️ 本地 Hunyuan3D-2」即可零成本生成。"
else
  echo "⚠️  环境已装好，但当前为 $GPU（无 CUDA）。Hunyuan3D-2 的 text-to-3D 需要 NVIDIA GPU，"
  echo "    本机无法直接生成。请在有 NVIDIA 显卡的机器上重跑本脚本，或改用「🌐文生3D」云端（需 Hyper3D Key）。"
fi
echo "    venv 位置: $VENV/bin/python3"
