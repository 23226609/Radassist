#!/usr/bin/env bash
# start-all-agents.sh — load the four com.radassist launchd agents.
#
# This is the way back after stop-all.sh. launchd starts each service
# (RunAtLoad) and restarts it if it exits (KeepAlive).
#
# start-all.sh is a different path: it starts the same four ports itself,
# with nohup, and does not talk to launchd. Do not run both. Two copies
# would fight over the ports.
#
# Usage:  bash start-all-agents.sh

set -u

UID_NUM="$(id -u)"
# 25 Nov 2026: Muse moved the 4 .plist files here from ~/Library/LaunchAgents
# to stop CURV auto-starting on every login/restart. Bootstrap loads them
# from this backup folder, so start-all-agents.sh still brings them back.
AGENTS_DIR="$HOME/Library/LaunchAgents-disabled"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { printf "${GREEN}[start-agents]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[start-agents]${NC} %s\n" "$*"; }

say "Loading launchd agents ..."
for label in com.radassist.mlxvlm com.radassist.middleware com.radassist.nodebackend com.radassist.frontend; do
  plist="$AGENTS_DIR/$label.plist"
  if [ ! -f "$plist" ]; then
    warn "missing $plist"
    continue
  fi
  if launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null; then
    say "loaded $label"
  else
    warn "$label did not load (it may already be loaded)"
  fi
done

# The CURV model takes a while to load into memory before it binds :8080.
say "Waiting for the ports ..."
wait_port() {
  local port=$1 secs=$2
  local i
  for ((i = 0; i < secs; i++)); do
    if lsof -ti:"$port" >/dev/null 2>&1; then
      say ":$port is up"
      return 0
    fi
    sleep 1
  done
  warn ":$port did not come up within ${secs}s"
  return 1
}

fail=0
wait_port 8080 90 || fail=1
wait_port 8001 30 || fail=1
wait_port 5002 30 || fail=1
wait_port 5173 30 || fail=1

echo ""
say "launchctl:"
launchctl list 2>/dev/null | grep 'com\.radassist\.' || warn "no com.radassist job is listed"

if [ "$fail" -eq 0 ]; then say "All four ports are up."; else warn "At least one port did not come up."; exit 1; fi
