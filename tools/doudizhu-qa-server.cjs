// 浏览器账号检查专用：真实账号接口 + 独立临时 SQLite，不碰玩家数据库。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { DoudizhuService } = require('../backend/doudizhu.cjs');

const root = path.resolve(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-ddz-ui-test-'));
const authFile = path.join(dataRoot, 'auth.cjs');
fs.copyFileSync(path.join(root, 'backend', 'auth.cjs'), authFile);
const auth = require(authFile);
const app = express();
app.use(express.json());
auth.mountAuthRoutes(app);
const service = new DoudizhuService({ auth });
app.get('/api/doudizhu/rooms', (req, res) => res.json({ rooms: service.listRooms() }));
app.use('/games', express.static(path.join(root, 'games')));
app.use(express.static(path.join(root, 'web')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => service.handleConnection(ws, req));
service.ready.then(() => server.listen(3012, '127.0.0.1', () => {
  console.log(JSON.stringify({ url: 'http://127.0.0.1:3012/games/doudizhu/', pid: process.pid, dataRoot }));
}));
