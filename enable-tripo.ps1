# Enable Tripo3D cloud image-to-3D in one click.
# Usage:
#   .\enable-tripo.ps1 -ApiKey "tsk_xxxxxxxx"
#   .\enable-tripo.ps1 -ApiKey "tsk_xxx" -Model "v3.1-20260211"
param(
  [Parameter(Mandatory = $true)][string]$ApiKey,
  [string]$Model = "v3.1-20260211",
  [string]$BlenderPath = "D:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cfgFile = Join-Path $root "ai-config.json"

# 1) Read or create config
if (Test-Path $cfgFile) {
  $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
} else {
  $cfg = [PSCustomObject]@{}
}
if (-not $cfg.providers) {
  $cfg | Add-Member -NotePropertyName providers -NotePropertyValue ([PSCustomObject]@{})
}
if (-not $cfg.providers.tripo) {
  $cfg.providers | Add-Member -NotePropertyName tripo -NotePropertyValue ([PSCustomObject]@{})
}
$cfg.providers.tripo | Add-Member -NotePropertyName apiKey -NotePropertyValue $ApiKey -Force
$cfg.providers.tripo | Add-Member -NotePropertyName model -NotePropertyValue $Model -Force
$cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgFile -Encoding UTF8
Write-Host "Tripo API Key written to ai-config.json (model=$Model)"

# 2) Stop old server.js
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*'
} | ForEach-Object { Write-Host "Stopping old server PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# 3) Restart with BLENDER_PATH + outbound proxy for cloud 3D APIs (Tripo/Meshy/Hyper3D)
$env:BLENDER_PATH = $BlenderPath
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$nodeOpts = "--require $root\proxy-bootstrap.cjs"
Start-Process -FilePath "node" -ArgumentList $nodeOpts, "server.js" -WorkingDirectory $root `
  -NoNewWindow -RedirectStandardOutput "server.log" -RedirectStandardError "server.err"
Start-Sleep -Seconds 4

# 4) Health check
try {
  $r = Invoke-WebRequest -Uri http://localhost:3001/api/health -UseBasicParsing
  Write-Host "Health: $($r.StatusCode) $($r.Content)"
} catch {
  Write-Host "Health check failed: $($_.Exception.Message)"
}
Write-Host ""
Write-Host "Open http://localhost:3001/ai-config.html to confirm Tripo is enabled."
Write-Host "Then go to homepage, upload an image, choose Tripo for image-to-3D, and generate."
