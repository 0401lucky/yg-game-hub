#!/usr/bin/env bash
set -e
TUNNEL_ID=442fc90f-429c-4f1d-b797-817966589e67
CRED=/home/ubuntu/.cloudflared/${TUNNEL_ID}.json
HOST=games.204152.xyz

echo '--- 绑定 DNS'
cloudflared --origincert /home/ubuntu/.cloudflared/cert.pem tunnel route dns yg-games "$HOST" 2>&1 | tail -3

echo '--- 写配置'
mkdir -p /etc/cloudflared-games
cat > /etc/cloudflared-games/config.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED}
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:3007
  - service: http_status:404
EOF
chmod 644 /etc/cloudflared-games/config.yml

echo '--- 写 systemd unit'
cat > /etc/systemd/system/cloudflared-games.service <<'EOF'
[Unit]
Description=cloudflared tunnel yg-games (游戏大厅)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --config /etc/cloudflared-games/config.yml --no-autoupdate run
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cloudflared-games.service >/dev/null 2>&1
sleep 6
echo '--- 服务状态'
systemctl is-active cloudflared-games.service
journalctl -u cloudflared-games.service -n 8 --no-pager 2>&1 | tail -8
