/**
 * 大厅 ↔ 大富翁（聚会模式）粘合层
 *
 * 大富翁的服务端房间逻辑是原生 ESM（games/monopoly/party.mjs），大厅是 CJS。
 * 这里用动态 import 把它预加载进来，之后每条连接都同步交给它处理：
 * 同一个 WebSocket 端口按 query 分流 —— ?party=screen 是大屏，?party=phone 是手机。
 *
 * 只做三件事：预加载、判定路由、转交连接。房间/规则/时钟全在 party.mjs 与 engine.js 里。
 */
const path = require('path');
const { pathToFileURL } = require('url');
const auth = require('./auth.cjs');

const PARTY_ENTRY = path.resolve(__dirname, '../games/monopoly/party.mjs');

let party = null;
let loading = null;
let port = Number(process.env.PORT || 3001);

// 一局打完 → 只把登录过的座位写进战绩表（全匿名对局不落库，和飞行棋一致）
function recordSettlement(payload) {
  const winnerSeat = payload.seats.find((s) => s.id === payload.winnerId) || null;
  auth.recordMatch({
    gameId: 'monopoly',
    roomCode: payload.roomCode,
    mode: payload.mode,
    players: payload.seats.map((s) => ({
      userId: s.userId,
      playerId: s.id,
      nickname: s.name,
      color: s.color,
    })),
    winnerColor: winnerSeat ? winnerSeat.color : null,
    durationMs: payload.durationMs,
  });
}

function load() {
  if (party) return Promise.resolve(party);
  if (!loading) {
    loading = import(pathToFileURL(PARTY_ENTRY).href)
      .then((mod) => {
        party = mod;
        if (typeof party.setPort === 'function') party.setPort(port);
        if (typeof party.setSettlementHandler === 'function') party.setSettlementHandler(recordSettlement);
        console.log('[大富翁] 聚会模式房间已加载');
        return mod;
      })
      .catch((err) => {
        console.error('[大富翁] 加载失败，聚会模式不可用:', err.message);
        loading = null;
        return null;
      });
  }
  return loading;
}

function paramsOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** 这条连接是不是大富翁的（大屏/手机都带 ?party=） */
function handles(req) {
  const q = paramsOf(req);
  return Boolean(q.get('party'));
}

/** 交给大富翁处理；参数与上游一致（party/room/key/token/claim）,另外把登录账号带进去 */
function attach(ws, req) {
  if (!party) {
    ws.close(1011, 'monopoly not ready');
    return;
  }
  let account = null;
  try {
    account = auth.userFromCookieHeader(req && req.headers ? req.headers.cookie : '');
  } catch (err) {
    console.error('[大富翁] 握手解析身份失败:', err.message);
  }
  party.connect(ws, paramsOf(req), account);
}

function setPort(p) {
  port = Number(p) || port;
  if (party && typeof party.setPort === 'function') party.setPort(port);
}

module.exports = { load, handles, attach, setPort };
