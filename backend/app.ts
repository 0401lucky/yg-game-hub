import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as auth from './auth.ts';
import { DailyStats } from './dailyStats.ts';
import { createTextSanitizer } from './contentModeration.ts';
import { loadGameModules } from './gameRegistry.ts';
import { mountStatic } from './static.ts';
import { mountTelemetry } from './telemetry.ts';
import { mountAdminAuth } from './adminAuth.ts';
import { mountOperations } from './operations.ts';
import type { AccountSocket, GameContext } from './gameModule.ts';
import { errorMessage } from '../games/shared/errors.ts';

export async function createApplication() {
  auth.init();
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  app.use(express.json());
  mountAdminAuth(app);
  auth.mountAuthRoutes(app);
  mountTelemetry(app);
  const stats = new DailyStats();
  const context: GameContext = { auth, stats, sanitizeText: createTextSanitizer() };
  const games = await loadGameModules(context);
  for (const game of games) game.registerHttp(app);
  mountOperations(app, games, stats);
  mountStatic(app);
  wss.on('connection', (socket, request) => {
    stats.recordConnectionCount([...wss.clients].filter(client => client.readyState === 1).length);
    const ws = socket as AccountSocket;
    try {
      const account = auth.userFromCookieHeader(request.headers.cookie);
      if (account) {
        ws.user = auth.publicUser(account);
        console.log(`[账号] ${ws.user?.nickname}(${ws.user?.username}) 已登录连接`);
      }
    } catch (error) { console.error('[账号] 握手解析身份失败:', errorMessage(error)); }
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    const game = games.find(item => item.websocketPaths.includes(pathname)) || games.find(item => item.fallbackWebSocket);
    if (!game?.handleConnection) { ws.close(1008, 'Unknown game'); return; }
    game.handleConnection(ws, request);
  });
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  server.once('listening', () => {
    for (const game of games) { game.cleanup?.(); game.start?.(); }
    cleanupTimer = setInterval(() => { for (const game of games) game.cleanup?.(); }, 10 * 60 * 1000);
  });
  return { app, server, wss, games, async close() {
    clearInterval(cleanupTimer);
    for (const game of games) game.close?.();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    stats.save();
    auth.close();
  } };
}
