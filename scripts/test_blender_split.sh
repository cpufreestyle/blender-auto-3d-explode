#!/bin/bash
# 测试脚本 - 检查 Blender、启动服务器、测试拆解
# 结果全部写入 /tmp/test_results.txt

RESULT_FILE="/tmp/test_results.txt"
echo "========== 测试开始 $(date) ==========" > "$RESULT_FILE"

# 1. 检查 Blender
echo "" >> "$RESULT_FILE"
echo "===== 1. 检查 Blender =====" >> "$RESULT_FILE"
BLENDER=""
if [ -f "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
    BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"
    echo "Blender 路径: $BLENDER" >> "$RESULT_FILE"
    "$BLENDER" --version >> "$RESULT_FILE" 2>&1
else
    echo "Blender NOT FOUND at default location" >> "$RESULT_FILE"
    # 尝试 PATH
    which blender >> "$RESULT_FILE" 2>&1 && BLENDER="blender" || echo "blender not in PATH either" >> "$RESULT_FILE"
fi
echo "BLENDER=$BLENDER" >> "$RESULT_FILE"

# 2. 检查 Node.js
echo "" >> "$RESULT_FILE"
echo "===== 2. 检查 Node.js =====" >> "$RESULT_FILE"
node --version >> "$RESULT_FILE" 2>&1
echo "Node path: $(which node)" >> "$RESULT_FILE" 2>&1

# 3. 检查测试模型
echo "" >> "$RESULT_FILE"
echo "===== 3. 检查测试模型 =====" >> "$RESULT_FILE"
ls -la /Users/a1-6/quest3-exploded/models/Quest3.glb >> "$RESULT_FILE" 2>&1

# 4. 杀掉可能在运行的服务器
echo "" >> "$RESULT_FILE"
echo "===== 4. 清理旧进程 =====" >> "$RESULT_FILE"
lsof -ti :3001 | xargs kill -9 2>/dev/null
echo "Port 3001 cleared" >> "$RESULT_FILE"

# 5. 启动服务器
echo "" >> "$RESULT_FILE"
echo "===== 5. 启动服务器 =====" >> "$RESULT_FILE"
cd /Users/a1-6/quest3-exploded
node server.js >> "$RESULT_FILE" 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID" >> "$RESULT_FILE"
sleep 3

# 6. 测试 health 端点
echo "" >> "$RESULT_FILE"
echo "===== 6. 测试 /api/health =====" >> "$RESULT_FILE"
curl -s http://localhost:3001/api/health >> "$RESULT_FILE" 2>&1
echo "" >> "$RESULT_FILE"

# 7. 测试 split 端点（如果有 Blender）
echo "" >> "$RESULT_FILE"
echo "===== 7. 测试 /api/split =====" >> "$RESULT_FILE"
if [ -n "$BLENDER" ]; then
    echo "开始拆解测试..." >> "$RESULT_FILE"
    CURL_OUTPUT=$(curl -s -X POST http://localhost:3001/api/split \
        -F "file=@/Users/a1-6/quest3-exploded/models/Quest3.glb" \
        --max-time 120 2>&1)
    
    # 提取关键字段（不输出 base64）
    echo "$CURL_OUTPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(f'success: {data.get(\"success\")}')
    print(f'total_parts: {data.get(\"total_parts\")}')
    print(f'elapsed: {data.get(\"elapsed_seconds\")}s')
    print(f'model_center: {data.get(\"model_center\")}')
    print(f'model_size: {data.get(\"model_size\")}')
    parts = data.get('parts', [])
    for i, p in enumerate(parts[:10]):
        print(f'  Part {i+1}: {p.get(\"display_name\")} | center={p.get(\"center\")} | faces={p.get(\"face_count\")}')
    if len(parts) > 10:
        print(f'  ... and {len(parts)-10} more parts')
    glb_size = len(data.get('glb_base64', ''))
    print(f'GLB base64 size: {glb_size} chars (~{glb_size*3//4//1024} KB)')
except Exception as e:
    print(f'JSON parse error: {e}')
    print(f'Raw output (first 500 chars): {sys.stdin.read()[:500]}')
" >> "$RESULT_FILE" 2>&1
    echo "Split test done" >> "$RESULT_FILE"
else
    echo "Blender 不可用，跳过 split 测试" >> "$RESULT_FILE"
    echo "但前端会自动回退到 JS 拆解" >> "$RESULT_FILE"
fi

# 8. 关闭服务器
echo "" >> "$RESULT_FILE"
echo "===== 8. 清理 =====" >> "$RESULT_FILE"
kill $SERVER_PID 2>/dev/null
echo "Server stopped" >> "$RESULT_FILE"

echo "" >> "$RESULT_FILE"
echo "========== 测试完成 $(date) ==========" >> "$RESULT_FILE"
