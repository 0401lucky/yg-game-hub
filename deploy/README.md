# 部署说明

线上地址：https://games.lucky0625.us.ci

## 链路

```
GitHub(main) ──push──▶ Actions
                        ├─ verify: Node 24 类型检查 → Vite → Node / Playwright 测试
                        ├─ build: Dockerfile → ghcr.io/0401lucky/yg-game-hub:latest + :<sha>
                        └─ deploy: SSH 到服务器 → docker compose pull && up -d → 健康检查
                                             │
Cloudflare 边缘 ──tunnel yg-games──▶ 127.0.0.1:3007 (容器 3001)
```

服务器不开放 80/443，UFW 无需改动；流量全部走 Cloudflare Tunnel。

镜像采用两阶段构建。构建层安装开发依赖并完成类型检查与前端打包，运行层仅安装 Express / ws / dotenv，直接执行 `node backend/server.ts`。账号与统计的数据卷路径仍为 `/app/backend/data`，已有 compose 挂载无需迁移。

## 服务器上的东西

| 路径 | 说明 |
|---|---|
| `/opt/yg-games/docker-compose.yml` | 容器编排（端口 127.0.0.1:3007） |
| `/opt/yg-games/.env` | `SESSION_SECRET` 为玩家会话签名密钥；`ADMIN_KEY` 为独立运营管理密钥 |
| `/opt/yg-games/data/` | 账号库 `app.db`、每日统计 `stats.json`，**备份这里** |
| `/etc/cloudflared-games/config.yml` | 隧道配置，只映射 `games.lucky0625.us.ci` |
| `/etc/systemd/system/cloudflared-games.service` | 隧道服务，独立于机器上其它 cloudflared |

## 键盘操作

```bash
ssh yunyou
cd /opt/yg-games
docker compose logs -f --tail 100
docker compose restart
docker compose pull && docker compose up -d    # 一般由 CI 完成
systemctl status cloudflared-games
```

## 常用诊断

运营入口 `/admin` 需要单独配置 `ADMIN_KEY`，未配置时保持关闭。将随机密钥加入 `/opt/yg-games/.env`，并确保 compose 使用仓库中的 `ADMIN_KEY: ${ADMIN_KEY:-}` 环境映射；执行 `docker compose up -d` 重新创建容器后生效。更换管理密钥不影响玩家账号，会撤销现有管理会话。不要把实际密钥提交到仓库。

```bash
# 容器内服务本身是否活着
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3007/

# 隧道是否连到 Cloudflare
journalctl -u cloudflared-games -n 20 --no-pager | grep -i 'registered tunnel'

# 公网是否可达
curl -s -o /dev/null -w '%{http_code}\n' https://games.lucky0625.us.ci/
```

## 已知遗留

- 首次配置时误把 DNS 记录建成了 `games.204152.xyz.lucky0625.us.ci`（`204152.xyz` 不在当前 Cloudflare 账号下）。
  该记录无流量，删除需要 CF 面板或 API Token，不影响使用。
- 隧道版本提示过期（`cloudflared 2026.8.2`），升级建议先看 `systemctl status cloudflared`（机器上还有另一个生产隧道共用同一二进制）。
