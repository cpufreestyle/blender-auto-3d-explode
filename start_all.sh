#!/bin/bash
cd /Users/a1-6/quest3-exploded

# Kill old
lsof -ti :3001 | xargs kill -9 2>/dev/null
lsof -ti :8080 | xargs kill -9 2>/dev/null
sleep 1

# Start backend
node server.js > /Users/a1-6/quest3-exploded/backend.log 2>&1 &
sleep 3

# Start frontend
npx -y serve . -l 8080 > /Users/a1-6/quest3-exploded/frontend.log 2>&1 &
sleep 4

# Check
echo "=== STATUS ===" > /Users/a1-6/quest3-exploded/status.txt
curl -s http://localhost:3001/api/health >> /Users/a1-6/quest3-exploded/status.txt 2>&1
echo "" >> /Users/a1-6/quest3-exploded/status.txt
echo "FRONTEND: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/ 2>&1)" >> /Users/a1-6/quest3-exploded/status.txt
echo "=== DONE ===" >> /Users/a1-6/quest3-exploded/status.txt
