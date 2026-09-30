#!/usr/bin/env bash
# Резервный перенос проекта через tar по ssh (основной путь теперь — git pull на сервере).
# .env и node_modules на сервере свои — их не трогаем. Задай DEPLOY_HOST=root@<ip>.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@SERVER}"
DIR="${DEPLOY_DIR:-roobet-feed}"

cd "$(dirname "$0")/.."

echo "→ $HOST:~/$DIR"
tar -czf - \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.env \
  --exclude='*.log' \
  . | ssh "$HOST" "mkdir -p ~/$DIR && tar -xzf - -C ~/$DIR"

echo "перенесено. дальше на сервере (первый раз):"
echo "  cd ~/$DIR && npm install && cp .env.example .env && nano .env"
echo "  npm run pi:start    # с основного ПК — поднять под pm2"
