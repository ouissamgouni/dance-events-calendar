#!/usr/bin/env bash
# Export OBJECT_STORAGE_* for a scenario, matching what `task start:scenario` does.
#
# Usage (after sourcing scenario_ports.sh so SC_* are set):
#   source .taskfiles/scenario_objects_env.sh <scenario-name> <repo-root>
#
# Precedence: scenario config.env > config/secrets.scenario.env > config/scenario.env.
# The MinIO endpoint is only forced when the provider is minio, so a scenario
# that sets OBJECT_STORAGE_PROVIDER=r2 keeps its real Cloudflare endpoint.

_soe_scenario="$1"
_soe_root="$2"

set -a
[ -f "${_soe_root}/config/scenario.env" ] && . "${_soe_root}/config/scenario.env"
[ -f "${_soe_root}/config/secrets.scenario.env" ] && . "${_soe_root}/config/secrets.scenario.env"
[ -f "${_soe_root}/scenarios/${_soe_scenario}/config.env" ] && . "${_soe_root}/scenarios/${_soe_scenario}/config.env"
set +a

export OBJECT_STORAGE_PROVIDER="${OBJECT_STORAGE_PROVIDER:-minio}"
export OBJECT_STORAGE_BUCKET_PUBLIC="${SC_BUCKET_PUBLIC}"
export OBJECT_STORAGE_BUCKET_PRIVATE="${SC_BUCKET_PRIVATE}"

if [ "$OBJECT_STORAGE_PROVIDER" = "minio" ]; then
  export OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:${SC_S3_PORT}"
  export OBJECT_STORAGE_ACCESS_KEY_ID="${OBJECT_STORAGE_ACCESS_KEY_ID:-minioadmin}"
  export OBJECT_STORAGE_SECRET_ACCESS_KEY="${OBJECT_STORAGE_SECRET_ACCESS_KEY:-minioadmin}"
else
  # r2-backed scenario: map the R2_* credentials from config/secrets.env.
  export OBJECT_STORAGE_ENDPOINT="${R2_ENDPOINT:-}"
  export OBJECT_STORAGE_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
  export OBJECT_STORAGE_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
fi

unset _soe_scenario _soe_root
