#!/usr/bin/env node
// 大富翁联机冒烟测试：大屏开房 → 2 部手机进房选角色 → 开局 → 用服务端引擎算合法动作把一局打到底。
//
//   node tools/monopoly-drive.mjs                 # 默认连 ws://127.0.0.1:3001
//   HUB=http://localhost:3001 node tools/monopoly-drive.mjs
//
// 通过标准：能走到 status=ended，且事件里出现过 dice / move / money / buy / prop / bankruptcy 之类。
import { createRequire } from 'node:module';
import { legalActions } from '../games/monopoly/shared/engine.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const WebSocket = require('ws');

const hub = process.env.HUB || 'http://127.0.0.1:3001';
const BASE = hub.replace(/^http/, 'ws') + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (qs) => new Promise((res, rej) => { const w = new WebSocket(`${BASE}?${qs}`); w.on('open', () => res(w)); w.on('error', rej); });
const waitFor = (ws, pred, t = 8000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`timeout: ${pred}`)), t);
  const h = (raw) => { const m = JSON.parse(raw); if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); } };
  ws.on('message', h);
});

let room = null;
const screen = await open('party=screen');
screen.on('message', (r) => { const m = JSON.parse(r); if (m.t === 'room') room = m.room; if (m.t === 'error') console.log('[大屏]', m.msg); });
const { code } = await waitFor(screen, (m) => m.t === 'screen');
console.log(`房间码 ${code}`);

async function phone(avatar) {
  const ws = await open(`party=phone&room=${code}`);
  await waitFor(ws, (m) => m.t === 'token');
  ws.send(JSON.stringify({ t: 'pick', code: avatar }));
  ws.send(JSON.stringify({ t: 'ready', v: true }));
  ws.on('message', (r) => { const m = JSON.parse(r); if (m.t === 'error') console.log(`  [手机 ${avatar}] ${m.msg}`); });
  return ws;
}
// 小狗开局多 $500，熊猫没有 —— 顺便验证角色奖励
const A = await phone('1f436');
const B = await phone('1f43c');
await sleep(300);
console.log('座位:', room.seats.map((s) => `${s.name}${s.ready ? '✓' : '✗'}`).join(', '));

screen.send(JSON.stringify({ t: 'start' }));
await sleep(400);
console.log('开局:', room.game.players.map((p) => `${p.name}$${p.cash}`).join(' / '),
  '| 顺序', room.game.order.map((i) => room.game.players[i].name).join(' → '));

const wsOf = (pid) => (room.game.players.find((x) => x.id === pid).avatar === '1f436' ? A : B);
// 大屏「演完了这一步」：序号要用游戏当前的 seq
const played = () => screen.send(JSON.stringify({ t: 'played', seq: room.game.seq }));
played();
await sleep(150);

const seen = new Map();
let acts = 0, guard = 0;
while (acts < 80 && guard < 3000) {
  guard++;
  const g = room.game;
  if (!g || g.status !== 'playing') break;
  if (room.showing) { played(); await sleep(40); continue; }
  if (room.waitingFor) { wsOf(room.waitingFor.pid).send(JSON.stringify({ t: 'ack' })); await sleep(40); continue; }

  const actorId = g.pending?.pid || g.players[g.order[g.turnIdx]].id;
  const opts = legalActions(g, actorId);
  if (!opts.length) { await sleep(60); continue; }
  const pick = opts.find((o) => o.type === 'roll')
    || opts.find((o) => o.type === 'buy' && o.build === 2)
    || opts.find((o) => o.type === 'buy')
    || opts.find((o) => o.type === 'build')
    || opts.find((o) => o.type === 'payDebt')
    || opts.find((o) => o.type === 'payJail')
    || opts.find((o) => o.type === 'useCard')
    || opts.find((o) => o.type === 'acceptOffer')
    || opts.find((o) => o.type === 'end')
    || opts.find((o) => o.type === 'skip')
    || opts[0];

  const ws = wsOf(actorId);
  if (!ws || ws.readyState !== 1) { await sleep(100); continue; }
  ws.send(JSON.stringify({ t: 'act', action: pick }));
  acts++;
  await sleep(90);
  for (const ev of room.game.events || []) seen.set(ev.k, (seen.get(ev.k) || 0) + 1);
  if (room.showing) { played(); await sleep(40); }
}

const g = room.game;
const owned = (g?.players || []).map((p) => {
  const mine = Object.values(g.props).filter((x) => x.owner === p.id);
  return `${p.name}:${mine.length}块/${mine.reduce((a, x) => a + (x.houses || 0), 0)}房`;
});
console.log(`动作数 ${acts} | status=${g?.status} round=${g?.round}`);
console.log(`资产 ${owned.join(' | ')}`);
console.log(`现金 ${g?.players.map((p) => `${p.name}$${p.cash}`).join(' ')} | 银行 out=$${g?.bankOut} in=$${g?.bankIn}`);
console.log(`事件覆盖 ${[...seen.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}`);

const ok = g?.status === 'ended' && seen.has('dice') && seen.has('move');
console.log(ok ? '\n✅ 通过' : '\n❌ 未跑通');
screen.close(); A.close(); B.close();
process.exit(ok ? 0 : 1);
