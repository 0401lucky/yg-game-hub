import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const root = import.meta.dirname;
const gamesDir = path.join(root, 'games');
const registryFile = path.join(root, 'web/games.json');
const dictionaryFile = path.join(gamesDir, 'flight/assets/违规词库.txt');
const bannedWords = fs.existsSync(dictionaryFile)
  ? fs.readFileSync(dictionaryFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  : [];
const gameIds = fs.readdirSync(gamesDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== 'shared').map(entry => entry.name);
const inputs = [path.join(root, 'index.html'), ...gameIds.flatMap(id =>
  fs.readdirSync(path.join(gamesDir, id)).filter(file => file.endsWith('.html')).map(file => path.join(gamesDir, id, file)))];

interface StaticAsset { file: string; name: string }
function staticAssets(): StaticAsset[] {
  const assets: StaticAsset[] = [];
  const visit = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(file, name);
      else if (/\.(svg|png|jpe?g|webp|avif|gif|ico|wav|mp3|ogg|woff2?)$/i.test(file)) assets.push({ file, name });
    }
  };
  for (const id of gameIds) {
    const dir = path.join(gamesDir, id);
    visit(path.join(dir, 'public'), `games/${id}`);
    visit(path.join(dir, 'assets'), `games/${id}/assets`);
    const favicon = path.join(dir, 'favicon.svg');
    if (fs.existsSync(favicon)) assets.push({ file: favicon, name: `games/${id}/favicon.svg` });
  }
  return assets;
}
const legacyPages: Record<string, string> = {
  '/game': '/games/flight/game.html', '/stats': '/games/flight/stats.html',
  '/spectate': '/games/flight/spectate.html', '/replay': '/games/flight/replay.html',
  '/admin': '/games/flight/admin.html', '/flight': '/games/flight/',
};
function hubAssets(): Plugin {
  return {
    name: 'hub-assets',
    transformIndexHtml(html) {
      // A classic inline bootstrap runs before styles, just as before the migration.
      const bootstrap = fs.readFileSync(path.join(gamesDir, 'flight/js/themeBootstrap.ts'), 'utf8');
      return html.replace('<script data-theme-bootstrap></script>', `<script>${bootstrap}</script>`);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'games.json', source: fs.readFileSync(registryFile) });
      for (const asset of staticAssets()) this.emitFile({ type: 'asset', fileName: asset.name, source: fs.readFileSync(asset.file) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (legacyPages[url.pathname]) {
          res.statusCode = 302; res.setHeader('Location', legacyPages[url.pathname] + url.search); res.end(); return;
        }
        if (url.pathname === '/games.json') {
          res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
          res.end(fs.readFileSync(registryFile)); return;
        }
        const asset = staticAssets().find(item => `/${item.name}` === url.pathname);
        if (asset) {
          const mimes: Record<string, string> = { '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
          res.setHeader('Content-Type', mimes[path.extname(asset.file)] || 'application/octet-stream');
          res.end(fs.readFileSync(asset.file)); return;
        }
        if (url.pathname.startsWith('/games/') && !path.extname(url.pathname)
          && fs.existsSync(path.join(root, `${url.pathname.slice(1)}.html`))) req.url = `${url.pathname}.html${url.search}`;
        next();
      });
    },
  };
}

const backend = process.env.VITE_BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
export default defineConfig({
  root,
  publicDir: false,
  define: { __FLIGHT_BANNED_WORDS__: JSON.stringify(bannedWords) },
  appType: 'mpa',
  plugins: [hubAssets()],
  css: { postcss: { plugins: [] } },
  build: { outDir: 'dist', rollupOptions: { input: inputs } },
  server: {
    proxy: { '/api': { target: backend }, '/ws': { target: backend, ws: true } },
    watch: { ignored: ['**/backend/data/**', '**/playwright-report/**', '**/test-results/**', '**/runtime-games/**'] },
  },
});
