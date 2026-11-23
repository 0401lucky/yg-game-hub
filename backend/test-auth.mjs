// 账号 API + WS 身份绑定验证
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3001';
let cookie = '';
const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

async function call(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const kv = c.split(';')[0];
    if (kv.startsWith('ac_session=')) cookie = kv;
  }
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const stamp = Date.now().toString(36).slice(-5);
const username = `yg_${stamp}`;
const password = 'yg123456';

// 1 注册
let r = await call('/api/auth/register', { username, password, nickname: 'YG' });
ok('注册成功', r.status === 200 && r.json?.user?.username === username, `status=${r.status}`);
ok('注册下发会话 Cookie', cookie.startsWith('ac_session='));
ok('注册返回昵称', r.json?.user?.nickname === 'YG');

// 2 me
r = await call('/api/auth/me', null, 'GET');
ok('Cookie 识别身份', r.json?.user?.username === username);

// 3 重复注册
r = await call('/api/auth/register', { username, password });
ok('重复用户名被拒', r.status === 409, r.json?.error);

// 4 错误密码
const savedCookie = cookie;
cookie = '';
r = await call('/api/auth/login', { username, password: 'wrongpass' });
ok('错误密码被拒', r.status === 401, r.json?.error);

// 5 正确登录
r = await call('/api/auth/login', { username, password });
ok('登录成功', r.status === 200 && r.json?.user?.username === username);
ok('登录下发 Cookie', cookie.startsWith('ac_session='));

// 6 弱密码
cookie = savedCookie;
r = await call('/api/auth/register', { username: `x_${stamp}`, password: '123' });
ok('弱密码被拒', r.status === 400, r.json?.error);

// 7 战绩
r = await call('/api/me/stats', null, 'GET');
ok('战绩接口返回', r.status === 200 && r.json?.stats && typeof r.json.stats.games === 'number',
   `games=${r.json?.stats?.games} wins=${r.json?.stats?.wins}`);

// 8 未登录访问战绩
const anon = await fetch(BASE + '/api/me/stats');
ok('未登录访问战绩被拦', anon.status === 401);

// 9 WS：带 Cookie 建房，昵称应取账号昵称而非客户端传的昵称
const ws = new WebSocket('ws://127.0.0.1:3001', { headers: { Cookie: cookie } });
const inbox = [];
ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch {} });
await new Promise((res) => ws.on('open', res));
ws.send(JSON.stringify({ type: 'createRoom', nickname: '客户端伪造昵称' }));
await new Promise((r) => setTimeout(r, 1200));
const created = inbox.find((m) => m.type === 'roomCreated');
const hostNick = created?.room?.players?.[0]?.nickname;
ok('WS 握手识别账号并覆盖昵称', hostNick === 'YG', `房间=${created?.room?.code} 昵称=${hostNick}`);

// 10 无 Cookie 的 WS 仍可匿名建房
const anonWs = new WebSocket('ws://127.0.0.1:3001');
const anonInbox = [];
anonWs.on('message', (raw) => { try { anonInbox.push(JSON.parse(raw.toString())); } catch {} });
await new Promise((res) => anonWs.on('open', res));
anonWs.send(JSON.stringify({ type: 'createRoom', nickname: '路人甲' }));
await new Promise((r) => setTimeout(r, 1000));
const anonCreated = anonInbox.find((m) => m.type === 'roomCreated');
ok('匿名仍可建房（不强制登录）', anonCreated?.room?.players?.[0]?.nickname === '路人甲');

// 11 篡改 token 应失效
const bad = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
const badRes = await fetch(BASE + '/api/auth/me', { headers: { Cookie: bad } });
const badJson = await badRes.json();
ok('篡改签名后身份失效', badJson?.user === null);

ws.close(); anonWs.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
