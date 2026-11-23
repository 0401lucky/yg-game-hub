// 飞行棋联机回归：建房幂等 / 准备广播 / 过期房间的错误码
//
// 对应线上事故：两个人开房，朋友点「准备」时页面被弹回大厅。
// 根因不是准备本身，而是房主那条连接在抖：重连时把排队的 createRoom 补发了一遍，
// 服务端照做另建一间房，原来那间随之销毁，另一位玩家收到 roomGone。
//
//   cd backend && node server.cjs        # 另开一个终端
//   node backend/test-flight-room.mjs
//
// 也可以用 HUB 指向线上：HUB=https://games.lucky0625.us.ci node backend/test-flight-room.mjs
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const WebSocket = require('ws');

const hub = process.env.HUB || 'http://127.0.0.1:3001';
const WS_URL = hub.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function connect(prefix = 'player') {
  const ws = new WebSocket(WS_URL);
  const playerId = `${prefix}_${Math.random().toString(36).slice(2, 6)}`;
  const inbox = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {
      // ignore
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const send = (type, data = {}) => ws.send(JSON.stringify({ type, data, playerId, timestamp: Date.now() }));
  const waitFor = async (pred, timeout = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(30);
    }
    return null;
  };
  return { ws, playerId, send, waitFor, inbox, ready };
}

const host = connect('player_host');
const guest = connect('player_guest');
await Promise.all([host.ready, guest.ready]);
host.send('identify', { playerId: host.playerId });
guest.send('identify', { playerId: guest.playerId });
await sleep(120);

// 1) 房主建房
const requestId = `create-test-${Date.now()}`;
host.send('createRoom', { requestId, nickname: '房主', maxPlayers: 4, gameMode: 'multiplayer' });
const created = await host.waitFor((m) => m.type === 'roomCreated');
ok('建房返回 roomCreated', !!created, created?.room?.code);
const roomCode = created?.room?.code;

// 2) 同一个 requestId 再发一次（模拟重连补发）：必须复用同一间房
host.send('createRoom', { requestId, nickname: '房主', maxPlayers: 4, gameMode: 'multiplayer' });
const replayed = await host.waitFor((m) => m.type === 'roomCreated' && m.replayed === true);
ok('重复 createRoom 复用原房间', replayed?.room?.code === roomCode, `${roomCode} -> ${replayed?.room?.code}`);

// 3) 另一位玩家进房 + 点准备
guest.send('join_room', { roomCode });
const joined = await guest.waitFor((m) => m.type === 'roomJoined');
ok('第二位玩家进房', joined?.room?.code === roomCode, joined?.room?.code);

guest.send('toggle_ready', { isReady: true });
const ready = await host.waitFor((m) => m.type === 'playerReadyStatusChanged' && m.playerId === guest.playerId);
ok('准备状态广播到房主', ready?.isReady === true);

// 4) 过期房间号：服务端要给出可识别的 code，客户端据此退回房间列表而不是整页跳走
guest.send('join_room', { roomCode: 'ZZZZ' });
const stale = await guest.waitFor((m) => m.type === 'error' && m.code === 'roomGone');
ok('过期房间返回 code=roomGone', !!stale, stale?.message);

// 5) 这一路折腾下来，原来那间房必须还在（这才是「朋友点准备后房间还在」的底线）
const rooms = connect('player_probe');
await rooms.ready;
const probeId = rooms.playerId;
rooms.send('identify', { playerId: probeId });
await sleep(100);
rooms.send('listRooms');
const list = await rooms.waitFor((m) => m.type === 'roomsList');
const stillThere = (list?.rooms || []).some((r) => r.code === roomCode);
ok('原房间仍然存在', stillThere, roomCode);

for (const c of [host, guest, rooms]) c.ws.close();
await sleep(200);
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`);
process.exitCode = failures ? 1 : 0;
