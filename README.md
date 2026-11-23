# 游戏大厅

自建的多人在线小游戏合集：一个门户页 + 若干可插拔的游戏，共用一套账号与服务器。

当前已上线两款：

- **飞行棋**（完整中文规则、房间码联机、AI 托管、观战回放）
- **大富翁**（客厅模式：电视当棋盘、手机当手柄，扫码开局，服务端权威裁决）

```
浏览器 ──┬─ /                     游戏大厅（门户）
         ├─ /games/flight/        飞行棋
         ├─ /games/monopoly/      大富翁（大屏）
         ├─ /games/monopoly/phone.html?room=XXXX   大富翁（手机手柄）
         ├─ /api/auth/*           账号（注册/登录/退出）
         └─ /api/me/stats         个人战绩
              │
              └─ WebSocket（同一个端口，握手时用 Cookie 认人；?party= 分流给大富翁）
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
  monopoly.cjs         大富翁粘合层：预加载 ESM 房间模块 + 同端口 WebSocket 分流
  dailyStats.cjs       每日统计（JSON 落盘）
  data/                运行期数据（app.db / stats.json / 会话密钥），已 gitignore
  test-auth.mjs        账号链路测试
  test-stats.mjs       战绩链路测试
  test-assets.mjs      静态资源完整性测试

games/
  shared/              飞行棋共用的规则引擎（engine / bot / replayCodec / timing）
  flight/              飞行棋：index.html（大厅）game.html（对局）spectate/replay/stats/admin
    public/            音效与图标，按 vite 语义叠加到 /games/flight/ 根路径
  monopoly/            大富翁：index.html（大屏）phone.html（手机手柄）play.js/phone.js
    shared/            规则引擎 board.js / engine.js（前后端共用，服务器说了算）
    avatars/ flags/    角色与国旗图标（Fluent Emoji / flag-icons，均 MIT）
    party.mjs          聚会模式房间（服务端，ESM，不对静态目录暴露）
    rules-upstream.md  上游规则文档（68 格棋盘与卡牌数值的唯一来源）

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

## 大富翁

基于 [bassnova42/party-tycoon](https://github.com/bassnova42/party-tycoon) 二次开发。
规则是「掷骰绕地球买国家盖房收过路费」的中文大富翁：68 格棋盘、48 个国家（12 组）、
机场与公司、机会/命运卡、抵押贷款、入狱、破产，起始 $2500，经过起点 $400。

### 两种入口

| 地址 | 用途 |
|---|---|
| `/games/monopoly/` | **客厅模式大屏**：投到电视上，显示二维码和房间码，只演不操作 |
| `/games/monopoly/phone.html?room=ABCD` | 手机手柄：扫码进来，起名选角色、掷骰、买地、付款、挂牌卖地 |
| `/games/monopoly/?solo=1` | 本地试玩：一台电脑 2–6 人轮流点，对局存 localStorage |

开局流程：大屏开房 → 所有人扫同一个码进房（2–6 人）→ 各自选角色点「我选好了」→ 主持人点「开局」。

### 服务端怎么接的

大富翁的房间逻辑是原生 ESM（`games/monopoly/party.mjs`），大厅是 CJS，所以走了这层粘合：

- `backend/monopoly.cjs` 在 `server.listen()` **之前**动态 import 预加载房间模块；
- 同一条 WebSocket 端口按 query 分流：`?party=screen`（大屏）/ `?party=phone`（手机）交给大富翁，
  其余消息仍由飞行棋的处理器接管 —— 两种游戏互不影响；
- 规则引擎 `shared/engine.js` 是纯函数：手机只发「我要掷骰/买/盖」，服务器判定后广播新局面，客户端改不了骰子和钱；
- 静态目录里的 `party.mjs` / `tts.mjs` 已被服务端拦成 404，不会把服务端源码当资源发出去。

### 与上游的差异

| 上游 | 这里 |
|---|---|
| 根路径 `/party`、`/p/房间码` | `/games/monopoly/`、`/games/monopoly/phone.html?room=`，全部相对路径引用 |
| 独立进程 + 独立端口 | 并进大厅同进程、同端口，`/games/` 下静态托管 |
| 二维码固定用局域网 IP | 局域网打开用局域网 IP；域名（Cloudflare 隧道）打开用当前 origin，扫码直接走公网 |
| 自带 `users.json` 账号 | 暂不使用（客厅模式本来就不登录）；账号与战绩复用大厅那套，见下节 |
| Gemini TTS 语音 | 保留但默认关：没配 `GEMINI_API_KEY` 时 `/games/monopoly/tts` 回 503，前端自动退回浏览器中文语音，音效是 WebAudio 合成、无音频文件 |

### 战绩怎么记

客厅模式默认不登录（扫码即玩），但**登录着玩会自动记账**：

1. WebSocket 握手时服务端解析 `ac_session` Cookie，能认出是谁；
2. 手机端进房时把座位绑到这个 `userId`（座位一旦绑定就不会被换掉，刷新/重连仍在）；
3. 一局结束（有人破产 / 时间到 / 主持人结束）时，`party.mjs` 回调一次结算，
   `backend/monopoly.cjs` 把它转成 `matches` + `match_players` 两行数据，`game_id = 'monopoly'`；
4. 门户右上角账号面板与 `/api/me/stats` 就能看到「大富翁 N 局 / 胜 M」。

全匿名的房间照样能玩，只是不落库 —— 和飞行棋「全匿名对局不记录」的规则一致。
手机页顶部会显示「战绩 昵称」，看到这行就说明这局会记下来。

### 语音（可选）

在 `backend/.env` 里加 `GEMINI_API_KEY=...`，再把 `games/monopoly/tts.mjs` 从上游复制过来接上路由即可。
不配也能完整玩，只是少了真人味儿的播报。

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
npm run test:monopoly  # 大富翁联机冒烟：开房 → 两人进房 → 打完一局到结束
node backend/test-monopoly-stats.mjs   # 大富翁战绩：登录座位记账、匿名不记、赢家记 wins
node backend/test-stats.mjs    # 战绩写入与读回（飞行棋）
node backend/test-assets.mjs   # 页面引用的静态资源是否全部可达
```

---

## 许可与致谢

- 飞行棋部分基于 [ZTMYO/MinimalistAeroplaneChess](https://github.com/ZTMYO/MinimalistAeroplaneChess)（GPLv3）二次开发，
  规则实现与界面版权归原作者，本项目在其基础上增加了账号体系、战绩与多游戏门户结构。
- 大富翁部分基于 [bassnova42/party-tycoon](https://github.com/bassnova42/party-tycoon) 二次开发。
  上游仓库**没有附 LICENSE 文件**（只有素材各自的许可），默认按「保留所有权利」理解：
  自建服务器与朋友娱乐没问题，若要公开分发或商用，先联系原作者取得授权。
  素材许可：角色图标 Microsoft Fluent Emoji（MIT）、国旗 flag-icons（MIT）、二维码 qrcode-generator（MIT），
  许可文本分别在 `games/monopoly/avatars/LICENSE.txt`、`games/monopoly/flags/LICENSE-flag-icons.txt`。

自建服务器与朋友娱乐可直接使用；对外运营或商用请遵循上游协议并保留版权信息。
