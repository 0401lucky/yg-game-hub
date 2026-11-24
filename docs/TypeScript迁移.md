# TypeScript 与模块化迁移

## 验收范围

保留全部 HTTP 路径、两套历史飞行棋 WS 封装、斗地主私有手牌、规则和数据库结构。
迁移前源码基线保存在本机 `D:/games/_repro/ts-migration-baseline-20261124`，包含已有未提交修改。
扫雷已按完成后的 TypeScript 实现接入统一构建、插件和账号体系，保留大厅 online 状态。

## 里程碑

1. 建立严格、隔离平台的 TS 配置；迁移共享引擎与后端，拆分游戏模块和飞行棋服务职责。
2. 合并为根目录 Vite 7 多页面构建；按原始顺序拆分 CSS，保留桌面、手机和暗色主题。
3. 全量迁移 DOM 前端与工具，接入公共及各游戏的双向判别联合协议。
4. 整合独立数据目录的 node:test / Playwright 门禁，更新两阶段 Docker 与部署文档。

## 运行与类型边界

- 后端直接执行 `node backend/server.ts`，没有编译步骤或运行时转译器。
- 生产依赖保持 `express`、`ws`、`dotenv` 三项，数据库使用 `node:sqlite`。
- `tsconfig.shared.json` 只使用 ES 标准库；`tsconfig.backend.json` 使用 Node 类型；`tsconfig.frontend.json` 使用 DOM / Vite 类型；`tsconfig.tools.json` 单独检查构建工具和浏览器测试。
- 根配置统一开启 `strict`、`noEmit`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`。纯类型导入用 `import type`，相对 TS 导入保留 `.ts`。
- 游戏自身的 `protocol.ts` 使用双向判别联合，飞行棋保留扁平与 `data` 信封两种历史格式；扫雷保留原 HTTP 协议。
- 开发运行 `npm run dev`，访问 Vite 的端口；生产先运行 `npm run build`，Express 只托管 `dist/`。Hash JS/CSS 长缓存，HTML 与游戏注册表不缓存。
- 开发监视使用 Node 内置文件 API，对比源码修改时间与大小后重启；避免 Windows 读取事件触发原生 `--watch` 的误重启。后端子进程仍直接执行 TS。

## 模块划分

`backend/server.ts` 只负责启动和停止。`app.ts` 统一处理鉴权、SQLite 初始化、静态托管、WS 路径分发和插件生命周期。

每款游戏通过 `games/<id>/server.ts` 导出 `createGameModule(context)`，服务器按目录自动发现。飞行棋的房间、权威引擎、AI、聊天、消息、连接和 HTTP 已拆入 `games/flight/server/`；斗地主与扫雷各自维护 `server/service.ts`。

Vite 配置也按目录自动收集 HTML，构建时收集游戏媒体，镜像构建时自动收集服务器与共享 TS 源码。新增游戏无需修改主服务器路由或逐项列举镜像的游戏目录。

CSS 按原始顺序拆为 `web/css/tokens.css`、`common.css` 以及飞行棋各功能样式，聚合入口仍为 `games/flight/css/style.css`。页面布局和玩法没有重新设计；启动主题脚本仍在 CSS 前同步执行。

## 回归证据与部署

- 规则基线 `tests/fixtures/flight-golden.json` 来自迁移前 JS：36 局、6,664 步，覆盖人数、棋子数、欢乐/道具模式、AI 决策、事件、快照和回放元组。
- CSS 对照确认原 1,119 个顶层规则顺序一致；Playwright 在 1440×900、390×844、844×390 下验证操作和截图。飞行棋原横屏棋盘的 875 px 布局宽度已用旧版实测对照。
- Node 测试包含原斗地主测试及账号、HTTP、飞行棋房间/权威、回放和扫雷规则/计时/结算。
- 浏览器测试检查全部入口与账号，覆盖飞行棋联机、观战和回放，斗地主长牌型与完整结算，扫雷长按/拖动、暂停、每日挑战、刷新和登录接回，并自动拦截 404、控制台错误及页面异常。
- 测试使用独立进程、端口、临时数据目录和密钥，不修改玩家数据库。
- Docker 分为 Node 24 构建层与运行层；运行层仅安装生产依赖并复制 `dist/` 与 TS 运行源码，数据卷仍是 `/app/backend/data`。
- CI 先通过类型检查、Vite 构建、Node 与 Playwright，才进入镜像推送和部署。
- 本次保留原 WAV 音效文件，未进行可选转码。

## 本机验收结果（2026-11-25）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 四个类型作用域全部通过，0 报错 |
| `npm run build` | Vite 7 多页面与 Hash 静态文件构建成功 |
| `node backend/server.ts` | Node 24.22.3 原生启动成功 |
| 仅生产依赖运行 | `npm ci --omit=dev` 的隔离副本成功启动，HTTP / WS 正常 |
| `npm test` | 32 项全部通过 |
| `npm run test:e2e` | 48 项全部通过，0 跳过、0 重试、0 页面 404 / 控制台异常 |
| 本地开发 | 三款游戏、HTTP / WS 代理和源码热更新验证通过 |
| Docker | 已尝试构建；本机返回 `Docker Desktop is unable to start`，镜像尚未实测 |

测试服务使用专用 `YG_TEST_DATA_DIR` 或新建临时目录，覆盖常规数据目录环境变量；浏览器测试在服务退出、每日统计退出钩子完成后清理自建目录。玩家数据库未用于验收。

## 验证清单

- 原生 Node 24 启动、严格类型检查、Vite 构建和生产依赖清单。
- 账号注册登录、签名 Cookie、游客游戏、SQLite 战绩以及原表结构。
- 飞行棋建房幂等、准备、换座、重连、AI、快照去重、观战和回放。
- 斗地主完整牌型、三档人机、双人房、隐私、托管、重连、再来一局和团队胜场。
- 原引擎与 TS 引擎的确定性动作、快照和回放结果对照。
- 所有 HTML 入口、静态文件、音效、兼容跳转；浏览器无 404、页面异常或控制台错误。
- 门户、飞行棋和斗地主在桌面、手机、横屏、亮色和暗色下的原 CSS 规则顺序与视觉。
- 可用时构建 Docker 镜像，并检查数据卷仍为 `/app/backend/data`。
