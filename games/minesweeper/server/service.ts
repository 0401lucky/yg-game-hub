import crypto from 'node:crypto';
import express from 'express';
import type { Express, Request, RequestHandler } from 'express';
import type { AuthAdapter, AccountUser, GameState, GameResult, SessionView, StartInput, StepInput, StatusResponse, SessionResponse, GameStats } from '../types.ts';

type EngineModule = typeof import('../engine.ts');
interface Session {
  id: string; revision: number; mode: 'classic' | 'daily'; date: string | null;
  state: GameState; user: AccountUser | null;
  startedAt: number | null; endedAt: number | null; pausedAt: number | null;
  pausedTotal: number; touchedAt: number; requests: Set<string>; result: GameResult | null;
}
interface ServiceOptions {
  auth?: AuthAdapter | null; now?: () => number; seedFactory?: () => string;
  maxSessions?: number; ttl?: number;
}
interface Identity { owner: string; guestOwner: string; user: AccountUser | null; }
interface MineRequest extends Request { mineIdentity: Identity; }

const SESSION_TTL = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'yg_mine_guest';

function dayKey(now: number = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

class GameError extends Error {
  readonly status: number;
  readonly session: SessionView | null;
  constructor(status: number, message: string, session: SessionView | null = null) {
    super(message);
    this.status = status;
    this.session = session;
  }
}

class MinesweeperService {
  readonly auth: AuthAdapter | null;
  readonly now: () => number;
  readonly seedFactory: () => string;
  readonly maxSessions: number;
  readonly ttl: number;
  readonly sessions: Map<string, Session>;
  readonly starts: Map<string, { count: number; resetAt: number }>;
  readonly ready: Promise<void>;
  engine!: EngineModule;
  constructor({ auth = null, now = Date.now, seedFactory = () => crypto.randomBytes(24).toString('hex'), maxSessions = 1000, ttl = SESSION_TTL }: ServiceOptions = {}) {
    this.auth = auth;
    this.now = now;
    this.seedFactory = seedFactory;
    this.maxSessions = maxSessions;
    this.ttl = ttl;
    this.sessions = new Map<string, Session>();
    this.starts = new Map<string, { count: number; resetAt: number }>();
    this.ready = import('../engine.ts').then(engine => { this.engine = engine; });
  }

  prune() {
    const now = this.now();
    for (const [owner, session] of this.sessions) if (now - session.touchedAt >= this.ttl) this.sessions.delete(owner);
    for (const [owner, item] of this.starts) if (now >= item.resetAt) this.starts.delete(owner);
  }

  stats(userId?: number): GameStats | null {
    try { return userId ? this.auth?.minesweeperStatsOf?.(userId) || null : null; }
    catch (error) { console.error('[扫雷] 战绩查询失败:', error instanceof Error ? error.message : String(error)); return null; }
  }

  elapsed(session: Session): number {
    if (session.startedAt === null) return 0;
    const end = session.endedAt ?? this.now();
    const paused = session.mode === 'classic'
      ? session.pausedTotal + (session.pausedAt === null ? 0 : Math.max(0, end - session.pausedAt))
      : 0;
    return Math.max(0, end - session.startedAt - paused);
  }

  view(session: Session | null | undefined): SessionView | null {
    if (!session) return null;
    return {
      id: session.id,
      revision: session.revision,
      mode: session.mode,
      date: session.date,
      state: this.engine.buildView(session.state),
      elapsedMs: this.elapsed(session),
      running: session.startedAt !== null && session.endedAt === null && (session.mode === 'daily' || session.pausedAt === null),
      paused: session.pausedAt !== null,
      result: session.result,
    };
  }

  status(owner: string, user: AccountUser | null = null, guestOwner: string | null = null): StatusResponse {
    this.prune();
    // Logging in during a guest game can attach that unfinished game to the account.
    if (user && guestOwner && !this.sessions.has(owner)) {
      const guest = this.sessions.get(guestOwner);
      if (guest && guest.state.status === 'playing') {
        guest.user = { id: user.id, nickname: user.nickname || user.username || '探险家' };
        this.sessions.set(owner, guest);
        this.sessions.delete(guestOwner);
      }
    }
    const session = this.sessions.get(owner);
    if (session) session.touchedAt = this.now();
    return { date: dayKey(this.now()), difficulties: Object.values(this.engine.DIFFICULTIES), session: this.view(session), stats: this.stats(user?.id) };
  }

  start(owner: string, user: AccountUser | null, input: StartInput = {}): SessionResponse {
    this.prune();
    const difficulty = input.difficulty ?? 'easy';
    const mode = input.mode ?? 'classic';
    if (!Object.hasOwn(this.engine.DIFFICULTIES, difficulty) || !['classic', 'daily'].includes(mode)) {
      throw new GameError(400, '请选择有效的玩法和难度');
    }
    const current = this.sessions.get(owner);
    if (current?.state.status === 'playing' && current.state.firstRevealDone && input.replaceSessionId !== current.id) {
      throw new GameError(409, '你还有一片正在探索的林地，请先确认重新开始', this.view(current));
    }
    if (!current && this.sessions.size >= this.maxSessions) throw new GameError(503, '营地暂时满员，请稍后再试');
    const now = this.now();
    const limit = this.starts.get(owner) || { count: 0, resetAt: now + 60000 };
    if (++limit.count > 30) throw new GameError(429, '出发太频繁了，请稍等片刻');
    this.starts.set(owner, limit);
    const date = mode === 'daily' ? dayKey(now) : null;
    const seed = mode === 'daily'
      ? crypto.createHash('sha256').update(`yg-forest-daily-v1:${date}:${difficulty}`).digest('hex')
      : this.seedFactory();
    let state = this.engine.createGame(seed, difficulty);
    if (mode === 'daily') {
      const index = Math.floor(state.rows / 2) * state.cols + Math.floor(state.cols / 2);
      const opening = this.engine.applyAction(state, { type: 'reveal', index });
      if (!opening.ok) throw new GameError(500, opening.message);
      state = opening.state;
    }
    const session: Session = {
      id: crypto.randomUUID(), revision: 0, mode, date, state,
      user: user ? { id: user.id, nickname: user.nickname || user.username || '探险家' } : null,
      startedAt: mode === 'daily' ? now : null,
      endedAt: null, pausedAt: null, pausedTotal: 0,
      touchedAt: now, requests: new Set<string>(), result: null,
    };
    this.sessions.set(owner, session);
    if (state.status !== 'playing') this.settle(session);
    return { session: this.view(session)! };
  }

  step(owner: string, input: Partial<StepInput> = {}): SessionResponse {
    this.prune();
    const session = this.sessions.get(owner);
    if (!session || input.sessionId !== session.id) throw new GameError(404, '这次探险已过期，重新出发吧');
    const { action, requestId, revision } = input;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw new GameError(400, '操作编号无效');
    if (session.requests.has(requestId)) return { session: this.view(session)!, message: '进度已同步' };
    if (!Number.isInteger(revision) || revision !== session.revision) throw new GameError(409, '另一张页面更新了进度，已为你同步', this.view(session));
    if (!action || !['reveal', 'flag', 'chord', 'pause', 'resume'].includes(action.type)) throw new GameError(400, '未知操作');
    if (session.state.status !== 'playing') throw new GameError(409, '这次探险已经结束了', this.view(session));

    const now = this.now();
    let message: string;
    if (action.type === 'pause' || action.type === 'resume') {
      if (action.type === 'pause' && session.pausedAt === null) session.pausedAt = now;
      if (action.type === 'resume' && session.pausedAt !== null) {
        if (session.startedAt !== null) session.pausedTotal += Math.max(0, now - session.pausedAt);
        session.pausedAt = null;
      }
      message = action.type === 'pause' ? '休息一下，林地会等你回来' : '欢迎回来，继续探索吧';
    } else {
      if (session.pausedAt !== null) throw new GameError(409, '先继续探险，再探索格子', this.view(session));
      const resolved = this.engine.applyAction(session.state, action);
      if (!resolved.ok) throw new GameError(400, resolved.message);
      session.state = resolved.state;
      if (session.startedAt === null && session.state.firstRevealDone) session.startedAt = now;
      message = resolved.message;
      if (session.state.status !== 'playing') this.settle(session);
    }
    session.revision++;
    session.touchedAt = now;
    session.requests.add(requestId);
    while (session.requests.size > 80) session.requests.delete(session.requests.values().next().value!);
    return { session: this.view(session)!, message };
  }

  settle(session: Session): void {
    if (session.result) return;
    session.endedAt = this.now();
    const durationMs = this.elapsed(session);
    const won = session.state.status === 'won';
    const best = this.stats(session.user?.id)?.bestTimes?.[session.mode]?.[session.state.difficulty];
    let matchId: number | null = null;
    if (session.user) {
      try {
        matchId = this.auth?.recordMatch?.({
          gameId: 'minesweeper', roomCode: session.date,
          mode: `${session.mode}:${session.state.difficulty}`,
          players: [{ userId: session.user.id, playerId: `mine_${session.id}`, nickname: session.user.nickname, color: 0 }],
          winnerColors: won ? [0] : [], durationMs,
        }) ?? null;
      } catch (error) { console.error('[扫雷] 战绩保存失败:', error instanceof Error ? error.message : String(error)); }
    }
    session.result = {
      id: session.id, won, difficulty: session.state.difficulty, mode: session.mode, date: session.date,
      durationMs, moves: session.state.moves,
      revealedSafe: session.state.revealedSafe, safeCells: session.state.cells.length - session.state.mines,
      score: this.engine.calculateScore(session.state, durationMs),
      recorded: Boolean(matchId), accountId: session.user?.id ?? null,
      personalBest: won && Boolean(matchId) && (best == null || durationMs < best),
      endedAt: session.endedAt,
    };
  }
}

function mountMinesweeperRoutes(app: Express, options: ServiceOptions = {}): MinesweeperService {
  const service = new MinesweeperService(options);
  const router = express.Router();
  const auth = options.auth;
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      let foreignOrigin = false;
      try { foreignOrigin = req.headers.origin ? new URL(req.headers.origin).host !== req.get('host') : false; }
      catch { foreignOrigin = true; }
      if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '请从游戏页面进行操作' });
    }
    const rawCookies = req.headers.cookie || '';
    let guest = auth?.parseCookies?.(rawCookies)?.[COOKIE_NAME]
      ?? rawCookies.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    if (!/^[a-f0-9]{48}$/.test(guest || '')) {
      guest = crypto.randomBytes(24).toString('hex');
      res.cookie(COOKIE_NAME, guest, { httpOnly: true, sameSite: 'lax', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', maxAge: 30 * SESSION_TTL, path: '/api/minesweeper' });
    }
    const user = auth?.userFromCookieHeader?.(req.headers.cookie || '') || null;
    (req as MineRequest).mineIdentity = { owner: user ? `user:${user.id}` : `guest:${guest}`, guestOwner: `guest:${guest}`, user };
    next();
  });
  function handle(operation: (identity: Identity, body: unknown) => StatusResponse | SessionResponse): RequestHandler {
    return async (req, res) => {
      try {
        await service.ready;
        res.json(operation((req as MineRequest).mineIdentity, req.body));
      } catch (error) {
        if (!(error instanceof GameError)) console.error('[扫雷] 请求失败:', error instanceof Error ? error.message : String(error));
        res.status(error instanceof GameError ? error.status : 500).json({ error: error instanceof GameError ? error.message : '营地暂时没有回应，请重试', session: error instanceof GameError ? error.session : null });
      }
    };
  }
  router.get('/status', handle(({ owner, user, guestOwner }) => service.status(owner, user, guestOwner)));
  router.post('/start', handle(({ owner, user }, body) => service.start(owner, user, (body || {}) as StartInput)));
  router.post('/action', handle(({ owner }, body) => service.step(owner, (body || {}) as Partial<StepInput>)));
  app.use('/api/minesweeper', router);
  return service;
}

export { MinesweeperService, mountMinesweeperRoutes, dayKey, GameError };
