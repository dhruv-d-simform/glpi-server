#!/usr/bin/env bash
#
# run-glpi-agent.sh — send ONE inventory to the local glpi-server POC.
#
# Runs the already-installed GLPI Agent in a fully isolated, one-shot mode:
#   * no sudo / no elevated permissions
#   * does NOT read the system config (/etc/glpi-agent) — uses --config none
#   * does NOT touch the system service, state, or logs
#   * keeps ALL its working files inside this folder (./.agent-state)
#
# Anyone can: clone this repo -> `npm install` -> `npm start` (in one terminal)
# -> `./run-glpi-agent.sh` (in another) -> see JSON appear in ./db/
#
set -euo pipefail

# Always work relative to this script's folder, regardless of where it's called.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where the POC server listens (override with: SERVER_URL=... ./run-glpi-agent.sh)
SERVER_URL="${SERVER_URL:-http://localhost:8080/}"

# Isolated agent working directory (state/storage) — kept inside this repo.
STATE_DIR="$HERE/.agent-state"
mkdir -p "$STATE_DIR"

# Locate the agent binary (installed package or on PATH).
AGENT_BIN="$(command -v glpi-agent || true)"
if [[ -z "$AGENT_BIN" ]]; then
  echo "ERROR: 'glpi-agent' not found on PATH. Install the GLPI Agent first." >&2
  exit 1
fi

echo "Sending inventory to: $SERVER_URL"
echo "Agent state dir:      $STATE_DIR"
echo

# Flags explained:
#   --config none      ignore /etc/glpi-agent entirely (never touch dev setup)
#   --vardir           keep agent state inside this repo (no ~/ or /var clutter)
#   --logger stderr    log to this terminal (no /var/log writes)
#   --no-compression   send plain JSON so the server needs no inflate step
#   --server           push to our POC server (triggers the JSON protocol)
#   --force            ignore scheduling; send every time we run this script
#                      (--lazy is intentionally omitted — it would do the opposite)
#   --full-inventory-postpone=0
#                      always send a FULL inventory. By default (14) the agent
#                      strips unchanged sections and flags the upload
#                      "partial": true; 0 disables that so every run is complete.
exec "$AGENT_BIN" \
  --config none \
  --vardir "$STATE_DIR" \
  --logger stderr \
  --no-compression \
  --server "$SERVER_URL" \
  --force \
  --full-inventory-postpone=0 \
  "$@"
