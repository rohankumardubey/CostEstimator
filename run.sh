#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$ROOT_DIR/.venv"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_PID=""
FRONTEND_PID=""
CLEANED_UP=false

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.asdf/shims:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh"
fi

export PRICING_CONFIG_PATH="${PRICING_CONFIG_PATH:-$ROOT_DIR/config/pricing.yaml}"
export PRICING_SOURCE="${PRICING_SOURCE:-live}"
export LIVE_PRICING_BACKGROUND_REFRESH="${LIVE_PRICING_BACKGROUND_REFRESH:-true}"
export LIVE_PRICING_CACHE_SECONDS="${LIVE_PRICING_CACHE_SECONDS:-21600}"
export LIVE_PRICING_TIMEOUT_SECONDS="${LIVE_PRICING_TIMEOUT_SECONDS:-8}"

log() {
  printf '[cost-estimator] %s\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

port_in_use() {
  local port="$1"
  if command_exists lsof; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    return 1
  fi
}

free_port() {
  local port="$1"
  local label="$2"
  local pids

  if ! command_exists lsof; then
    return
  fi

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  log "Stopping stale $label process on port $port: $pids"
  kill $pids >/dev/null 2>&1 || true

  for _ in 1 2 3 4 5; do
    if ! port_in_use "$port"; then
      return
    fi
    sleep 0.2
  done

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "Force-stopping stale $label process on port $port: $pids"
    kill -9 $pids >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [[ "$CLEANED_UP" == "true" ]]; then
    return
  fi
  CLEANED_UP=true
  log "Stopping local services..."
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

free_port "$BACKEND_PORT" "backend"
free_port "$FRONTEND_PORT" "frontend"

if [[ ! -d "$VENV_DIR" ]]; then
  if command_exists python3; then
    log "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
  elif command_exists python; then
    log "Creating Python virtual environment..."
    python -m venv "$VENV_DIR"
  else
    log "Python is required but was not found."
    exit 1
  fi
fi

if [[ ! -f "$VENV_DIR/.deps-installed" || "$BACKEND_DIR/requirements.txt" -nt "$VENV_DIR/.deps-installed" ]]; then
  log "Installing backend dependencies..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"
  touch "$VENV_DIR/.deps-installed"
fi

if ! command_exists npm; then
  log "npm is required but was not found."
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" || "$FRONTEND_DIR/package-lock.json" -nt "$FRONTEND_DIR/node_modules" ]]; then
  log "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm install)
fi

log "Starting backend on http://127.0.0.1:$BACKEND_PORT"
(
  cd "$BACKEND_DIR"
  PYTHONPATH=. "$VENV_DIR/bin/python" -m uvicorn app.main:app --reload --host 127.0.0.1 --port "$BACKEND_PORT"
) &
BACKEND_PID="$!"

log "Starting frontend on http://127.0.0.1:$FRONTEND_PORT"
(
  cd "$FRONTEND_DIR"
  npm exec vite -- --host 127.0.0.1 --port "$FRONTEND_PORT"
) &
FRONTEND_PID="$!"

log "Ready."
log "Frontend: http://127.0.0.1:$FRONTEND_PORT"
log "Backend docs: http://127.0.0.1:$BACKEND_PORT/docs"
log "Press Ctrl+C to stop both services."

wait "$BACKEND_PID" "$FRONTEND_PID"
