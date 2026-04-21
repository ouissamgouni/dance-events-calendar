#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Scenario Port Allocation
#
# Sources deterministic ports for scenario instances.
# Usage: source .taskfiles/scenario_ports.sh "scenario_name"
#
# Base ports (from .env.scenario):
#   DB=5437  API=8003  WEB=3002
#
# Default scenario → offset 0 (ports 5437/8003/3002)
# Named scenarios  → hash-based offset from name
# Override         → PORT_OFFSET=N always wins
# ════════════════════════════════════════════════════════════════

SCENARIO_NAME="${1:-default}"
BASE_DB_PORT=5437
BASE_API_PORT=8003
BASE_WEB_PORT=3002

if [ "$SCENARIO_NAME" = "default" ] || [ -z "$SCENARIO_NAME" ]; then
  SC_PORT_OFFSET=0
  ENV_NAME="scenario"
  SC_PROJECT_NAME="movida-scenario"
  SC_DB_CONTAINER="calendar_db_scenario"
  SC_BACKEND_CONTAINER="calendar_backend_scenario"
  SC_FRONTEND_CONTAINER="calendar_frontend_scenario"
else
  # Deterministic hash-based offset (1–9999)
  if [ -n "$PORT_OFFSET" ]; then
    SC_PORT_OFFSET="$PORT_OFFSET"
  else
    SC_PORT_OFFSET=$(printf '%s' "$SCENARIO_NAME" | cksum | awk '{print ($1 % 9999) + 1}')
  fi
  ENV_NAME="scenario-${SCENARIO_NAME}"
  SC_PROJECT_NAME="movida-scenario-${SCENARIO_NAME}"
  SC_DB_CONTAINER="calendar_db_scenario-${SCENARIO_NAME}"
  SC_BACKEND_CONTAINER="calendar_backend_scenario-${SCENARIO_NAME}"
  SC_FRONTEND_CONTAINER="calendar_frontend_scenario-${SCENARIO_NAME}"
fi

SC_DB_PORT=$((BASE_DB_PORT + SC_PORT_OFFSET))
SC_API_PORT=$((BASE_API_PORT + SC_PORT_OFFSET))
SC_WEB_PORT=$((BASE_WEB_PORT + SC_PORT_OFFSET))
SC_DB_NAME="calendar_db_${ENV_NAME}"

export SC_PORT_OFFSET ENV_NAME SC_PROJECT_NAME
export SC_DB_PORT SC_API_PORT SC_WEB_PORT SC_DB_NAME
export SC_DB_CONTAINER SC_BACKEND_CONTAINER SC_FRONTEND_CONTAINER
export SCENARIO_NAME
