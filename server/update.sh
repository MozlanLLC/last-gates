#!/usr/bin/env bash
# Обновление сервера:  sudo bash /opt/last-gates/server/update.sh
# Сначала пробуем GitHub, при недоступности — зеркало jsDelivr.
set -uo pipefail
APP=/opt/last-gates
if timeout 25 git -C "$APP" pull --ff-only; then
  echo "Обновлено из GitHub"
else
  echo "GitHub недоступен, качаю через зеркало jsDelivr…"
  curl -fsS --max-time 20 "https://purge.jsdelivr.net/gh/MozlanLLC/last-gates@main/server/server.js" >/dev/null || true
  sleep 2
  TMP=$(mktemp)
  if curl -fsSL --max-time 60 "https://cdn.jsdelivr.net/gh/MozlanLLC/last-gates@main/server/server.js" -o "$TMP" && node --check "$TMP"; then
    install -m 644 "$TMP" "$APP/server/server.js"; echo "Обновлено через зеркало"
  else
    echo "!! Не удалось скачать обновление"; rm -f "$TMP"; exit 1
  fi
  rm -f "$TMP"
fi
systemctl restart last-gates
sleep 1
systemctl --no-pager --lines=3 status last-gates
