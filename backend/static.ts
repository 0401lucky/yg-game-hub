import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import { DIST_DIR } from './config.ts';

const LEGACY_PAGE_REDIRECTS: Record<string, string> = {
  '/game': '/games/flight/game.html', '/stats': '/games/flight/stats.html',
  '/spectate': '/games/flight/spectate.html', '/replay': '/games/flight/replay.html',
  '/admin': '/games/flight/admin.html', '/flight': '/games/flight/',
};
export function mountStatic(app: Express): void {
  app.get(Object.keys(LEGACY_PAGE_REDIRECTS), (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, LEGACY_PAGE_REDIRECTS[req.path] + query);
  });
  app.use(express.static(DIST_DIR, {
    extensions: ['html'],
    setHeaders(res, file) {
      if (/\.(html|json)$/i.test(file)) res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      else if (file.startsWith(path.join(DIST_DIR, 'assets') + path.sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
}
