#!/usr/bin/env bash
# Run the CrewBrief stack locally with auto-reload.
#
#   ./scripts/dev.sh            # 4 Python services + web app (crew + supervisor) on :3000
#
# Logs are prefixed with the service name. Ctrl-C (or any process exiting) stops
# everything. Configuration comes from .env (+ .env.local), read by the services.
set -euo pipefail

cd "$(dirname "$0")/.."
VENV="${VENV:-.venv}"
PY="$VENV/bin/python"
HOST="${DEV_HOST:-127.0.0.1}"

if [[ ! -x "$PY" ]]; then
  echo "No virtualenv at $VENV. Run 'make setup' first." >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo ".env is missing. Copy it from .env.example." >&2
  exit 1
fi

# Stop every child when this script exits for any reason.
trap 'trap - INT TERM EXIT; echo; echo "stopping..."; kill 0 2>/dev/null; wait 2>/dev/null' INT TERM EXIT

colors=(36 35 33 32 34 31)
n=0
run() {
  local name="$1"; shift
  local color="${colors[$((n % ${#colors[@]}))]}"; n=$((n + 1))
  local prefix
  prefix=$(printf '\033[%sm%-13s|\033[0m ' "$color" "$name")
  ( "$@" 2>&1 | sed -u "s/^/$prefix/" ) &
}

service() {
  local name="$1" module="$2" port="$3"
  run "$name" "$PY" -m uvicorn "services.${module}.app:app" --host "$HOST" --port "$port" \
    --reload --reload-dir services --reload-dir packages --reload-dir knowledge
}

service roles roles 8003
service form-api form_api 8001
service orchestrator orchestrator 8002
service gateway gateway 8000

if [[ -f apps/review-portal/package.json ]]; then
  run review-portal npm --prefix apps/review-portal run dev -- --port 3000 --strictPort
else
  echo "apps/review-portal not found; skipping the portal"
fi

echo "CrewBrief dev stack: gateway :8000  form-api :8001  orchestrator :8002  roles :8003  portal :3000"
echo "Press Ctrl-C to stop."
# Exit (and stop the rest) as soon as any process ends.
wait -n
