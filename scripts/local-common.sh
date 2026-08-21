#!/usr/bin/env bash
# Shared process helpers for local, all-in-one ShengYue deployments.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.local"
PID_DIR="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"

mkdir -p "$PID_DIR" "$LOG_DIR" "$RUNTIME_DIR/crawl4ai"

pid_file() { printf '%s/%s.pid' "$PID_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

service_is_running() {
  local name="$1"
  local signature="$2"
  local file pid command
  file="$(pid_file "$name")"
  [ -f "$file" ] || return 1
  pid="$(cat "$file")"
  kill -0 "$pid" 2>/dev/null || { rm -f "$file"; return 1; }
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$signature"* ]] || { rm -f "$file"; return 1; }
}

start_service() {
  local name="$1"
  local signature="$2"
  shift 2
  if service_is_running "$name" "$signature"; then
    printf '✓ %-10s 已运行（PID %s）\n' "$name" "$(cat "$(pid_file "$name")")"
    return 0
  fi
  nohup "$@" >>"$(log_file "$name")" 2>&1 &
  echo "$!" >"$(pid_file "$name")"
  printf '→ %-10s 正在启动（日志：%s）\n' "$name" "$(log_file "$name")"
}

stop_service() {
  local name="$1"
  local signature="$2"
  local file pid
  file="$(pid_file "$name")"
  if ! service_is_running "$name" "$signature"; then
    rm -f "$file"
    return 0
  fi
  pid="$(cat "$file")"
  kill "$pid"
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
  printf '✓ %-10s 已停止\n' "$name"
}

wait_for_http() {
  local url="$1"
  local seconds="$2"
  local i
  for i in $(seq 1 "$seconds"); do
    curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

require_file() {
  local target="$1"
  local instruction="$2"
  if [ ! -e "$target" ]; then
    printf '缺少 %s。请先执行：%s\n' "$target" "$instruction" >&2
    exit 1
  fi
}
