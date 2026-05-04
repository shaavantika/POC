#!/usr/bin/env bash
# Run the scheduler API from the repository root. Loads .env if present.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi
export PYTHONPATH=.
PORT="${PORT:-8007}"
exec python -m uvicorn src.api.main:app --host 0.0.0.0 --port "$PORT"
