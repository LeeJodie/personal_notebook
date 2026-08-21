#!/usr/bin/env bash
# First-time local deployment for macOS/Linux. It installs project runtimes,
# private services and the MeloTTS Chinese model, then starts the stack.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

need_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1，请先安装后重新执行 ./deploy.sh" >&2; exit 1; }
}

need_command node
need_command npm
need_command python3
need_command git
need_command curl

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  echo "需要 Node.js 22 或更高版本，当前为 $(node --version)。" >&2
  exit 1
fi

if ! python3 -m uv --version >/dev/null 2>&1; then
  echo "正在通过 pip 安装 uv（Python 环境管理器）…"
  python3 -m pip install --user uv
fi
UV=(python3 -m uv)

echo "[1/6] 安装前端依赖…"
npm ci

echo "[2/6] 安装 Crawl4AI 与 Chromium…"
"${UV[@]}" venv .venv-crawler --python 3.12
"${UV[@]}" pip install --python .venv-crawler/bin/python -r services/crawler/requirements.txt
CRAWL4_AI_BASE_DIRECTORY="$ROOT_DIR/.local/crawl4ai" .venv-crawler/bin/crawl4ai-setup

echo "[3/6] 安装文档解析服务…"
"${UV[@]}" venv .venv-document-processor --python 3.12
"${UV[@]}" pip install --python .venv-document-processor/bin/python -r services/document_processor/requirements.txt

if [ ! -f services/melotts/MeloTTS/setup.py ]; then
  echo "[4/6] 下载官方 MeloTTS 源码…"
  git clone --depth 1 https://github.com/myshell-ai/MeloTTS.git services/melotts/MeloTTS
else
  echo "[4/6] 已找到官方 MeloTTS 源码。"
fi

echo "[5/6] 安装 MeloTTS 与私有中文模型（首次下载约数百 MB）…"
"${UV[@]}" venv services/melotts/.venv --python 3.10
"${UV[@]}" pip install --python services/melotts/.venv/bin/python -r services/melotts/MeloTTS/requirements.txt fastapi 'uvicorn[standard]' soundfile edge-tts
"${UV[@]}" pip install --python services/melotts/.venv/bin/python -e services/melotts/MeloTTS --no-deps
MELOTTS_DEVICE="${MELOTTS_DEVICE:-cpu}" MELOTTS_DISABLE_BERT="${MELOTTS_DISABLE_BERT:-1}" services/melotts/.venv/bin/python services/melotts/download_model.py

echo "[6/6] 启动声阅…"
chmod +x start.sh restart.sh deploy.sh scripts/local-common.sh
exec ./start.sh
