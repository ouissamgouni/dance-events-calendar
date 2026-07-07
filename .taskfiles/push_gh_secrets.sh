#!/usr/bin/env bash
# Push variables from a dotenv-style file (KEY=VALUE per line) to GitHub
# Actions secrets via `gh secret set`. Called by `task secrets:push` —
# see .taskfiles/secrets.yml for the parameter reference.
#
# Usage: push_gh_secrets.sh <file> [secret-name] [gh-env] [prefix]
#   file         path to a dotenv-style secrets file (required)
#   secret-name  only push this one variable (default: push every var in file)
#   gh-env       GitHub Environment to scope the secret(s) to (default: repo-level)
#   prefix       string prepended to each GitHub secret name (default: none)
#
# Values are read with `grep`/`cut`, never `source`d: some values (e.g. Neon
# DATABASE_URLs like "...?sslmode=require&channel_binding=require") contain
# shell metacharacters such as `&` that `source` misinterprets as shell syntax
# (silently truncating the assignment), and sourcing arbitrary secret values
# is a command-injection risk if one ever contains `$()`/backticks.

set -euo pipefail

FILE="${1:-}"
ONLY_SECRET="${2:-}"
GH_ENV="${3:-}"
PREFIX="${4:-}"

if [ -z "$FILE" ]; then
  echo "Usage: push_gh_secrets.sh <file> [secret-name] [gh-env] [prefix]" >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "error: $FILE not found" >&2
  exit 1
fi

if ! command -v gh &>/dev/null; then
  echo "error: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi

get_value() {
  grep -m1 "^$1=" "$FILE" | cut -d '=' -f2-
}

# Names of KEY=VALUE assignments in the file. Comments and blank lines are
# never matched since they don't start with a letter/underscore.
KEYS="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$FILE" | sed 's/=$//')"

if [ -n "$ONLY_SECRET" ]; then
  if ! printf '%s\n' "$KEYS" | grep -qx "$ONLY_SECRET"; then
    echo "error: $ONLY_SECRET not found in $FILE" >&2
    exit 1
  fi
  KEYS="$ONLY_SECRET"
fi

ENV_ARGS=()
[ -n "$GH_ENV" ] && ENV_ARGS=(--env "$GH_ENV")

echo "$KEYS" | while IFS= read -r key; do
  [ -z "$key" ] && continue
  value="$(get_value "$key")"
  if [ -z "$value" ]; then
    echo "skipping $key (empty value in $FILE)"
    continue
  fi
  gh_name="${PREFIX}${key}"
  echo "Setting $gh_name${GH_ENV:+ (env: $GH_ENV)}..."
  gh secret set "$gh_name" "${ENV_ARGS[@]}" --body "$value"
done

echo "Done."
