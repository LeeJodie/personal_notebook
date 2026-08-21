#!/usr/bin/env bash
# Start the web app and every private local dependency.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/local-common.sh
source "$ROOT_DIR/scripts/local-common.sh"

require_file "$ROOT_DIR/node_modules" "./deploy.sh"
require_file "$ROOT_DIR/.venv-crawler/bin/python" "./deploy.sh"
require_file "$ROOT_DIR/.venv-document-processor/bin/python" "./deploy.sh"
require_file "$ROOT_DIR/services/melotts/.venv/bin/python" "./deploy.sh"
require_file "$ROOT_DIR/services/melotts/MeloTTS/setup.py" "./deploy.sh"

start_service crawler "services/crawler" \
  env CRAWL4_AI_BASE_DIRECTORY="$RUNTIME_DIR/crawl4ai" \
  "$ROOT_DIR/.venv-crawler/bin/python" -m uvicorn main:app --app-dir "$ROOT_DIR/services/crawler" --host 127.0.0.1 --port 8780
start_service processor "services/document_processor" \
  "$ROOT_DIR/.venv-document-processor/bin/python" -m uvicorn main:app --app-dir "$ROOT_DIR/services/document_processor" --host 127.0.0.1 --port 8765
start_service tts "services/melotts" \
  env MELOTTS_DEVICE="${MELOTTS_DEVICE:-cpu}" MELOTTS_DISABLE_BERT="${MELOTTS_DISABLE_BERT:-1}" \
  "$ROOT_DIR/services/melotts/.venv/bin/python" -m uvicorn server:app --app-dir "$ROOT_DIR/services/melotts" --host 127.0.0.1 --port 9876
start_service web "npm --prefix" \
  npm --prefix "$ROOT_DIR" run dev -- --host 0.0.0.0 --port 3000

wait_for_http "http://127.0.0.1:8780/healthz" 30 || { echo "Crawler 未在 30 秒内就绪，请查看 $(log_file crawler)" >&2; exit 1; }
wait_for_http "http://127.0.0.1:8765/healthz" 30 || { echo "文档解析服务未在 30 秒内就绪，请查看 $(log_file processor)" >&2; exit 1; }
wait_for_http "http://127.0.0.1:3000" 30 || { echo "Web 服务未在 30 秒内就绪，请查看 $(log_file web)" >&2; exit 1; }

echo
echo "声阅已启动： http://localhost:3000"
echo "私有服务仅绑定在 127.0.0.1；MeloTTS 模型加载可能仍需少量时间。"
echo "查看日志： tail -f $LOG_DIR/{web,crawler,processor,tts}.log"
