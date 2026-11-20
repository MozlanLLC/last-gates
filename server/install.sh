#!/usr/bin/env bash
# Установка игрового сервера «Последние Врата» на чистую Ubuntu 22.04/24.04.
# Запуск:  curl -fsSL https://raw.githubusercontent.com/MozlanLLC/last-gates/main/server/install.sh | sudo bash
# Свой домен:  ... | sudo DOMAIN=api.example.uz bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }

REPO=https://github.com/MozlanLLC/last-gates.git
APP=/opt/last-gates
DATA=/var/lib/last-gates

echo "== Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git nginx certbot python3-certbot-nginx ca-certificates

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "== Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

if [ -z "${DOMAIN:-}" ]; then
  IP=$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
echo "== Адрес сервера: $DOMAIN"

echo "== Код игры"
id lastgates >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin lastgates
mkdir -p "$DATA" && chown lastgates:lastgates "$DATA"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone --depth 1 "$REPO" "$APP"; fi

echo "== Служба"
cat > /etc/systemd/system/last-gates.service <<EOF
[Unit]
Description=Last Gates game server
After=network.target

[Service]
User=lastgates
Environment=PORT=8080 HOST=127.0.0.1 DATA_DIR=$DATA
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $APP/server/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now last-gates
systemctl restart last-gates

echo "== Nginx"
cat > /etc/nginx/sites-available/last-gates <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 1m;
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
  }
  location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_read_timeout 120s;
  }
  location / { return 200 "Last Gates server\n"; add_header Content-Type text/plain; }
}
EOF
ln -sf /etc/nginx/sites-available/last-gates /etc/nginx/sites-enabled/last-gates
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "== Сертификат HTTPS"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || {
  echo "!! Сертификат не получен. Проверьте, что в группе безопасности открыты порты 80 и 443, и запустите скрипт ещё раз."; exit 1; }

echo "== Ежедневная копия базы"
cat > /etc/cron.daily/last-gates-backup <<EOF
#!/bin/sh
mkdir -p $DATA/backup
sqlite_file=$DATA/lastgates.sqlite
[ -f \$sqlite_file ] && cp \$sqlite_file $DATA/backup/lastgates-\$(date +%F).sqlite
find $DATA/backup -name '*.sqlite' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/last-gates-backup

sleep 1
if curl -fsS "https://$DOMAIN/api/health" >/dev/null; then
  echo ""
  echo "ГОТОВО. Сервер работает: https://$DOMAIN/api/health"
else
  echo "!! Сервер не ответил. Журнал: journalctl -u last-gates -n 50"
fi
