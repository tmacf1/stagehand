#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVER_HOST="${AUTOMATION_RUNNER_SERVER_HOST:-0.0.0.0}"
SERVER_PORT="${AUTOMATION_RUNNER_SERVER_PORT:-8788}"
HEALTHCHECK_HOST="${AUTOMATION_RUNNER_HEALTHCHECK_HOST:-127.0.0.1}"

RUNTIME_DIR="$SCRIPT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/automation_runner_server.pid"
LOG_FILE="$RUNTIME_DIR/automation_runner_server.log"

mkdir -p "$RUNTIME_DIR"

is_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  if [[ -z "$pid" ]]; then
    return 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  rm -f "$PID_FILE"
  return 1
}

healthcheck() {
  curl -fsS "http://${HEALTHCHECK_HOST}:${SERVER_PORT}/health" >/dev/null 2>&1
}

healthcheck_with_retry() {
  for _ in $(seq 1 3); do
    if healthcheck; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

print_status() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    if healthcheck_with_retry; then
      echo "running"
      echo "pid: $pid"
      echo "url: http://${HEALTHCHECK_HOST}:${SERVER_PORT}"
      echo "log: $LOG_FILE"
    else
      echo "starting"
      echo "pid: $pid"
      echo "url: http://${HEALTHCHECK_HOST}:${SERVER_PORT}"
      echo "log: $LOG_FILE"
    fi
  else
    echo "stopped"
    echo "url: http://${HEALTHCHECK_HOST}:${SERVER_PORT}"
    echo "log: $LOG_FILE"
  fi
}

start_server() {
  if is_running; then
    echo "Automation API server is already running."
    print_status
    return 0
  fi

  : >"$LOG_FILE"
  local pid
  pid="$(
    python3 - "$SCRIPT_DIR" "$LOG_FILE" "$PID_FILE" "$SERVER_HOST" "$SERVER_PORT" <<'PY'
import os
import subprocess
import sys

script_dir, log_file, pid_file, server_host, server_port = sys.argv[1:]
env = os.environ.copy()
env["AUTOMATION_RUNNER_SERVER_HOST"] = server_host
env["AUTOMATION_RUNNER_SERVER_PORT"] = server_port

with open(log_file, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        [
            "pnpm",
            "--filter",
            "@browserbasehq/stagehand",
            "run",
            "example",
            "--",
            "automation_runner_server",
        ],
        cwd=script_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )

with open(pid_file, "w", encoding="utf-8") as handle:
    handle.write(f"{proc.pid}\n")

print(proc.pid)
PY
  )"

  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Automation API server failed to start."
      echo "Recent logs:"
      tail -n 40 "$LOG_FILE" || true
      rm -f "$PID_FILE"
      return 1
    fi

    if healthcheck_with_retry; then
      echo "Automation API server started in background."
      print_status
      return 0
    fi

    sleep 1
  done

  echo "Automation API server did not become healthy in time."
  echo "Recent logs:"
  tail -n 40 "$LOG_FILE" || true
  return 1
}

stop_server() {
  if ! is_running; then
    echo "Automation API server is not running."
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true

  for _ in $(seq 1 15); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Automation API server stopped."
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Automation API server force-stopped."
}

restart_server() {
  stop_server
  start_server
}

show_usage() {
  cat <<'EOF'
Usage:
  ./start_auto_server.sh [start|status|stop|restart]

Commands:
  start    Start the automation API server in the background (default)
  status   Show current status
  stop     Stop the background server
  restart  Restart the background server

Files:
  PID  -> ./.runtime/automation_runner_server.pid
  LOG  -> ./.runtime/automation_runner_server.log
EOF
}

COMMAND="${1:-start}"

case "$COMMAND" in
  start)
    start_server
    ;;
  status)
    print_status
    ;;
  stop)
    stop_server
    ;;
  restart)
    restart_server
    ;;
  help|-h|--help)
    show_usage
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    show_usage >&2
    exit 1
    ;;
esac
