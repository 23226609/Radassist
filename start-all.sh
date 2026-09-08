#!/bin/bash
# Start the whole RadAssist stack and leave it running after this shell exits.
#
#   mlx_vlm.server  :8080   the CURV AI model
#   middleware.py   :8001   image -> AI -> report  (served from this repo)
#   backend/server  :5002   Express API + MongoDB
#   vite            :5173   frontend
#
# Logs land in .logs/.  Stop everything with ./stop-all.sh

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
mkdir -p .logs

export PATH="/Users/PHY/Library/Python/3.12/bin:/usr/local/bin:$PATH"
PY="/usr/local/bin/python3.12"

# Wait for an HTTP endpoint to answer, up to $2 seconds.
wait_for() {
  local url=$1 secs=$2 name=$3
  for ((i = 0; i < secs; i++)); do
    if curl -s -m 2 -o /dev/null "$url"; then
      echo "  $name ready"
      return 0
    fi
    sleep 1
  done
  echo "  $name did NOT come up - check .logs/"
  return 1
}

# Free a port before rebinding it. Targeting the port rather than pkill'ing a
# name pattern avoids killing unrelated processes that happen to match.
free_port() {
  local pids
  pids=$(lsof -ti:"$1" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null
    sleep 1
  fi
}

echo "Starting RadAssist stack..."

# 1. AI model. Skip if something is already serving :8080 (it takes ~20s to load).
if curl -s -m 2 -o /dev/null http://localhost:8080/v1/models; then
  echo "  mlx_vlm already running on :8080"
else
  # The subshell detaches each service from this script's process group so it
  # survives the terminal that launched it.
  (nohup mlx_vlm.server --model ~/CURV-mlx --port 8080 > .logs/mlx_vlm.log 2>&1 &)
  wait_for http://localhost:8080/v1/models 90 "mlx_vlm  :8080"
fi

# 2. FastAPI middleware, from this repo so the AI prompt stays version controlled.
free_port 8001
(nohup "$PY" -m uvicorn middleware:app --port 8001 --host 0.0.0.0 > .logs/middleware.log 2>&1 &)
wait_for http://localhost:8001/health 30 "middleware :8001"

# 3. Express backend.
free_port 5002
(cd backend && nohup node server.js > ../.logs/backend.log 2>&1 &)
wait_for http://localhost:5002/api/health 30 "backend  :5002"

# 4. Frontend dev server.
free_port 5173
(nohup npx vite --port 5173 > .logs/vite.log 2>&1 &)
wait_for http://localhost:5173 30 "frontend :5173"

echo ""
echo "Open http://localhost:5173"
