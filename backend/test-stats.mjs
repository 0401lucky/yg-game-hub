// 战绩链路验证：模拟一局结束写入 → 经 HTTP 读回账号战绩
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3001';

let cookie = '';
const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

async function call(p, body, method = 'POST') {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('ac_session=')) cookie = kv;
  }
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const stamp = Date.now().toString(36).slice(-5);
const username = `stat_${stamp}`;

let r = await call('/api/auth/register', { username, password: 'stat123456', nickname: '战绩号' });
ok('注册测试账号', r.status === 200, `id=${r.json?.user?.id}`);
const userId = r.json.user.id;

// 在独立进程里写一条战绩（模拟对局结束时服务端的落库动作）
const script = `
const auth = require(${JSON.stringify(path.join(__dirname, 'auth.cjs'))});
const id = auth.recordMatch({
  roomCode: 'TST9',
  mode: 'classic',
  players: [
    { userId: ${userId}, playerId: 'player_a', nickname: '战绩号', color: 1 },
    { userId: null, playerId: 'player_b', nickname: '路人', color: 2 }
  ],
  winnerColor: 1,
  durationMs: 123000
});
console.log('matchId=' + id);
`;
const out = execFileSync(process.execPath, ['-e', script], { cwd: projectRoot, encoding: 'utf8' });
ok('对局记录写入成功', /matchId=\d+/.test(out), out.trim().split('\n').pop());

r = await call('/api/me/stats', null, 'GET');
const stats = r.json?.stats || {};
ok('战绩读回：对局数 +1', stats.games === 1, `games=${stats.games}`);
ok('战绩读回：胜场 +1', stats.wins === 1, `wins=${stats.wins}`);
ok('战绩读回：胜率 100%', stats.winRate === 100, `winRate=${stats.winRate}`);
ok('战绩读回：最近一局房间号', stats.recent?.[0]?.roomCode === 'TST9', JSON.stringify(stats.recent?.[0]));
ok('战绩读回：胜负标记', stats.recent?.[0]?.isWinner === true);

// 再补一局失败，验证胜率计算
const script2 = `
const auth = require(${JSON.stringify(path.join(__dirname, 'auth.cjs'))});
auth.recordMatch({
  roomCode: 'TST8', mode: 'skill',
  players: [{ userId: ${userId}, playerId: 'player_a', nickname: '战绩号', color: 3 }],
  winnerColor: 1, durationMs: 60000
});
`;
execFileSync(process.execPath, ['-e', script2], { cwd: projectRoot, encoding: 'utf8' });

r = await call('/api/me/stats', null, 'GET');
const s2 = r.json?.stats || {};
ok('两局后统计正确', s2.games === 2 && s2.wins === 1 && s2.winRate === 50,
   `games=${s2.games} wins=${s2.wins} winRate=${s2.winRate}`);

// 匿名对局不写库（players 全部无 userId 时应静默跳过）
const script3 = `
const auth = require(${JSON.stringify(path.join(__dirname, 'auth.cjs'))});
const id = auth.recordMatch({
  roomCode: 'ANON', mode: 'classic',
  players: [{ playerId: 'player_z', nickname: '没有账号', color: 1 }],
  winnerColor: 1, durationMs: 1000
});
console.log('matchId=' + id);
`;
const out3 = execFileSync(process.execPath, ['-e', script3], { cwd: projectRoot, encoding: 'utf8' });
ok('全匿名对局不落库', out3.includes('matchId=null'), out3.trim());

const failed = results.filter((x) => !x.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
