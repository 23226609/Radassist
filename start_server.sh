#!/bin/bash

# Stop any stale processes from a previous run
pkill -f "mlx_vlm.server" 2>/dev/null
pkill -f "uvicorn middleware:app" 2>/dev/null
sleep 1

# Force the python that ships with mlx_vlm (3.12)
export PATH="/Users/PHY/Library/Python/3.12/bin:/usr/local/bin:$PATH"
PY="/usr/local/bin/python3.12"

echo "Starting CURV AI Service..."

# Launch AI core engine (runs in background)
mlx_vlm.server --model ~/CURV-mlx --port 8080 &
MLX_PID=$!

# Wait for the model to load
echo " Waiting for AI Model to load (20s)..."
sleep 20

# Launch FastAPI middleware (runs in background).
# Serve middleware.py from this repo so the AI prompt stays version controlled.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$PY" -m uvicorn middleware:app --port 8001 --host 0.0.0.0 &
UV_PID=$!

echo " All services started successfully!"
echo "   AI Server:  http://localhost:8080  (PID $MLX_PID)"
echo " Middleware:  http://localhost:8001  (PID $UV_PID)"
echo "  Health:    http://localhost:8001/health"
echo ""
echo "Press Ctrl+C to stop all services."

# Trap Ctrl+C to clean up child processes
trap "echo 'Stopping...'; kill $MLX_PID $UV_PID 2>/dev/null; exit" INT TERM

# Keep script running
wait