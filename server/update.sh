#!/usr/bin/env bash
# Обновление сервера до последней версии из GitHub:  sudo bash /opt/last-gates/server/update.sh
set -euo pipefail
git -C /opt/last-gates pull --ff-only
systemctl restart last-gates
sleep 1
systemctl --no-pager --lines=5 status last-gates
