import crypto from 'node:crypto';
import express from 'express';
import type { Express, Request, RequestHandler } from 'express';
import type { DailyStats } from '../../../backend/dailyStats.ts';
import * as engine from '../engine.ts';
import type { AccountUser, AuthAdapter, WatermelonActiveSession, WatermelonLimits, WatermelonResult, WatermelonSegment, WatermelonSessionResponse, WatermelonSnapshot, WatermelonStats, WatermelonStatus } from '../protocol.ts';

export const LIMITS: WatermelonLimits = { max_segment_ticks: 240, max_drops: 32, max_bodies: engine.MAX_BODIES };
const COOKIE_NAME = 'yg_watermelon_guest';
const SESSION_TTL = 24 * 60 * 60 * 1000;
interface Session {
  id: string; startRequest: string; seed: string; state: WatermelonSnapshot;
  user: AccountUser | null; createdAt: number; touchedAt: number; paused: boolean;
  result: WatermelonResult | null;
  requests: Map<string, string>;
}
interface ServiceOptions {
  auth?: AuthAdapter | null; now?: () => number; seedFactory?: () => string;
  maxSessions?: number; ttl?: number; stats?: DailyStats;
}
interface Identity { owner: string; guestOwner: string; user: AccountUser | null }
interface MelonRequest extends Request { melonIdentity: Identity }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);

export class WatermelonError extends Error {
  readonly status: number;
  readonly session: WatermelonActiveSession | null;
  constructor(status: number, message: string, session: WatermelonActiveSession | null = null) {
    super(message); this.status = status; this.session = session;
  }
}

export class WatermelonService {
  readonly auth: AuthAdapter | null;
  readonly now: () => number;
  readonly seedFactory: () => string;
  readonly maxSessions: number;
  readonly ttl: number;
  readonly sessions = new Map<string, Session>();
  private readonly starts = new Map<string, { count: number; resetAt: number }>();
  private readonly dailyStats: DailyStats | undefined;
  constructor({ auth = null, now = Date.now, seedFactory = () => crypto.randomBytes(24).toString('hex'), maxSessions = 1000, ttl = SESSION_TTL, stats }: ServiceOptions = {}) {
    this.auth = auth; this.now = now; this.seedFactory = seedFactory;
    this.maxSessions = maxSessions; this.ttl = ttl; this.dailyStats = stats;
  }

  prune(): void {
    const now = this.now();
    for (const [owner, session] of this.sessions) if (now - session.touchedAt >= this.ttl) this.sessions.delete(owner);
    for (const [owner, entry] of this.starts) if (now >= entry.resetAt) this.starts.delete(owner);
  }
  stats(userId?: number): WatermelonStats | null {
    try { return userId ? this.auth?.watermelonStatsOf?.(userId) ?? null : null; }
    catch (error) { console.error('[西瓜] 战绩查询失败:', error instanceof Error ? error.message : String(error)); return null; }
  }
  view(session: Session): WatermelonActiveSession {
    return {
      session_id: session.id, seed: session.seed, engine_version: engine.VERSION, tick_rate: engine.TICK_RATE,
      limits: { ...LIMITS }, base_tick: session.state.tick, base_moves: session.state.drops,
      state: structuredClone(session.state), paused: session.paused,
      result: session.result ? { ...session.result } : null,
      expires_at: new Date(session.touchedAt + this.ttl).toISOString(),
    };
  }
  adoptGuest(owner: string, user: AccountUser | null, guestOwner: string): void {
    const current = this.sessions.get(owner);
    if (!user || (current && !current.result)) return;
    const guest = this.sessions.get(guestOwner);
    if (!guest || guest.result || guest.state.phase !== 'playing') return;
    guest.user = { id: user.id, nickname: user.nickname || user.username || '果园玩家' };
    this.sessions.set(owner, guest); this.sessions.delete(guestOwner);
  }
  status(owner: string, user: AccountUser | null = null, guestOwner = owner): WatermelonStatus {
    this.prune(); this.adoptGuest(owner, user, guestOwner);
    const session = this.sessions.get(owner);
    if (session) session.touchedAt = this.now();
    return { active_session: session ? this.view(session) : null, stats: this.stats(user?.id) };
  }
  start(owner: string, user: AccountUser | null, input: unknown = {}): WatermelonSessionResponse {
    this.prune();
    const body = object(input);
    if (!requestId(body.request_id)) throw new WatermelonError(400, '操作编号无效');
    const current = this.sessions.get(owner);
    if (current?.startRequest === body.request_id) return { session: this.view(current) };
    if (current && !current.result && current.state.drops > 0 && body.replace_session_id !== current.id) {
      throw new WatermelonError(409, '这局还没结束，请先确认重新开始', this.view(current));
    }
    if (!current && this.sessions.size >= this.maxSessions) throw new WatermelonError(503, '果园暂时满员，请稍后再试');
    const now = this.now();
    const limit = this.starts.get(owner) ?? { count: 0, resetAt: now + 60000 };
    this.starts.set(owner, limit);
    if (++limit.count > 30) throw new WatermelonError(429, '开局太频繁了，请稍等片刻');
    const seed = this.seedFactory();
    const session: Session = {
      id: crypto.randomUUID(), startRequest: body.request_id, seed, state: engine.initial(seed),
      user: user ? { id: user.id, nickname: user.nickname || user.username || '果园玩家' } : null,
      createdAt: now, touchedAt: now, paused: false, result: null, requests: new Map(),
    };
    this.sessions.set(owner, session);
    this.dailyStats?.recordPlayerConnected(`melon_${crypto.createHash('sha256').update(owner).digest('hex')}`);
    this.dailyStats?.recordGameStarted();
    return { session: this.view(session) };
  }
  checkpoint(owner: string, input: unknown, finish = false): WatermelonSessionResponse {
    this.prune();
    const body = object(input);
    const session = this.sessions.get(owner);
    if (!session || body.session_id !== session.id) throw new WatermelonError(404, '这局记录已过期，请重新开始');
    if (!requestId(body.request_id)) throw new WatermelonError(400, '操作编号无效');
    const signature = JSON.stringify([finish, body.base_tick, body.base_moves, body.to_tick, body.drops, body.paused]);
    const cached = session.requests.get(body.request_id);
    if (cached) {
      if (cached !== signature) throw new WatermelonError(400, '同一操作不能修改内容');
      return { session: this.view(session), ...(finish ? { stats: this.stats(session.user?.id) } : {}) };
    }
    if (session.result) {
      if (!finish) throw new WatermelonError(409, '这局已经结束', this.view(session));
      return { session: this.view(session), stats: this.stats(session.user?.id) };
    }
    if (body.base_tick !== session.state.tick || body.base_moves !== session.state.drops) {
      throw new WatermelonError(409, '进度已更新，正在同步这局', this.view(session));
    }
    if (!Number.isSafeInteger(body.to_tick) || Number(body.to_tick) < session.state.tick
      || Number(body.to_tick) - session.state.tick > LIMITS.max_segment_ticks
      || Number(body.to_tick) > Math.floor((this.now() - session.createdAt) / 1000 * engine.TICK_RATE) + 600
      || !Array.isArray(body.drops) || body.drops.length > LIMITS.max_drops || typeof body.paused !== 'boolean') {
      throw new WatermelonError(400, '本局投放记录无效');
    }
    let next: WatermelonSnapshot;
    try { next = engine.replay(session.seed, session.state, Number(body.to_tick), body.drops as WatermelonSegment['drops']); }
    catch { throw new WatermelonError(400, '本局投放记录无效'); }
    if (finish && next.drops === 0) throw new WatermelonError(409, '先投下一颗水果，再结束这局');
    session.state = next; session.paused = finish || body.paused; session.touchedAt = this.now();
    if (finish) this.settle(session);
    const response: WatermelonSessionResponse = { session: this.view(session) };
    if (finish) response.stats = this.stats(session.user?.id);
    session.requests.set(body.request_id, signature);
    while (session.requests.size > 80) session.requests.delete(session.requests.keys().next().value!);
    return response;
  }
  private settle(session: Session): void {
    if (session.result) return;
    const state = session.state, endedAt = this.now();
    const durationMs = Math.round(state.tick / engine.TICK_RATE * 1000);
    const previousBest = this.stats(session.user?.id)?.bestScore ?? 0;
    let matchId: number | null = null;
    if (session.user) {
      try {
        matchId = this.auth?.recordWatermelonMatch?.({
          sessionId: session.id, userId: session.user.id, nickname: session.user.nickname || '果园玩家',
          score: state.score, highest: state.highest, moves: state.drops, durationMs,
          gameOver: state.phase === 'over', endedAt,
        }) ?? null;
      } catch (error) { console.error('[西瓜] 战绩保存失败:', error instanceof Error ? error.message : String(error)); }
    }
    session.result = {
      id: session.id, score: state.score, highest: state.highest, moves: state.drops, durationMs,
      won: state.highest === engine.LEVELS.length - 1, gameOver: state.phase === 'over',
      recorded: Boolean(matchId), accountId: session.user?.id ?? null,
      personalBest: Boolean(matchId) && state.score > previousBest, endedAt,
    };
    this.dailyStats?.recordGameFinished();
  }
}

export function mountWatermelonRoutes(app: Express, options: ServiceOptions = {}): WatermelonService {
  const service = new WatermelonService(options), router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      let foreign = false;
      try { foreign = Boolean(req.headers.origin && new URL(req.headers.origin).host !== req.get('host')); }
      catch { foreign = true; }
      if (foreign || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '请从游戏页面进行操作' });
    }
    const cookies = req.headers.cookie || '';
    let guest = options.auth?.parseCookies?.(cookies)?.[COOKIE_NAME]
      ?? cookies.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    if (!/^[a-f0-9]{48}$/.test(guest || '')) {
      guest = crypto.randomBytes(24).toString('hex');
      res.cookie(COOKIE_NAME, guest, { httpOnly: true, sameSite: 'lax', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', maxAge: 30 * SESSION_TTL, path: '/api/watermelon' });
    }
    const user = options.auth?.userFromCookieHeader?.(cookies) ?? null;
    (req as MelonRequest).melonIdentity = { owner: user ? `user:${user.id}` : `guest:${guest}`, guestOwner: `guest:${guest}`, user };
    next();
  });
  function handle(operation: (identity: Identity, body: unknown) => WatermelonStatus | WatermelonSessionResponse): RequestHandler {
    return (req, res) => {
      try {
        const identity = (req as MelonRequest).melonIdentity;
        service.prune(); service.adoptGuest(identity.owner, identity.user, identity.guestOwner);
        res.json(operation(identity, req.body));
      } catch (error) {
        if (!(error instanceof WatermelonError)) console.error('[西瓜] 请求失败:', error instanceof Error ? error.message : String(error));
        res.status(error instanceof WatermelonError ? error.status : 500).json({
          error: error instanceof WatermelonError ? error.message : '暂时无法同步这局，请重试',
          session: error instanceof WatermelonError ? error.session : null,
        });
      }
    };
  }
  router.get('/status', handle(({ owner, user, guestOwner }) => service.status(owner, user, guestOwner)));
  router.post('/start', handle(({ owner, user }, body) => service.start(owner, user, body)));
  router.post('/checkpoint', handle(({ owner }, body) => service.checkpoint(owner, body)));
  router.post('/finish', handle(({ owner }, body) => service.checkpoint(owner, body, true)));
  app.use('/api/watermelon', router);
  return service;
}
