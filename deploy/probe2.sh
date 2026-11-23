#!/usr/bin/env bash
echo '--- cloudflared-nav unit'
systemctl cat cloudflared-nav.service 2>/dev/null | head -40
echo '--- /etc/cloudflared'
ls -la /etc/cloudflared 2>/dev/null
echo '--- /root/.cloudflared'
ls -la /root/.cloudflared 2>/dev/null
echo '--- 主 cloudflared unit'
systemctl cat cloudflared.service 2>/dev/null | head -30
echo '--- 443 是谁'
ss -ltnp | grep ':443 '
