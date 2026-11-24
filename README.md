# 游戏大厅

自建的多人在线小游戏合集：一个门户页 + 若干可插拔的游戏，共用一套账号与服务器。

当前已实现两款：

- **飞行棋**（完整中文规则、房间码联机、AI 托管、观战回放）
- **斗地主 · 午夜牌桌**（1-3 位真人、简单／困难／地狱人机、精致牌面与动画、房间码联机、托管与重连）

```
浏览器 ──┬─ /                     游戏大厅（门户）
         ├─ /games/flight/        飞行棋
         ├─ /games/doudizhu/      斗地主
         ├─ /api/auth/*           账号（注册/登录/退出）
         ├─ /api/me/stats         个人战绩
         └─ /api/client-error     前端异常上报（排查手机端闪退用）
              │
              └─ WebSocket（同一个端口，握手时用 Cookie 认人）
```

---

## 目录结构

```
backend/
  server.cjs           主服务：HTTP + WebSocket + 静态托管
  auth.cjs             账号系统（node:sqlite + scrypt + 签名 Cookie）
  roomManager.cjs      房间/会话领域模型（飞行棋）
  authority.cjs        对局权威状态机（飞行棋）
  botDriver.cjs        服务端 AI 托管驱动（飞行棋）
  doudizhu.cjs         斗地主房间、私有手牌快照、服务端回合与人机驱动
  dailyStats.cjs       每日统计（JSON 落盘）
  data/                运行期数据（app.db / stats.json / 会话密钥），已 gitignore
  test-auth.mjs        账号链路测试
  test-flight-room.mjs 房间链路测试（建房幂等 / 准备广播 / 过期房间）
  test-stats.mjs       战绩链路测试
  test-assets.mjs      静态资源完整性测试

games/
  shared/              飞行棋共用的规则引擎（engine / bot / replayCodec / timing）
  flight/              飞行棋：index.html（大厅）game.html（对局）spectate/replay/stats/admin
    public/            音效与图标，按 vite 语义叠加到 /games/flight/ 根路径
  doudizhu/            斗地主：牌桌界面、engine.mjs 规则、bot.mjs 三档人机、生成素材

web/                   门户：index.html + css/hub.css + js/hub.js
  games.json           游戏注册表（新增游戏只改这里）
  css/account.css      全局账号组件样式
  js/account.js        全局账号组件（门户与各游戏共用）
```

---

## 快速开始

```bash
npm install          # 只装 backend 依赖，前端免构建

cd backend
cp .env.example .env # 可选：改 PORT / SESSION_SECRET
node server.cjs
```

打开 http://localhost:3001 就是大厅，点飞行棋进入。

斗地主直接打开 http://localhost:3001/games/doudizhu/。两个人玩时创建好友房，把六位房间码或邀请链接给朋友，第三个座位默认有人机；具体规则和人机机制见 [斗地主说明](docs/斗地主.md)。

**不需要登录也能玩**；登录只是把昵称绑定到账号、把对局战绩存下来。

---

## 账号系统

- 存储：Node 内置 `node:sqlite`（Node ≥ 22.5），单文件 `backend/data/app.db`，零原生依赖
- 密码：`scrypt`（N=16384, r=8, p=1）+ 每用户随机盐，`timingSafeEqual` 比对
- 会话：HMAC-SHA256 签名 Cookie `ac_session`，HttpOnly + SameSite=Lax + 30 天
- 密钥：优先读环境变量 `SESSION_SECRET`，否则自动生成并落在 `backend/data/session-secret.txt`
- 限流：注册按 IP、登录按 IP+用户名，1 分钟窗口
- 身份贯通：WebSocket 握手请求自带 Cookie → 服务端认人 → 建房/加入时昵称自动取账号昵称

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | `{username, password, nickname?}` → 下发 Cookie |
| POST | `/api/auth/login` | `{username, password}` → 下发 Cookie |
| POST | `/api/auth/logout` | 清除 Cookie |
| GET | `/api/auth/me` | 当前用户 + 战绩摘要 |
| GET | `/api/me/stats` | 战绩详情（近 10 局），未登录 401 |

### 表结构

```sql
users(id, username UNIQUE, pass_hash, nickname, created_at, last_login_at)
matches(id, room_code, mode, player_count, winner_user_id, duration_ms, ended_at)
match_players(id, match_id, user_id, player_id, nickname, color, is_winner)
```

对局结束时由 `commitSnapshot()` 统一收尾 → `recordAccountMatch()` → 只记录已登录玩家，全匿名对局不落库。

---

## 新增一个游戏

1. 把游戏放进 `games/<id>/`，页面用相对路径引用资源；
   若游戏需要共享规则代码，从 `../../shared/xxx.mjs` 引入（会解析到 `/games/shared/`）。
2. 需要根路径静态资源（音效、图标）就放 `games/<id>/public/`，服务端会自动叠加挂载。
3. 在 `web/games.json` 里加一条：

```json
{
  "id": "gomoku",
  "name": "五子棋",
  "emoji": "⚫",
  "accent": "#afccea",
  "accentSoft": "#e9f2fb",
  "desc": "一句话介绍",
  "path": "/games/gomoku/",
  "status": "online",
  "players": "2 人",
  "tags": ["1v1", "回合制"]
}
```

`status` 写 `online` 即在大厅显示「可玩」，其他值显示为「即将上线」。
账号、门户、静态托管都不用改——这是刻意留的扩展点。

### 页面跳转约定

游戏内部请用**相对路径**（`game.html`、`stats.html`、`./`），
不要写 `/game` 这类站点根路径，否则换挂载点时全部失效。
旧的根路径地址（`/game`、`/stats`、`/admin`、`/spectate`、`/replay`）服务端保留了 302 兼容跳转。

---

## 部署

线上地址：**https://games.lucky0625.us.ci**

链路：GitHub Actions 构建镜像 → GHCR → 服务器 `docker compose` 拉取重启 → Cloudflare Tunnel 对外。

```
push main → Actions 构建 ghcr.io/0401lucky/yg-game-hub:latest
          → SSH 到服务器 /opt/yg-games 执行 compose pull && up -d
          → cloudflared 隧道把 games.lucky0625.us.ci 转到 127.0.0.1:3007
```

服务器上不开放 80/443，只监听回环端口，全部走隧道，UFW 不用改。

### 首次部署（已完成，仅记录）

```bash
# 服务器
mkdir -p /opt/yg-games/data
cd /opt/yg-games
printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > .env && chmod 600 .env
# docker-compose.yml 见 deploy/docker-compose.yml
docker compose up -d

# 隧道（独立 tunnel，不影响机器上已有的 cloudflared 服务）
cloudflared tunnel create yg-games
cloudflared tunnel route dns yg-games games.lucky0625.us.ci
systemctl enable --now cloudflared-games   # 配置见 deploy/tunnel-setup.sh
```

### 日常运维

```bash
ssh yunyou
cd /opt/yg-games
docker compose logs -f --tail 100        # 看日志
docker compose restart                   # 重启
docker compose pull && docker compose up -d   # 手动更新（平时由 CI 完成）
```

数据都在 `/opt/yg-games/data`（账号库 `app.db` + 每日统计）。**备份就打包这个目录。**

### 仓库 secrets

| 名称 | 用途 |
|---|---|
| `SSH_HOST` | 服务器地址 |
| `SSH_USER` | 登录用户 |
| `SSH_PORT` | SSH 端口 |
| `SSH_KEY` | 部署专用私钥（对应服务器的 authorized_keys） |

镜像在公开仓库下自动继承为公开，服务器无需 `docker login`。

---


## 测试

```bash
npm run test:auth      # 注册/登录/限流/篡改签名/WS 身份绑定
npm run test:flight-room  # 飞行棋房间链路：建房幂等、准备广播、过期房间错误码
npm run test:doudizhu     # 斗地主规则、人机对局、联机恢复、农民双人胜场
node backend/test-stats.mjs    # 战绩写入与读回（飞行棋）
node backend/test-assets.mjs   # 页面引用的静态资源是否全部可达
```

### 联机掉线约定（踩过的坑）

客户端断线重连这块有几条硬规矩，改代码时别退回去，否则线上就是「朋友点一下准备，页面自己弹回大厅」：

- **断线期间只补发幂等消息**。`createRoom` / `join_room` / `leave_room` / `toggle_ready` 一律不排队重放
  （见 `games/flight/js/websocketClient.js` 的 `REPLAYABLE_TYPES`）。补发一次建房 = 服务端另建一间、
  原房间销毁，房里另一位玩家直接判成「房间不存在」。
- **一个玩家同一时刻只允许一条 socket**。`connectToServer()` 是单飞的，且复用同一个 `WebSocketClient`；
  两条 socket 会触发服务端「新连接顶掉旧连接」，来回互相踢成每秒一次的重连风暴。
- **建房带 `requestId`**，服务端 60 秒内同一个 `requestId` 只建一间房（`backend/server.cjs` 的
  `createRoomRequests`）。
- **连接断了不要把页面送走**。重连失败只挂提示条并继续退避重试；房间真的没了就退回「房间列表」并给一个
  按钮，页不跳。整页 `location.replace` 在手机上看起来跟闪退一样，也没法解释原因。
- 前端异常和 `pagehide` 会 POST 到 `/api/client-error`，容器日志里搜 `[前端异常]` 就能看到现场。

---

## 许可与致谢

- 飞行棋部分基于 [ZTMYO/MinimalistAeroplaneChess](https://github.com/ZTMYO/MinimalistAeroplaneChess)（GPLv3）二次开发，
  规则实现与界面版权归原作者，本项目在其基础上增加了账号体系、战绩与多游戏门户结构。

自建服务器与朋友娱乐可直接使用；对外运营或商用请遵循上游协议并保留版权信息。
