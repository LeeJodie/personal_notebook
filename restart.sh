#!/usr/bin/env bash
# Restart only processes created by start.sh/deploy.sh (tracked via PID files).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/local-common.sh
source "$ROOT_DIR/scripts/local-common.sh"

stop_service web "npm --prefix"
stop_service tts "services/melotts"
stop_service processor "services/document_processor"
stop_service crawler "services/crawler"

exec "$ROOT_DIR/start.sh"
