#!/bin/bash
cd "$(dirname "$0")/../.."

# Kill old
lsof -ti :3001 | xargs kill -9 2>/dev/null
lsof -ti :8080 | xargs kill -9 2>/dev/null
sleep 1

# Detect Blender
BLENDER=""
for path in \
  "/Applications/Blender.app/Contents/MacOS/Blender" \
  "/usr/bin/blender" \
  "/usr/local/bin/blender" \
  "/snap/bin/blender"; do
  if [ -f "$path" ]; then
    BLENDER="$path"
    break
  fi
done
[ -z "$BLENDER" ] && command -v blender &>/dev/null && BLENDER="blender"
[ -n "$BLENDER" ] && export BLENDER_PATH="$BLENDER"

# Start backend
node server.js > backend.log 2>&1 &
sleep 3

# Start frontend
npx -y serve . -l 8080 > frontend.log 2>&1 &
sleep 4

# Check
echo "=== STATUS ===" > status.txt
curl -s http://localhost:3001/api/health >> status.txt 2>&1
echo "" >> status.txt
echo "FRONTEND: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/ 2>&1)" >> status.txt
echo "=== DONE ===" >> status.txt

cat status.txt
