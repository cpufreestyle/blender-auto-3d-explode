#!/bin/bash
# 一键启动服务器脚本
# 用法: 在终端中运行 ./start_servers.sh

cd "$(dirname "$0")"

echo "═══════════════════════════════════════════"
echo "  🚀 启动 GLB 拆解服务器"
echo "═══════════════════════════════════════════"

# 杀掉旧进程
lsof -ti :3001 | xargs kill -9 2>/dev/null
lsof -ti :8080 | xargs kill -9 2>/dev/null
sleep 1

# 启动后端
echo "📦 启动后端服务 (端口 3001)..."
node server.js &
BACKEND_PID=$!
sleep 2

# 检查后端是否启动
if kill -0 $BACKEND_PID 2>/dev/null; then
    echo "✅ 后端服务已启动 (PID: $BACKEND_PID)"
    # 测试 health
    HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null)
    if [ -n "$HEALTH" ]; then
        echo "   健康检查: $HEALTH"
    fi
else
    echo "❌ 后端启动失败"
    exit 1
fi

# 启动前端
echo ""
echo "🌐 启动前端服务 (端口 8080)..."
npx -y serve . -l 8080 &
FRONTEND_PID=$!
sleep 3

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ 全部启动完成！"
echo ""
echo "  📋 前端:      http://localhost:8080"
echo "  🔧 后端API:   http://localhost:3001"
echo "  🧪 测试页面:  http://localhost:8080/test-blender-split.html"
echo ""
echo "  按 Ctrl+C 停止所有服务"
echo "═══════════════════════════════════════════"

# 等待
wait
