import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Express, Request } from 'express';
import type { AccountSocket } from './gameModule.ts';
import type { AccountMatch, AccountStats, PublicUser, PlayerId } from '../games/shared/protocol.ts';
import { DATA_DIR } from './config.ts';
import { errorMessage } from '../games/shared/errors.ts';
import { readMinesweeperStats } from './minesweeper-stats.ts';
import type { GameStats } from '../games/minesweeper/types.ts';
export interface UserRow { id: number; username: string; nickname: string; pass_hash: string; created_at: string; last_login_at: string | null }
interface TokenPayload { uid: number; exp: number }
export type MinesweeperStats = GameStats;
/**
 * 账号系统（零额外依赖）
 *
 * - 存储：Node 内置 node:sqlite（Node >= 22.5），单文件 backend/data/app.db
 * - 密码：scrypt + 随机盐
 * - 会话：HMAC 签名 Cookie（ac_session），HttpOnly + SameSite=Lax
 * - 战绩：matches / match_players 两张表
 *
 * 设计原则：本模块任何异常都不得影响对局本身，调用方全部 try/catch 兜住。
 */

const DB_FILE = path.join(DATA_DIR, 'app.db');
const SECRET_FILE = path.join(DATA_DIR, 'session-secret.txt');

const COOKIE_NAME = 'ac_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

let db: DatabaseSync;
let secret = '';
export let enabled = false;

export function close(): void {
  if (enabled) db.close();
  enabled = false;
}

// -------------------------- 初始化 --------------------------

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  ensureDir();
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (saved) return saved;
    }
  } catch (err) {
    console.error('[账号] 读取会话密钥失败:', errorMessage(err));
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  } catch (err) {
    console.error('[账号] 写入会话密钥失败:', errorMessage(err));
  }
  return generated;
}

function migrate() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
      pass_hash     TEXT NOT NULL,
      nickname      TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS matches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code      TEXT,
      mode           TEXT,
      player_count   INTEGER NOT NULL DEFAULT 0,
      winner_user_id INTEGER,
      duration_ms    INTEGER,
      ended_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_players (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL,
      player_id  TEXT,
      nickname   TEXT,
      color      INTEGER,
      is_winner  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);
    CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
    CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at);
  `);

  // 兼容旧库：多游戏化之前没有 game_id 列
  try {
    const cols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
    if (!cols.includes('game_id')) {
      db.exec("ALTER TABLE matches ADD COLUMN game_id TEXT NOT NULL DEFAULT 'flight'");
      console.log('[账号] 迁移：matches 增加 game_id 列');
    }
  } catch (err) {
    console.error('[账号] 迁移 game_id 失败:', errorMessage(err));
  }
}

export function init() {
  if (!DatabaseSync) return false;
  try {
    ensureDir();
    db = new DatabaseSync(DB_FILE);
    migrate();
    secret = loadSecret();
    enabled = true;
    console.log(`[账号] SQLite 就绪: ${DB_FILE}`);
    return true;
  } catch (err) {
    console.error('[账号] 初始化失败，账号功能关闭:', errorMessage(err));
    enabled = false;
    return false;
  }
}

// -------------------------- 密码 --------------------------

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// -------------------------- 会话 token --------------------------

function b64url(buf: string | Uint8Array) {
  return (typeof buf === 'string' ? Buffer.from(buf) : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function sign(payloadB64: string) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function issueToken(userId: number) {
  const payloadB64 = b64url(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS }));
  return `${payloadB64}.${sign(payloadB64)}`;
}

function readToken(token: unknown) : TokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = sign(payloadB64);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(fromB64url(payloadB64).toString('utf8')) as TokenPayload;
    if (!payload || typeof payload.uid !== 'number') return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// -------------------------- Cookie --------------------------

function parseCookies(header: string | null | undefined) {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function buildSessionCookie(token: string, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

// -------------------------- 用户读写 --------------------------

function findUserById(id: number) : UserRow | null {
  if (!enabled) return null;
  try {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow || null;
  } catch {
    return null;
  }
}

function findUserByName(username: string) : UserRow | null {
  if (!enabled) return null;
  try {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username)) as unknown as UserRow || null;
  } catch {
    return null;
  }
}

function publicUser(row: UserRow | null | undefined) : PublicUser | null {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    createdAt: row.created_at,
  };
}

function userFromCookieHeader(header: string | null | undefined) {
  if (!enabled || !secret) return null;
  try {
    const cookies = parseCookies(header);
    const payload = readToken(cookies[COOKIE_NAME]);
    if (!payload) return null;
    return findUserById(payload.uid);
  } catch {
    return null;
  }
}

// playerId → userId 的内存索引，只在对局期间有意义
const playerIdToUserId: Map<PlayerId, number> = new Map();

function rememberPlayer(playerId: PlayerId, userId: number) {
  if (!playerId || !userId) return;
  playerIdToUserId.set(playerId, userId);
}

function userIdOfPlayer(playerId: PlayerId) {
  return playerIdToUserId.get(playerId) || null;
}

function nicknameForRequest(ws: AccountSocket | null, fallback: string | null | undefined) {
  const account = ws && ws.user;
  if (account && account.nickname) return account.nickname;
  return fallback;
}

// -------------------------- 战绩写入 --------------------------

function recordMatch({ gameId = 'flight', roomCode, mode, players, winnerColor, winnerColors, durationMs }: AccountMatch) {
  if (!enabled || !Array.isArray(players) || !players.length) return null;
  try {
    const withUser = players
      .map((p) => ({ ...p, userId: p.userId || userIdOfPlayer(p.playerId) }))
      .filter((p) => p.userId);
    if (!withUser.length) return null;

    const winningColors = new Set((Array.isArray(winnerColors) ? winnerColors : winnerColor == null ? [] : [winnerColor]).map(Number));
    const winner = withUser.find((p) => winningColors.has(Number(p.color)));
    const endedAt = new Date().toISOString();
    const info = db
      .prepare(
        'INSERT INTO matches (game_id, room_code, mode, player_count, winner_user_id, duration_ms, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        gameId || 'flight',
        roomCode || null,
        mode || 'classic',
        players.length,
        winner ? winner.userId! : null,
        Number.isFinite(durationMs) ? Math.round(durationMs!) : null,
        endedAt
      );
    const matchId = Number(info.lastInsertRowid);

    const insert = db.prepare(
      'INSERT INTO match_players (match_id, user_id, player_id, nickname, color, is_winner) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const p of withUser) {
      insert.run(
        matchId,
        p.userId!,
        p.playerId || null,
        p.nickname || null,
        Number.isFinite(Number(p.color)) ? Number(p.color) : null,
        winningColors.has(Number(p.color)) ? 1 : 0
      );
    }
    console.log(`[战绩] 记录对局 #${matchId} 房间 ${roomCode || '-'} 参与账号 ${withUser.length}`);
    return matchId;
  } catch (err) {
    console.error('[战绩] 写入失败:', errorMessage(err));
    return null;
  }
}

function statsOf(userId: number) : AccountStats | null {
  if (!enabled) return null;
  try {
    const total = db.prepare('SELECT COUNT(*) AS c FROM match_players WHERE user_id = ?').get(userId);
    const wins = db
      .prepare('SELECT COUNT(*) AS c FROM match_players WHERE user_id = ? AND is_winner = 1')
      .get(userId);
    const recent = db
      .prepare(
        `SELECT m.id, m.game_id, m.room_code, m.mode, m.player_count, m.ended_at, mp.is_winner, mp.color
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ? ORDER BY m.id DESC LIMIT 10`
      )
      .all(userId);
    const byGame = db
      .prepare(
        `SELECT m.game_id AS gameId,
                COUNT(*) AS games,
                SUM(CASE WHEN mp.is_winner = 1 THEN 1 ELSE 0 END) AS wins
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ? GROUP BY m.game_id`
      )
      .all(userId);
    const games = Number(total?.c || 0);
    const winCount = Number(wins?.c || 0);
    return {
      games,
      wins: winCount,
      winRate: games ? Math.round((winCount / games) * 100) : 0,
      byGame: byGame.map((g) => ({
        gameId: String(g.gameId) || 'flight',
        games: Number(g.games || 0),
        wins: Number(g.wins || 0),
      })),
      recent: recent.map((r) => ({
        matchId: Number(r.id),
        gameId: String(r.game_id || 'flight'),
        roomCode: r.room_code as string | null,
        mode: r.mode as string | null,
        playerCount: Number(r.player_count),
        endedAt: String(r.ended_at),
        isWinner: Boolean(r.is_winner),
        color: r.color as number | null,
      })),
    };
  } catch (err) {
    console.error('[战绩] 查询失败:', errorMessage(err));
    return null;
  }
}

function minesweeperStatsOf(userId: number) : MinesweeperStats | null {
  if (!enabled) return null;
  return readMinesweeperStats(db, userId);
}

// -------------------------- 限流 --------------------------

/**
 * 真实客户端 IP：服务在 Cloudflare 隧道 / 反向代理之后时 req.ip 恒为 127.0.0.1，
 * 直接用它会把全站用户算成同一个人，限流会误伤。
 */
function clientIp(req: Request) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || 'unknown';
}

const attempts: Map<string, { count: number; resetAt: number }> = new Map(); // key → { count, resetAt }

function tooManyAttempts(key: string, limit = 8, windowMs = 60 * 1000) {
  const now = Date.now();
  const item = attempts.get(key);
  if (!item || now > item.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  item.count += 1;
  return item.count > limit;
}

// -------------------------- 路由 --------------------------

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

function cleanText(value: unknown, max = 20) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function mountAuthRoutes(app: Express) {
  if (!enabled) {
    app.get('/api/auth/me', (req, res) => res.json({ success: true, enabled: false, user: null }));
    return;
  }

  app.post('/api/auth/register', (req, res) => {
    try {
      const ip = clientIp(req);
      if (tooManyAttempts(`reg:${ip}`)) {
        return res.status(429).json({ success: false, error: '操作太频繁，请稍后再试' });
      }
      const username = cleanText(req.body?.username, 20);
      const password = String(req.body?.password || '');
      const nickname = cleanText(req.body?.nickname, 16) || username;

      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ success: false, error: '用户名需 2-20 位，仅支持中英文、数字、下划线' });
      }
      if (password.length < 6 || password.length > 72) {
        return res.status(400).json({ success: false, error: '密码长度需 6-72 位' });
      }
      if (findUserByName(username)) {
        return res.status(409).json({ success: false, error: '该用户名已被注册' });
      }

      const info = db
        .prepare('INSERT INTO users (username, pass_hash, nickname, created_at) VALUES (?, ?, ?, ?)')
        .run(username, hashPassword(password), nickname, new Date().toISOString());
      const row = findUserById(Number(info.lastInsertRowid))!;

      res.setHeader('Set-Cookie', buildSessionCookie(issueToken(row.id)));
      res.json({ success: true, user: publicUser(row), stats: statsOf(row.id) });
    } catch (err) {
      console.error('[账号] 注册失败:', errorMessage(err));
      res.status(500).json({ success: false, error: '注册失败，请稍后再试' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const ip = clientIp(req);
      const username = cleanText(req.body?.username, 20);
      if (tooManyAttempts(`login:${ip}:${username}`)) {
        return res.status(429).json({ success: false, error: '尝试次数过多，请 1 分钟后再试' });
      }
      const password = String(req.body?.password || '');
      const row = findUserByName(username);
      if (!row || !verifyPassword(password, row.pass_hash)) {
        return res.status(401).json({ success: false, error: '用户名或密码错误' });
      }
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      res.setHeader('Set-Cookie', buildSessionCookie(issueToken(row.id)));
      res.json({ success: true, user: publicUser(row), stats: statsOf(row.id) });
    } catch (err) {
      console.error('[账号] 登录失败:', errorMessage(err));
      res.status(500).json({ success: false, error: '登录失败，请稍后再试' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ success: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const row = userFromCookieHeader(req.headers.cookie);
    if (!row) return res.json({ success: true, enabled: true, user: null });
    res.json({ success: true, enabled: true, user: publicUser(row), stats: statsOf(row.id) });
  });

  app.get('/api/me/stats', (req, res) => {
    const row = userFromCookieHeader(req.headers.cookie);
    if (!row) return res.status(401).json({ success: false, error: '未登录' });
    res.json({ success: true, user: publicUser(row), stats: statsOf(row.id) });
  });

  console.log('[账号] 路由已挂载: /api/auth/{register,login,logout,me} /api/me/stats');
}

// -------------------------- 导出 --------------------------

export { publicUser, userFromCookieHeader, rememberPlayer, userIdOfPlayer, nicknameForRequest, recordMatch, statsOf, minesweeperStatsOf, mountAuthRoutes, parseCookies };
