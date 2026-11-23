#!/usr/bin/env bash
echo '--- UFW'
ufw status 2>/dev/null | head -12 || echo none
echo '--- 80/443 占用'
ss -ltn | grep -E ':(80|443) ' || echo free
echo '--- cloudflared 服务'
systemctl list-units --type=service --all 2>/dev/null | grep -i cloudflare | head -5
echo '--- cloudflared 配置'
ls -la /etc/cloudflared /root/.cloudflared 2>/dev/null | head -20
echo '--- 端口抽查'
ss -ltn | awk '{print $4}' | grep -oE '[0-9]+$' | sort -n | uniq | tr '\n' ' '
echo
echo '--- docker 空间'
du -sh /var/lib/docker 2>/dev/null
df -h / | tail -1
echo '--- 是否已登录 ghcr'
test -f /root/.docker/config.json && grep -o 'ghcr.io' /root/.docker/config.json | head -1 || echo 'no ghcr login'
echo '--- 时间/时区'
date
