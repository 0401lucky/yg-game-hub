# 游戏大厅

自建的多人在线小游戏合集：一个门户页 + 若干可插拔的游戏，共用一套账号与服务器。

当前已实现三款：

- **飞行棋**（完整中文规则、房间码联机、AI 托管、观战回放）
- **斗地主 · 午夜牌桌**（1-3 位真人、简单／困难／地狱人机、精致牌面与动画、房间码联机、托管与重连）
- **扫雷 · 林间探险**（三档难度、首击保护、每日同图挑战、长按插旗、暂停续玩、共享账号手记；TypeScript 源码）

```
浏览器 ──┬─ /                     游戏大厅（门户）
         ├─ /games/flight/        飞行棋
         ├─ /games/doudizhu/      斗地主
         ├─ /games/minesweeper/   扫雷
         ├─ /api/auth/*           账号（注册/登录/退出）
         ├─ /api/me/stats         个人战绩
         └─ /api/client-error     前端异常上报（排查手机端闪退用）
              │
              └─ WebSocket（同一个端口，握手时用 Cookie 认人）
```

---

## 目录结构

```text
index.html                         大厅 HTML 入口
vite.config.ts                     统一 Vite 7 多页面构建与开发代理
tsconfig*.json                     strict / noEmit，隔离共享、Node、DOM 与工具
backend/
  server.ts                        Node 24 原生启动入口
  app.ts                           Express、账号、WS 分发和公共生命周期
  gameModule.ts / gameRegistry.ts   游戏插件契约与目录自动注册
  auth.ts / minesweeper-stats.ts    SQLite 账号与战绩
  config.ts / dailyStats.ts         环境与每日统计
  static.ts / telemetry.ts          构建产物托管与异常上报
  data/                            既有运行数据目录，已 gitignore
games/
  shared/                          平台无关的协议、引擎、AI、回放与时序
  flight/
    server.ts / server/            飞行棋房间、权威状态、AI、消息与 HTTP
    protocol.ts / httpProtocol.ts   共享 WS 与 HTTP 类型
    types.ts / js/*.ts              游戏类型与原生 DOM / SVG 前端
    css/                           按原始顺序聚合的模块样式
    public/                        音效与图标，输出到 /games/flight/
  doudizhu/                        server.ts、server/、engine.ts、bot.ts、app.ts
  minesweeper/                     server.ts、server/、engine.ts、app.ts
web/
  games.json                       大厅注册表，构建后为 /games.json
  js/                              account.ts / hub.ts / dom.ts
  css/                             tokens.css / common.css / hub.css / account.css
tests/
  node/                            规则、房间、协议、账号与 HTTP 回归
  e2e/                             Playwright 桌面、竖屏与横屏测试
  fixtures/                        迁移前确定性回归基线
tools/                             原生 TS 引擎 CLI、源码监视、隔离测试与运行源码收集
dist/                              Vite 构建产物，不提交
```


---

## 快速开始

需要 **Node.js 24+**。所有依赖统一在根目录安装，生产依赖仅 `express`、`ws`、`dotenv`，SQLite 使用 Node 内置模块。

```bash
npm ci
cp backend/.env.example backend/.env   # 可选：PORT / SESSION_SECRET
npm run dev                           # 后端 watch + Vite 开发服务
```

开发时打开 Vite 打印的地址（默认 http://localhost:5173），`/api` 和 `/ws` 代理到后端。可通过 `VITE_BACKEND_URL` 指定开发代理目标。

生产方式在根目录运行：

```bash
npm run typecheck
npm run build
node backend/server.ts
```

打开 http://localhost:3001。后端直接执行 TS 源码，前端静态文件由 Express 从 `dist/` 托管。扫雷已纳入同一套构建与账号体系，无需单独安装或编译。

**不需要登录也能玩**；登录后可保存昵称与战绩。玩法见 [斗地主说明](docs/斗地主.md) 与 [扫雷说明](docs/扫雷.md)，架构与验证见 [迁移说明](docs/TypeScript迁移.md)。


---

## 账号系统

- 存储：Node 内置 `node:sqlite`（Node ≥ 24），单文件 `backend/data/app.db`，零原生依赖
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
matches(id, room_code, mode, player_count, winner_user_id, duration_ms, ended_at, game_id)
match_players(id, match_id, user_id, player_id, nickname, color, is_winner)
```

对局结束时由 `commitSnapshot()` 统一收尾 → `recordAccountMatch()` → 只记录已登录玩家，全匿名对局不落库。

---

## 新增一个游戏

1. 把 HTML 与原生 TS 前端放进 `games/<id>/`，相对 TS 导入显式保留 `.ts` 后缀。引擎与协议保持平台无关。
2. 在 `games/<id>/server.ts` 导出 `createGameModule(context)`，实现 `GameModule` 的 HTTP 注册、WS 路径与生命周期。服务器自动发现插件，构建也自动收集 HTML 和运行源码。
3. 静态媒体可放 `games/<id>/public/` 或 `assets/`，游戏样式在自己的 CSS 中维护。
4. 在 `web/games.json` 里加一条：

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

链路：GitHub Actions 类型检查、构建、Node / Playwright 测试通过后构建镜像 → GHCR → 服务器 `docker compose` 拉取重启 → Cloudflare Tunnel 对外。

```
push main → Actions 验证通过后构建 ghcr.io/0401lucky/yg-game-hub:latest
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

两阶段镜像以 Node 24 构建前端并校验类型，运行层仅安装生产依赖，直接执行 `backend/server.ts`。数据卷路径仍为 `/app/backend/data`。

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
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

Node 与 Playwright 测试自动创建独立端口、临时 SQLite 与测试密钥，结束时清理，不触碰 `backend/data/`。也可运行 `test:auth`、`test:flight-room`、`test:doudizhu` 做定向回归。

Playwright 覆盖桌面、手机竖屏和横屏，检查页面 404、控制台异常、账号切换、联机重连、观战回放、斗地主完整结算以及扫雷长按/拖动/暂停/每日挑战。截图与失败追踪写入已忽略的 `playwright-report/` 和 `test-results/`。

引擎 CLI 可直接运行 `node tools/play.ts --games 20 --seed 7`。


### 联机掉线约定（踩过的坑）

客户端断线重连这块有几条硬规矩，改代码时别退回去，否则线上就是「朋友点一下准备，页面自己弹回大厅」：

- **断线期间只补发幂等消息**。`createRoom` / `join_room` / `leave_room` / `toggle_ready` 一律不排队重放
  （见 `games/flight/js/websocketClient.ts` 的 `REPLAYABLE_TYPES`）。补发一次建房 = 服务端另建一间、
  原房间销毁，房里另一位玩家直接判成「房间不存在」。
- **一个玩家同一时刻只允许一条 socket**。`connectToServer()` 是单飞的，且复用同一个 `WebSocketClient`；
  两条 socket 会触发服务端「新连接顶掉旧连接」，来回互相踢成每秒一次的重连风暴。
- **建房带 `requestId`**，服务端 60 秒内同一个 `requestId` 只建一间房（`games/flight/server/rooms.ts` 的
  `createRoomRequests`）。
- **连接断了不要把页面送走**。重连失败只挂提示条并继续退避重试；房间真的没了就退回「房间列表」并给一个
  按钮，页不跳。整页 `location.replace` 在手机上看起来跟闪退一样，也没法解释原因。
- 前端异常和 `pagehide` 会 POST 到 `/api/client-error`，容器日志里搜 `[前端异常]` 就能看到现场。

---

## 许可与致谢

- 飞行棋部分基于 [ZTMYO/MinimalistAeroplaneChess](https://github.com/ZTMYO/MinimalistAeroplaneChess)（GPLv3）二次开发，
  规则实现与界面版权归原作者，本项目在其基础上增加了账号体系、战绩与多游戏门户结构。

自建服务器与朋友娱乐可直接使用；对外运营或商用请遵循上游协议并保留版权信息。
