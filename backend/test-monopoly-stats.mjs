// 大富翁战绩链路验证：登录用户扫码进房 → 打完一局 → 战绩进 /api/me/stats
//
//   node backend/test-monopoly-stats.mjs
//
// 第一局：登录用户 vs 匿名，打到自然结束，验证只记登录过的座位。
// 第二局：对手认输，验证「赢」也记到本人头上。
import WebSocket from 'ws';
import { legalActions } from '../games/monopoly/shared/engine.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const WS_BASE = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const all = [];
const ok = (name, cond, extra = '') => {
  all.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

let cookie = '';
async function api(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('ac_session=')) cookie = kv;
  }
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/**
 * 连接 + 消息队列：服务器的第一条消息可能在 open 回调之前就到，
 * 所以先挂监听、把消息存起来，wait 时先查队列再等新的。
 */
function connect(qs, withCookie) {
  const ws = new WebSocket(`${WS_BASE}/ws?${qs}`, withCookie ? { headers: { Cookie: cookie } } : undefined);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'error' && !/轮到你/.test(m.msg)) console.log('  [ws]', m.msg);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.to);
        w.res(m);
        return;
      }
    }
    queue.push(m);
  });
  const wait = (pred, t = 8000) => {
    const idx = queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred, res };
      w.to = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        rej(new Error(`timeout: 等不到期望的消息（${pred}）`));
      }, t);
      waiters.push(w);
    });
  };
  const opened = new Promise((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  return { ws, wait, opened };
}

// ---------- 账号 ----------
const stamp = Date.now().toString(36).slice(-5);
const username = `mp_${stamp}`;
const password = 'yg123456';
const nickname = `大富翁${stamp.slice(-2)}`;

let r = await api('/api/auth/register', { username, password, nickname });
if (r.status !== 200) { console.error('注册失败', r.status, r.json); process.exit(1); }
const before = (await api('/api/me/stats', null, 'GET')).json?.stats || { games: 0, wins: 0 };
console.log(`账号 ${username}（${nickname}）已注册，当前战绩 ${before.games} 局 / ${before.wins} 胜\n`);

// 驱动一局到结束（不抢大屏的活，只负责按合法动作点按钮）
// 公网有延迟，用轮询等「新局面」而不是固定 sleep
async function driveToEnd(roomRef, screen, onAct, maxActs = 200) {
  const played = () => screen.ws.send(JSON.stringify({ t: 'played', seq: roomRef.room.game.seq }));
  const poll = async (pred, timeout = 8000, step = 60) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(step);
    }
    return false;
  };
  if (roomRef.room.showing) played();
  let acts = 0;
  for (let guard = 0; guard < 8000 && acts < maxActs; guard++) {
    const g = roomRef.room.game;
    if (!g || g.status !== 'playing') break;
    if (roomRef.room.showing) { played(); await poll(() => !roomRef.room.showing, 6000); continue; }
    if (roomRef.room.waitingFor) {
      const w = onAct.wsOf(roomRef.room.waitingFor.pid);
      w?.send(JSON.stringify({ t: 'ack' }));
      await sleep(80);
      continue;
    }
    const actorId = g.pending?.pid || g.players[g.order[g.turnIdx]].id;
    const opts = legalActions(g, actorId);
    if (!opts.length) { await sleep(80); continue; }
    const pick = opts.find((o) => o.type === 'roll')
      || opts.find((o) => o.type === 'buy' && o.build === 2)
      || opts.find((o) => o.type === 'buy')
      || opts.find((o) => o.type === 'build')
      || opts.find((o) => o.type === 'payDebt')
      || opts.find((o) => o.type === 'payJail')
      || opts.find((o) => o.type === 'useCard')
      || opts.find((o) => o.type === 'end')
      || opts.find((o) => o.type === 'skip')
      || opts[0];
    const ws = onAct.wsOf(actorId);
    if (!ws || ws.readyState !== 1) { await sleep(100); continue; }
    const seqBefore = g.seq;
    ws.send(JSON.stringify({ t: 'act', action: pick }));
    acts++;
    await poll(() => roomRef.room.game.seq !== seqBefore || roomRef.room.game.status !== 'playing', 8000);
    if (roomRef.room.showing) { played(); await poll(() => !roomRef.room.showing, 6000); }
  }
  return acts;
}

// ---------- 第一局：登录 vs 匿名 ----------
console.log('--- 第一局：登录座位 vs 匿名座位 ---');
const roomRef = { room: null };
const screen = connect('party=screen', false);
screen.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'room') roomRef.room = m.room; });
const hello = await screen.wait((m) => m.t === 'screen');
const code = hello.code;

async function phone(avatar, withCookie) {
  const c = connect(`party=phone&room=${code}`, withCookie);
  const tok = await c.wait((m) => m.t === 'token');
  await c.opened;
  c.ws.send(JSON.stringify({ t: 'pick', code: avatar }));
  c.ws.send(JSON.stringify({ t: 'ready', v: true }));
  return { ...c, token: tok.token, account: tok.account };
}
const A = await phone('1f436', true);    // 登录用户：小狗
const B = await phone('1f43c', false);   // 匿名：熊猫
ok('登录手机收到账号名', A.account?.name === nickname, JSON.stringify(A.account));
ok('匿名手机没有账号', B.account === null);
await sleep(300);

screen.ws.send(JSON.stringify({ t: 'start' }));
await sleep(400);
ok('开局成功', roomRef.room?.game?.status === 'playing', `status=${roomRef.room?.game?.status}`);

const wsOf = (pid) => {
  const p = roomRef.room.game.players.find((x) => x.id === pid);
  return p?.avatar === '1f436' ? A.ws : B.ws;
};
const acts = await driveToEnd(roomRef, screen, { wsOf });
const g = roomRef.room.game;
const seatA = roomRef.room.seats.find((s) => s.avatar === '1f436');
const aWon = g?.winner && seatA && g.winner === seatA.id;
ok('对局打到结束', g?.status === 'ended', `acts=${acts} status=${g?.status}`);
console.log(`  赢家 ${g?.winner}（小狗=${seatA?.id}）→ 登录用户${aWon ? '获胜' : '落败'}`);

await sleep(700);
const stats = (await api('/api/me/stats', null, 'GET')).json?.stats;
ok('能读到战绩', !!stats);
ok('总局数 +1', stats?.games === before.games + 1, `${before.games} → ${stats?.games}`);
const mp = stats?.byGame?.find((x) => x.gameId === 'monopoly');
ok('按游戏统计里有 monopoly', !!mp && mp.games >= 1, JSON.stringify(mp));
ok('最近一局是大富翁', stats?.recent?.[0]?.gameId === 'monopoly', JSON.stringify(stats?.recent?.[0]));
ok('胜负记录正确', (mp?.wins || 0) === (aWon ? 1 : 0), `wins=${mp?.wins}`);
ok('房间码带上', stats?.recent?.[0]?.roomCode === code, `${stats?.recent?.[0]?.roomCode} vs ${code}`);

screen.ws.close(); A.ws.close(); B.ws.close();
await sleep(200);

// ---------- 第二局：对手认输，赢家必须是本人 ----------
console.log('\n--- 第二局：对手认输 → 验证胜场记账 ---');
const room2 = { room: null };
const screen2 = connect('party=screen', true);
screen2.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'room') room2.room = m.room; });
const hello2 = await screen2.wait((m) => m.t === 'screen');
const code2 = hello2.code;

async function phone2(avatar, withCookie) {
  const c = connect(`party=phone&room=${code2}`, withCookie);
  await c.wait((m) => m.t === 'token');
  await c.opened;
  c.ws.send(JSON.stringify({ t: 'pick', code: avatar }));
  c.ws.send(JSON.stringify({ t: 'ready', v: true }));
  return c;
}
const A2 = await phone2('1f436', true);
const B2 = await phone2('1f43c', false);
await sleep(300);
screen2.ws.send(JSON.stringify({ t: 'start' }));
await sleep(400);
ok('第二局开局', room2.room?.game?.status === 'playing');
screen2.ws.send(JSON.stringify({ t: 'played', seq: room2.room.game.seq }));
await sleep(200);

const me2 = room2.room.seats.find((s) => s.avatar === '1f436');
const rival2 = room2.room.seats.find((s) => s.avatar === '1f43c');
B2.ws.send(JSON.stringify({ t: 'act', action: { type: 'resign' } }));
for (let i = 0; i < 60 && room2.room?.game?.status === 'playing'; i++) {
  await sleep(150);
  if (room2.room.showing) screen2.ws.send(JSON.stringify({ t: 'played', seq: room2.room.game.seq }));
  if (room2.room.waitingFor) A2.ws.send(JSON.stringify({ t: 'ack' }));
}
ok('对手认输后对局结束', room2.room?.game?.status === 'ended', `status=${room2.room?.game?.status}`);
ok('赢家是本人', room2.room?.game?.winner === me2?.id, `winner=${room2.room?.game?.winner} me=${me2?.id} rival=${rival2?.id}`);

await sleep(700);
const after = (await api('/api/me/stats', null, 'GET')).json?.stats;
const mp2 = after?.byGame?.find((x) => x.gameId === 'monopoly');
ok('总局数再 +1', after?.games === (stats?.games || 0) + 1, `${stats?.games} → ${after?.games}`);
ok('胜场记到本人', (mp2?.wins || 0) >= 1, JSON.stringify(mp2));
ok('最近一局标记为胜', after?.recent?.[0]?.isWinner === true, JSON.stringify(after?.recent?.[0]));

screen2.ws.close(); A2.ws.close(); B2.ws.close();
const failed = all.filter((x) => !x.pass).length;
console.log(`\n===== ${all.length - failed}/${all.length} 通过 =====`);
process.exit(failed ? 1 : 0);
