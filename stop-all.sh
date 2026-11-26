#!/usr/bin/env bash
# stop-all.sh — stop the RadAssist stack and leave it stopped.
# Usage:  bash stop-all.sh
#
# The four com.radassist launchd agents have KeepAlive, so killing the
# process alone makes launchd start it again. Unload the agents first.
# They are not loaded again here. Run start-all-agents.sh to bring them back.
# The .plist files are left where they are.
#
# Then:
#   1. Kill by PIDs file (precise, avoids collateral damage).
#   2. Kill by per-service .pid files written next to each log.
#   3. Kill anything still on :5173 / :5002 / :8001 / :8080.
#   4. Kill by process pattern as a fallback.
#   5. Last-resort sweep by basename.

set -u

PROJECT_ROOT="/Users/PHY/Downloads/radassist-ai-frontend"
LOG_DIR="$PROJECT_ROOT/.logs"
PIDS_FILE="$PROJECT_ROOT/.logs/pids"
UID_NUM="$(id -u)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { printf "${GREEN}[stop-all]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[stop-all]${NC} %s\n" "$*"; }

say "Unloading launchd agents so KeepAlive cannot restart them ..."
for label in com.radassist.mlxvlm com.radassist.middleware com.radassist.nodebackend com.radassist.frontend; do
  if launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null; then
    say "unloaded $label"
  else
    warn "$label was not loaded (bootout returned nothing to unload)"
  fi
done

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
say "Verification"
fail=0

for p in 5173 5002 8001 8080; do
  if lsof -ti:"$p" >/dev/null 2>&1; then warn ":$p still BUSY"; fail=1; else say ":$p free"; fi
done

leftover=$(pgrep -fl "mlx_vlm.server|uvicorn middleware:app|node.*server\.js|vite" 2>/dev/null || true)
if [ -n "$leftover" ]; then
  warn "processes still running:"
  printf '%s\n' "$leftover"
  fail=1
else
  say "no mlx_vlm.server, uvicorn middleware, node server.js or vite process"
fi

agents=$(launchctl list 2>/dev/null | grep 'com\.radassist\.' || true)
if [ -n "$agents" ]; then
  warn "launchd still has com.radassist jobs:"
  printf '%s\n' "$agents"
  fail=1
else
  say "launchctl list has no com.radassist job"
fi

if [ "$fail" -eq 0 ]; then say "Stopped. Nothing will restart until start-all-agents.sh."; else warn "Stop finished, but something is still up. See the lines above."; fi
