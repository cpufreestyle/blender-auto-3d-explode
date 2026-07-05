#!/bin/bash
# 双击运行或在终端执行: open 启动服务.command
cd /Users/a1-6/quest3-exploded

echo "═══════════════════════════════════════════"
echo "  🚀 启动 GLB 拆解服务"
echo "═══════════════════════════════════════════"
echo ""

# 清理旧进程
echo "🧹 清理旧进程..."
lsof -ti :3001 | xargs kill -9 2>/dev/null
lsof -ti :8080 | xargs kill -9 2>/dev/null
sleep 1

# 启动后端
echo "📦 启动后端服务 (端口 3001)..."
node server.js &
sleep 3

# 检查后端
echo "🔧 检查后端..."
HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null)
if [ -n "$HEALTH" ]; then
    echo "✅ 后端就绪: $HEALTH"
else
    echo "⚠️ 后端可能未就绪，继续启动前端..."
fi
echo ""

# 启动前端
echo "🌐 启动前端服务 (端口 8080)..."
npx -y serve . -l 8080 &
sleep 4

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ 全部启动完成！"
echo ""
echo "  📋 前端:      http://localhost:8080"
echo "  🔧 后端API:   http://localhost:3001"
echo "  🧪 测试页面:  http://localhost:8080/test-blender-split.html"
echo "  📖 主应用:    http://localhost:8080/index.html"
echo ""
echo "  按 Ctrl+C 停止所有服务"
echo "═══════════════════════════════════════════"
echo ""

# 自动打开浏览器
open "http://localhost:8080/test-blender-split.html"

# 保持运行
wait
