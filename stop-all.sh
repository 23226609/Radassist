#!/usr/bin/env bash
# stop-all.sh — kill every service that start-all.sh brings up.
# Usage:  bash stop-all.sh
#
# Strategy:
#   1. Kill by PIDs file (precise, avoids collateral damage).
#   2. Kill by per-service .pid files written next to each log (extra safety).
#   3. Kill anything still on :5173 / :5002 / :8001 / :8080.
#   4. Kill by process pattern as a fallback.
#   5. Optionally reload the launchd agents we silenced at start.

set -u

PROJECT_ROOT="/Users/PHY/Downloads/radassist-ai-frontend"
LOG_DIR="$PROJECT_ROOT/.logs"
PIDS_FILE="$PROJECT_ROOT/.logs/pids"

# Colors for output
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { printf "${GREEN}[stop-all]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[stop-all]${NC} %s\n" "$*"; }

say "Stopping RadAssist stack on :5173 / :5002 / :8001 / :8080 ..."

# 1. PIDs file — processes start-all.sh launched in this session.
if [ -f "$PIDS_FILE" ]; then
  while read -r pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null && say "killed PID $pid (from PIDs file)"
    fi
  done < "$PIDS_FILE"
  rm -f "$PIDS_FILE"
fi

# 2. Per-service .pid files (defensive — even if PIDs file is stale).
for name in mlx_vlm middleware backend vite; do
  pf="$LOG_DIR/$name.pid"
  [ -f "$pf" ] || continue
  pid=$(cat "$pf" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null && say "killed PID $pid (from $name.pid)"
  fi
  rm -f "$pf"
done

# 3. By port — frees ports even if PIDs file is stale.
for p in 5173 5002 8001 8080; do
  PIDS=$(lsof -ti:$p 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill -9 2>/dev/null && say "freed :$p (killed $PIDS)"
  fi
done

# 4. By process pattern — catches watchers / children that aren't port-bound.
pkill -9 -f "mlx_vlm.server"                     2>/dev/null || true
pkill -9 -f "uvicorn middleware:app"             2>/dev/null || true
pkill -9 -f "start_server.sh"                    2>/dev/null || true
pkill -9 -f "start-all.sh"                       2>/dev/null || true
pkill -9 -f "node.*server.js"                    2>/dev/null || true
pkill -9 -f "backend/node_modules/.bin/nodemon"  2>/dev/null || true
pkill -9 -f "vite"                               2>/dev/null || true
pkill -9 -f "esbuild"                            2>/dev/null || true

sleep 2

# 5. Last-resort sweep by basename.
for name in mlx_vlm uvicorn node esbuild; do
  pgrep -f "$name" 2>/dev/null | while read -r pid; do
    kill -9 "$pid" 2>/dev/null || true
  done
done
sleep 1

echo ""
for p in 5173 5002 8001 8080; do
  if lsof -i:$p >/dev/null 2>&1; then warn "$p: still BUSY"; else say "$p: free"; fi
done

# 6. Re-enable the launchd agents so the services stay up between sessions.
UID_NUM="$(id -u)"
say "Re-loading launchd agents ..."
launchctl bootstrap "gui/$UID_NUM/com.radassist.mlxvlm"     "/Users/PHY/Library/LaunchAgents/com.radassist.mlxvlm.plist"     2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM/com.radassist.middleware"  "/Users/PHY/Library/LaunchAgents/com.radassist.middleware.plist"  2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM/com.radassist.nodebackend" "/Users/PHY/Library/LaunchAgents/com.radassist.nodebackend.plist" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM/com.radassist.frontend"    "/Users/PHY/Library/LaunchAgents/com.radassist.frontend.plist"    2>/dev/null || true

say "Done."
