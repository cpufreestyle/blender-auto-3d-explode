# Windows 版 TripoSR 本地真重建环境准备（替代 macOS/Linux 的 setup_triposr.sh）
# 后台运行：创建 venv + 安装 PyTorch(CPU) + 依赖 + 编译 torchmcubes + 预下载权重。
$ErrorActionPreference = "Continue"
$root = "C:\Users\michael\CodeBuddy\20260827161745"
$tsr  = Join-Path $root "external\TripoSR"
$venv = Join-Path $tsr ".venv"
$py   = Join-Path $venv "Scripts\python.exe"
$log  = Join-Path $root "setup_triposr.log"
$proxy = "http://127.0.0.1:7897"

$env:HTTPS_PROXY = $proxy
$env:HTTP_PROXY  = $proxy
$env:HF_ENDPOINT = "https://hf-mirror.com"

function log($m) { "$m" | Out-File $log -Append; Write-Host $m }

"=== TripoSR setup start $(Get-Date) ===" | Out-File $log -Append

if (-not (Test-Path $py)) {
  log ">>> creating venv at $venv"
  & python -m venv $venv 2>&1 | ForEach-Object { $_ | Out-File $log -Append }
} else {
  log ">>> venv already exists"
}

log ">>> upgrade pip/setuptools"
& $py -m pip install --upgrade pip setuptools 2>&1 | ForEach-Object { $_ | Out-File $log -Append }

log ">>> install numpy==1.26.4 cmake"
& $py -m pip install "numpy==1.26.4" cmake 2>&1 | ForEach-Object { $_ | Out-File $log -Append }

$env:CMAKE_POLICY_VERSION_MINIMUM = "3.5"
log ">>> install torch 2.1.1 (CPU) -- this is the big download"
& $py -m pip install torch==2.1.1 torchvision==0.16.1 --index-url https://download.pytorch.org/whl/cpu 2>&1 | ForEach-Object { $_ | Out-File $log -Append }

$reqRaw  = Join-Path $tsr "requirements.txt"
$reqClean = Join-Path $tsr "requirements_nogradio.txt"
(Get-Content $reqRaw) | Where-Object { $_ -notmatch '^(gradio|gradio-client)' } | Set-Content $reqClean
log ">>> install TripoSR deps (gradio excluded); torchmcubes will compile"
& $py -m pip install "numpy<2" -r $reqClean 2>&1 | ForEach-Object { $_ | Out-File $log -Append }

log ">>> pre-download TripoSR weights (stabilityai/TripoSR)"
& $py -c "from huggingface_hub import snapshot_download; snapshot_download('stabilityai/TripoSR'); print('WEIGHTS_OK')" 2>&1 | ForEach-Object { $_ | Out-File $log -Append }

log "=== TripoSR setup DONE $(Get-Date) ==="
