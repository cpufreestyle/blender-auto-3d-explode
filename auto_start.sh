#!/bin/bash
# 自动启动脚本 - 在独立 Terminal.app 中运行
cd /Users/a1-6/quest3-exploded

LOG="/Users/a1-6/quest3-exploded/startup_log.txt"
echo "=== 启动时间: $(date) ===" > "$LOG"

# 杀旧进程
echo "清理旧进程..." >> "$LOG"
lsof -ti :3001 | xargs kill -9 2>/dev/null
lsof -ti :8080 | xargs kill -9 2>/dev/null
sleep 1
echo "旧进程已清理" >> "$LOG"

# 启动后端
echo "启动后端 (port 3001)..." >> "$LOG"
node /Users/a1-6/quest3-exploded/server.js >> "$LOG" 2>&1 &
BACKEND_PID=$!
echo "后端 PID: $BACKEND_PID" >> "$LOG"
sleep 3

# 检查后端
if kill -0 $BACKEND_PID 2>/dev/null; then
    echo "后端运行中" >> "$LOG"
    HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null)
    echo "健康检查: $HEALTH" >> "$LOG"
else
    echo "后端启动失败!" >> "$LOG"
fi

# 启动前端
echo "启动前端 (port 8080)..." >> "$LOG"
npx -y serve /Users/a1-6/quest3-exploded -l 8080 >> "$LOG" 2>&1 &
FRONTEND_PID=$!
echo "前端 PID: $FRONTEND_PID" >> "$LOG"
sleep 4

# 检查前端
if kill -0 $FRONTEND_PID 2>/dev/null; then
    echo "前端运行中" >> "$LOG"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ 2>/dev/null)
    echo "前端 HTTP 状态: $HTTP_CODE" >> "$LOG"
else
    echo "前端启动失败!" >> "$LOG"
fi

echo "" >> "$LOG"
echo "=============================" >> "$LOG"
echo "  服务地址:" >> "$LOG"
echo "  前端: http://localhost:8080" >> "$LOG"
echo "  后端: http://localhost:3001" >> "$LOG"
echo "  测试: http://localhost:8080/test-blender-split.html" >> "$LOG"
echo "=============================" >> "$LOG"
echo "=== 启动完成: $(date) ===" >> "$LOG"

# 自动打开浏览器
open "http://localhost:8080/test-blender-split.html"

# 保持运行
wait
