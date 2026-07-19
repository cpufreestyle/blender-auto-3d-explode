@echo off
chcp 65001 >nul
title Quest 3 3D 拆解工具

cd /d "%~dp0"

echo ========================================
echo   Quest 3 3D 拆解工具
echo ========================================
echo.

REM ---------- Node.js（必需）----------
where node >nul 2>&1
if %errorlevel%==0 (
  echo ✅ 已检测到 Node.js
) else (
  echo ⚠️ 未检测到 Node.js
  set /p "CHOICE=是否自动安装 Node.js? (Y/N，默认 N): "
  if /i "%CHOICE%"=="Y" (
    echo 正在通过 winget 安装 Node.js...
    winget install -e --id OpenJS.NodeJS
    if errorlevel 1 (
      echo ❌ winget 安装失败，请手动安装: https://nodejs.org/
      pause
      exit /b 1
    )
    REM 将新安装的 Node 加入当前会话 PATH
    set "PATH=%LOCALAPPDATA%\Programs\NodeJS;%ProgramFiles%\nodejs;%PATH%"
    where node >nul 2>&1
    if errorlevel 1 (
      echo 安装完成，请关闭此窗口并重新运行 start.bat 以使 PATH 生效。
      pause
      exit /b 0
    )
  ) else (
    echo ❌ 已取消安装 Node.js，无法继续。
    pause
    exit /b 1
  )
)

REM ---------- Blender（可选，AI 绘画/3D 生成需要）----------
where blender >nul 2>&1
if %errorlevel%==0 (
  echo ✅ 已检测到 Blender
) else (
  echo ⚠️ 未检测到 Blender（AI 绘画 / 3D 生成需要）
  set /p "CHOICE=是否自动安装 Blender? (Y/N，默认 N): "
  if /i "%CHOICE%"=="Y" (
    echo 正在通过 winget 安装 Blender...
    winget install -e --id Blender.Blender
    if errorlevel 1 (
      echo ⚠️ winget 安装失败，请手动安装: https://www.blender.org/download/
    )
  ) else (
    echo 跳过 Blender（AI 功能将不可用）。
  )
)

REM ---------- 安装 npm 依赖（首次运行）----------
if not exist "node_modules" (
  echo 📦 首次运行，安装依赖...
  call npm install
  echo.
)

REM ---------- 启动服务 ----------
echo 🚀 启动服务...
echo.
echo   服务地址:
echo     - 本地: http://localhost:3001
echo.
echo   按 Ctrl+C 停止服务
echo.

node server.js

REM ---------- 服务停止后保持窗口打开 ----------
echo.
pause
