# 一键启用 Blender 全部功能（Windows）
#
# 启动：
#   .\start-blender-all.ps1
# 重启（先停掉旧的 server.js 与 Blender 宿主，再拉起）：
#   .\start-blender-all.ps1 -Restart
#
# 说明：
#   1) server.js  —— Web/API 编排层：AI 绘画、GLB 拆解、本地 TripoSR 图片转3D、云端 Tripo/Meshy/Rodin。
#   2) Blender MCP 常驻宿主（scripts/blender_mcp_addon.py，GUI 模式）
#        —— 必须用 GUI 模式：addon 的 start() 会拒绝 --background，因为后台模式下命令无法在主线程执行。
#           它监听 127.0.0.1:9876，提供装配分析 / 拆解顺序 / 场景图 / 多视角捕获 / Hunyuan3D·Rodin 图片转3D 等 MCP 工具。
#   3) 预装的 Tripo3D、Rodin 插件随 Blender 启动自动加载（a_Rodin 退出时的 AttributeError: utils.watcher 是已知无害问题）。
#
# 注意事项：
#   - addon 仅绑定 IPv4（127.0.0.1），故 BLENDERMCP_HOST 强制用 127.0.0.1，避免 localhost 解析到 IPv6(::1) 的误连。
#   - Blender 安装路径非标准，必须显式设置 BLENDER_PATH。

param(
  [string]$BlenderPath = "D:\Program Files\Blender Foundation\Blender 5.2\blender.exe",
  [string]$McpHost = "127.0.0.1",
  [int]$McpPort = 9876,
  [int]$ServerPort = 3001,
  [switch]$Restart
)

$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot

function Is-Listening($port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue)
}

if (-not (Test-Path $BlenderPath)) {
  Write-Host "✗ 找不到 Blender：$BlenderPath"
  Write-Host "  请修改脚本顶部的 BlenderPath 参数，或用 -BlenderPath 传入。"
  exit 1
}

if ($Restart) {
  Write-Host "Restart: 停止旧的 server.js 与 Blender 宿主 ..."
  Get-Process blender -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*'
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
}

# 1) server.js（代理由 server.js 自身自动探测，无需 --require proxy-bootstrap.cjs）
$env:BLENDER_PATH = $BlenderPath
$env:BLENDERMCP_HOST = $McpHost
$env:BLENDERMCP_PORT = [string]$McpPort

$nodeArgs = @("server.js")
if (-not (Is-Listening $ServerPort)) {
  Write-Host "启动 server.js (port $ServerPort) ..."
  Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $root `
    -NoNewWindow -RedirectStandardOutput "server.log" -RedirectStandardError "server.err"
} else {
  Write-Host "server.js 已在运行 (port $ServerPort)"
}

# 2) Blender MCP 常驻宿主（GUI 模式）
if (-not (Is-Listening $McpPort)) {
  Write-Host "启动 Blender MCP 宿主 (port $McpPort) ..."
  Start-Process -FilePath $BlenderPath -ArgumentList "--python", "scripts/blender_mcp_addon.py" -WorkingDirectory $root
} else {
  Write-Host "Blender MCP 宿主已在监听 (port $McpPort)"
}

# 3) 等待并验证
Start-Sleep -Seconds 15
$ok = $true

if (-not (Is-Listening $ServerPort)) { Write-Host "✗ server.js 未监听 $ServerPort"; $ok = $false }
else { Write-Host "✓ server.js 监听 $ServerPort" }

if (-not (Is-Listening $McpPort)) { Write-Host "✗ Blender MCP 宿主未监听 $McpPort"; $ok = $false }
else { Write-Host "✓ Blender MCP 宿主监听 $McpPort" }

try {
  $h = Invoke-WebRequest -Uri "http://localhost:$ServerPort/api/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "✓ health: $($h.Content)"
} catch {
  Write-Host "✗ health 检查失败: $($_.Exception.Message)"; $ok = $false
}

try {
  $a = Invoke-WebRequest -Uri "http://localhost:$ServerPort/api/assembly/analysis?tolerance=0.001" -UseBasicParsing -TimeoutSec 40
  $j = $a.Content | ConvertFrom-Json
  if ($j.success -and -not $j.error) { Write-Host "✓ 装配分析可用 (part_count=$($j.part_count))" }
  else { Write-Host "⚠ 装配分析返回异常: $($a.Content)"; $ok = $false }
} catch {
  Write-Host "✗ 装配分析失败: $($_.Exception.Message)"; $ok = $false
}

if ($ok) {
  Write-Host "`n✅ Blender 全部功能已启用 —— 打开 http://localhost:$ServerPort"
} else {
  Write-Host "`n⚠ 部分功能未就绪，请查看上方输出或 server.err"
}
