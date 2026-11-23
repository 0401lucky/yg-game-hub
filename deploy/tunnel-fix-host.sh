#!/usr/bin/env bash
set -e
TUNNEL_ID=442fc90f-429c-4f1d-b797-817966589e67
CRED=/home/ubuntu/.cloudflared/${TUNNEL_ID}.json
HOST=games.lucky0625.us.ci

echo '--- 绑定 DNS'
cloudflared --origincert /home/ubuntu/.cloudflared/cert.pem tunnel route dns yg-games "$HOST" 2>&1 | tail -2

echo '--- 更新配置'
cat > /etc/cloudflared-games/config.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED}
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:3007
  - service: http_status:404
EOF

systemctl restart cloudflared-games.service
sleep 6
systemctl is-active cloudflared-games.service
journalctl -u cloudflared-games.service -n 4 --no-pager | tail -4

echo '--- 本机回环自检'
curl -s -o /dev/null -w 'local %{http_code}\n' -H "Host: ${HOST}" http://127.0.0.1:3007/
