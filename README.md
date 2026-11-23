# 游戏大厅

自建的多人在线小游戏合集：一个门户页 + 若干可插拔的游戏，共用一套账号与服务器。

当前已上线 **飞行棋**（完整中文规则、房间码联机、AI 托管、观战回放）。

```
浏览器 ──┬─ /                     游戏大厅（门户）
         ├─ /games/flight/        飞行棋
         ├─ /api/auth/*           账号（注册/登录/退出）
         └─ /api/me/stats         个人战绩
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
  authority.cjs        对局权威状态机
  botDriver.cjs        服务端 AI 托管驱动
  dailyStats.cjs       每日统计（JSON 落盘）
  data/                运行期数据（app.db / stats.json / 会话密钥），已 gitignore
  test-auth.mjs        账号链路测试
  test-stats.mjs       战绩链路测试
  test-assets.mjs      静态资源完整性测试

games/
  shared/              游戏共用的规则引擎（engine / bot / replayCodec / timing）
  flight/              飞行棋：index.html（大厅）game.html（对局）spectate/replay/stats/admin
    public/            音效与图标，按 vite 语义叠加到 /games/flight/ 根路径

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

```bash
cd backend
npm install --omit=dev
pm2 start server.cjs --name game-hub
pm2 save && pm2 startup
```

Nginx 反代要点（少一条联机就废）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket 握手必需
    proxy_set_header Connection "upgrade";       # WebSocket 握手必需
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;                    # 长连接别被 60s 掐断
}
```

上了 HTTPS 后，在 `backend/.env` 里设 `COOKIE_SECURE=1`，Cookie 才会带 `Secure`。

备份只需要打包 `backend/data/`（账号库 + 会话密钥 + 每日统计）。

---

## 测试

```bash
npm run test:auth      # 注册/登录/限流/篡改签名/WS 身份绑定
node backend/test-stats.mjs    # 战绩写入与读回
node backend/test-assets.mjs   # 页面引用的静态资源是否全部可达
```

---

## 许可与致谢

飞行棋部分基于 [ZTMYO/MinimalistAeroplaneChess](https://github.com/ZTMYO/MinimalistAeroplaneChess)（GPLv3）二次开发，
规则实现与界面版权归原作者，本项目在其基础上增加了账号体系、战绩与多游戏门户结构。
自建服务器与朋友娱乐可直接使用；对外运营或商用请遵循上游协议并保留版权信息。
