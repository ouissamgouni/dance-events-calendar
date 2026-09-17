#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Scenario Port Allocation
#
# Sources deterministic ports for scenario instances.
# Usage: source .taskfiles/scenario_ports.sh "scenario_name"
#
# Base ports (from .env.scenario):
#   DB=5437  API=8003  WEB=3002  UMAMI=3101  S3=9100  S3_CONSOLE=9200
#
# Default scenario → offset 0 (ports 5437/8003/3002)
# Named scenarios  → hash-based offset from name
# "dev" scenario   → pinned legacy dev ports (see below)
# Override         → PORT_OFFSET=N always wins
# ════════════════════════════════════════════════════════════════

SCENARIO_NAME="${1:-default}"
BASE_DB_PORT=5437
BASE_API_PORT=8003
BASE_WEB_PORT=3002
BASE_UMAMI_PORT=3101
BASE_S3_PORT=9100
BASE_S3_CONSOLE_PORT=9200

if [ "$SCENARIO_NAME" = "dev" ]; then
  # The everyday dev environment is just a scenario, but its ports are pinned
  # rather than hash-derived: they are baked into vite.config.ts,
  # playwright.config.ts, config/test.env, CORS origins and CI. No single
  # PORT_OFFSET reproduces them, so they are set explicitly.
  SC_PORT_OFFSET=0
  ENV_NAME="dev"
  SC_PROJECT_NAME="movida-dev"
  SC_DB_CONTAINER="calendar_db_dev"
  SC_BACKEND_CONTAINER="calendar_backend_dev"
  SC_FRONTEND_CONTAINER="calendar_frontend_dev"
  SC_DB_PORT=5434
  SC_API_PORT=8000
  SC_WEB_PORT=5173
  SC_UMAMI_PORT=3100
  SC_S3_PORT=9000
  SC_S3_CONSOLE_PORT=9001
  SC_DB_NAME="calendar_db_dev"
elif [ "$SCENARIO_NAME" = "default" ] || [ -z "$SCENARIO_NAME" ]; then
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

if [ "$SCENARIO_NAME" != "dev" ]; then
  SC_DB_PORT=$((BASE_DB_PORT + SC_PORT_OFFSET))
  SC_API_PORT=$((BASE_API_PORT + SC_PORT_OFFSET))
  SC_WEB_PORT=$((BASE_WEB_PORT + SC_PORT_OFFSET))
  SC_UMAMI_PORT=$((BASE_UMAMI_PORT + SC_PORT_OFFSET))
  SC_S3_PORT=$((BASE_S3_PORT + SC_PORT_OFFSET))
  SC_S3_CONSOLE_PORT=$((BASE_S3_CONSOLE_PORT + SC_PORT_OFFSET))
  SC_DB_NAME="calendar_db_${ENV_NAME}"
fi
SC_UMAMI_PROJECT="${SC_PROJECT_NAME}-umami"
SC_OBJECTS_PROJECT="${SC_PROJECT_NAME}-objects"
# Buckets are per-scenario so parallel instances never share objects.
SC_BUCKET_PUBLIC="movida-${ENV_NAME}-public"
SC_BUCKET_PRIVATE="movida-${ENV_NAME}-private"

export SC_PORT_OFFSET ENV_NAME SC_PROJECT_NAME
export SC_DB_PORT SC_API_PORT SC_WEB_PORT SC_UMAMI_PORT SC_DB_NAME
export SC_DB_CONTAINER SC_BACKEND_CONTAINER SC_FRONTEND_CONTAINER
export SC_UMAMI_PROJECT SCENARIO_NAME
export SC_S3_PORT SC_S3_CONSOLE_PORT SC_OBJECTS_PROJECT
export SC_BUCKET_PUBLIC SC_BUCKET_PRIVATE
