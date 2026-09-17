#!/usr/bin/env bash
# Перенос проекта на Raspberry через tar по ssh (rsync на macOS капризничает).
# .env и node_modules на Pi свои — их не трогаем.
set -euo pipefail

HOST="${DEPLOY_HOST:-pi@parser-pi.local}"
DIR="${DEPLOY_DIR:-roobet-feed}"

cd "$(dirname "$0")/.."

echo "→ $HOST:~/$DIR"
tar -czf - \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.env \
  --exclude='*.log' \
  . | ssh "$HOST" "mkdir -p ~/$DIR && tar -xzf - -C ~/$DIR"

echo "перенесено. дальше на Pi (первый раз):"
echo "  cd ~/$DIR && npm install && cp .env.example .env && nano .env"
echo "  npm run pi:start    # с основного ПК — поднять под pm2"
