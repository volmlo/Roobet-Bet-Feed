#!/usr/bin/env bash
# Выполнить команду на Pi: ./scripts/remote.sh "pm2 logs --lines 20"
set -euo pipefail
HOST="${DEPLOY_HOST:-pi@parser-pi.local}"
DIR="${DEPLOY_DIR:-~/roobet-feed}"
ssh "$HOST" "cd $DIR && $*"
