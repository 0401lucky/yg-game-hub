import crypto from 'node:crypto';
import express from 'express';
import type { CookieOptions, Express, Request, RequestHandler } from 'express';
import type { AdminSession } from '../web/operationsProtocol.ts';

const COOKIE_NAME = 'yg_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 60 * 1000;
const LEGACY_ADMIN_ROUTES = ['/api/rooms', '/api/stats', '/api/sessions', '/api/online-users', '/api/daily-stats', '/api/daily-history', '/api/cleanup'];
const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

export function mountAdminAuth(app: Express): void {
  const key = process.env.ADMIN_KEY || '';
  const configured = key.trim().length > 0;
  const expected = digest(key);
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const router = express.Router();

  function cookieOptions(req: Request): CookieOptions {
    return { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === '1' || req.secure, path: '/api' };
  }
  function sessionId(req: Request): string | null {
    const token = (req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token).toString('hex') : null;
  }
  function prune(): void {
    const now = Date.now();
    for (const [id, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(id);
    for (const [ip, item] of attempts) if (item.resetAt <= now) attempts.delete(ip);
  }
  function session(req: Request): AdminSession {
    prune();
    const id = sessionId(req);
    const expiresAt = id ? sessions.get(id) ?? null : null;
    return { configured, authenticated: configured && expiresAt !== null, expiresAt };
  }
  const sameOrigin: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let foreignOrigin = false;
      try { foreignOrigin = !!req.headers.origin && new URL(req.headers.origin).host !== req.get('host'); }
      catch { foreignOrigin = true; }
      if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ error: '请从本站运营面板进行操作' });
        return;
      }
    }
    next();
  };
  const requireAdmin: RequestHandler = (req, res, next) => {
    if (!configured) { res.status(503).json({ error: '管理入口尚未启用，请联系站点管理员' }); return; }
    if (!session(req).authenticated) { res.status(401).json({ error: '请输入管理密钥后进入运营面板' }); return; }
    next();
  };

  router.use(sameOrigin);
  router.get('/session', (req, res) => { res.json(session(req)); });
  router.post('/login', (req, res) => {
    if (!configured) { res.status(503).json({ error: '管理入口尚未启用，请联系站点管理员' }); return; }
    prune();
    // Match the account routes' Cloudflare Tunnel client-IP convention.
    const ip = String(req.headers['cf-connecting-ip'] || req.ip || 'unknown').split(',')[0].trim();
    const item = attempts.get(ip) || { count: 0, resetAt: Date.now() + ATTEMPT_WINDOW_MS };
    if (item.count >= 5) {
      const retryAfter = Math.max(1, Math.ceil((item.resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: `密钥输错次数过多，请在 ${retryAfter} 秒后重试` });
      return;
    }
    const input: unknown = req.body?.key;
    if (typeof input !== 'string' || input.length > 1024 || !crypto.timingSafeEqual(digest(input), expected)) {
      item.count++;
      if (attempts.size >= 4096 && !attempts.has(ip)) attempts.delete(attempts.keys().next().value!);
      attempts.set(ip, item);
      res.status(401).json({ error: '管理密钥不正确，请重新输入' });
      return;
    }
    attempts.delete(ip);
    const previous = sessionId(req);
    if (previous) sessions.delete(previous);
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(digest(token).toString('hex'), expiresAt);
    res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
    res.json({ configured: true, authenticated: true, expiresAt } satisfies AdminSession);
  });
  router.post('/logout', (req, res) => {
    const id = sessionId(req);
    if (id) sessions.delete(id);
    res.clearCookie(COOKIE_NAME, cookieOptions(req));
    res.json({ configured, authenticated: false, expiresAt: null } satisfies AdminSession);
  });
  router.use(requireAdmin);
  app.use('/api/admin', router);
  app.use(LEGACY_ADMIN_ROUTES, sameOrigin, requireAdmin);
}
