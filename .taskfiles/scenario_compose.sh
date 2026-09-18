#!/usr/bin/env bash
# Compose wiring for a scenario: every service of an environment lives in ONE
# compose project ($SC_PROJECT_NAME), so Docker Desktop groups db + object
# storage + analytics together instead of showing three unrelated stacks.
#
# Usage (after sourcing scenario_ports.sh so SC_* are set):
#   source .taskfiles/scenario_compose.sh <repo-root>
#   docker compose -p $SC_PROJECT_NAME up -d postgres
#
# COMPOSE_FILE lists every file at once: compose then knows about all services
# in the project and never reports the others as orphan containers.

_sc_root="$1"

COMPOSE_FILE="${_sc_root}/infra/docker/docker-compose.db.yml"
COMPOSE_FILE="$COMPOSE_FILE:${_sc_root}/infra/docker/docker-compose.objects.yml"
COMPOSE_FILE="$COMPOSE_FILE:${_sc_root}/infra/docker/docker-compose.umami.yml"
export COMPOSE_FILE

# Placeholders so `docker compose` can interpolate every file even when a task
# only cares about one of them (stop tasks load no dotenv, for instance).
: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_PASSWORD:=postgres}"
: "${POSTGRES_DB:=${SC_DB_NAME:-postgres}}"
export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

# Containers carry pinned names, so ones left over from the old per-service
# compose projects would collide with `up`. Data lives in externally-named
# volumes and is untouched by removing the container.
sc_compose_adopt_containers() {
  local container project
  for container in "calendar_db_${ENV_NAME}" "minio_${ENV_NAME}" "umami_${ENV_NAME}" "umami_db_${ENV_NAME}"; do
    project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container" 2>/dev/null || true)
    if [ -n "$project" ] && [ "$project" != "$SC_PROJECT_NAME" ]; then
      echo "↪️  Adopting $container into compose project $SC_PROJECT_NAME (data volume kept)"
      docker rm -f "$container" >/dev/null 2>&1 || true
    fi
  done
}

unset _sc_root
