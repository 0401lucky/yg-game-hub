import type { Express } from 'express';

export function mountTelemetry(app: Express): void {
  const windows = new Map<string, { count: number; resetAt: number }>();
  app.post('/api/client-error', (req, res) => {
    try {
      const ip = String(req.headers['cf-connecting-ip']
        || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.ip || req.socket?.remoteAddress || 'unknown');
      const now = Date.now();
      const bucket = windows.get(ip);
      if (!bucket || now > bucket.resetAt) windows.set(ip, { count: 1, resetAt: now + 60000 });
      else if (++bucket.count > 60) return res.json({ success: true, throttled: true });
      const body = req.body as { kind?: unknown; url?: unknown; message?: unknown; stack?: unknown; extra?: unknown } || {};
      const trim = (value: unknown, max: number) => String(value == null ? '' : value).slice(0, max);
      console.error(`[前端异常] ${trim(body.kind, 20) || 'error'} | ${trim(body.url, 200)} | ${trim(body.message, 300)}`);
      if (body.stack) console.error(`[前端异常栈] ${trim(body.stack, 1200)}`);
      if (body.extra) console.error(`[前端异常上下文] ${trim(JSON.stringify(body.extra), 500)}`);
      res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
  });
}
