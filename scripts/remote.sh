#!/usr/bin/env bash
# Команда на сервере (задай DEPLOY_HOST=root@<ip>): ./scripts/remote.sh "pm2 logs --lines 20"
set -euo pipefail
HOST="${DEPLOY_HOST:-root@SERVER}"
DIR="${DEPLOY_DIR:-/root/roobet-feed}"
ssh "$HOST" "cd $DIR && $*"
