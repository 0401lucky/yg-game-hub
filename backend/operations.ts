import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { GameModule } from './gameModule.ts';
import type { DailyStats } from './dailyStats.ts';
import type { SiteRegistry } from '../games/shared/protocol.ts';
import type { AdminOverview, GameSnapshot, GameSummary, HubStatus } from '../web/operationsProtocol.ts';
import { DIST_DIR, PROJECT_ROOT } from './config.ts';

export function mountOperations(app: Express, games: GameModule[], stats: DailyStats): void {
  const sourceRegistry = path.join(PROJECT_ROOT, 'web/games.json');
  // The production image keeps the built registry in dist, without the web source tree.
  const registry = JSON.parse(fs.readFileSync(fs.existsSync(sourceRegistry) ? sourceRegistry : path.join(DIST_DIR, 'games.json'), 'utf8')) as SiteRegistry;
  function snapshots(): { game: GameModule; snapshot: GameSnapshot }[] {
    return games.map(game => ({ game, snapshot: game.getOverview?.() ?? { rooms: [], onlineUsers: [], activeGames: 0, savedSessions: 0, pendingCleanup: 0 } }));
  }
  function status(sources: ReturnType<typeof snapshots>): HubStatus {
    const summaries: GameSummary[] = sources.map(({ game, snapshot }) => {
      const info = registry.games.find(item => item.id === game.id);
      return {
        id: game.id, name: info?.name ?? game.id, emoji: info?.emoji ?? '🎮', path: info?.path ?? `/games/${game.id}/`,
        onlinePlayers: snapshot.onlineUsers.length, roomCount: snapshot.rooms.length,
        waitingRooms: snapshot.rooms.filter(room => room.state === 'waiting').length,
        playingRooms: snapshot.rooms.filter(room => room.state === 'playing').length,
        activeGames: snapshot.activeGames, savedSessions: snapshot.savedSessions,
      };
    });
    return {
      timestamp: new Date().toISOString(), games: summaries,
      totals: summaries.reduce((total, game) => ({
        rooms: total.rooms + game.roomCount, waitingRooms: total.waitingRooms + game.waitingRooms,
        playingRooms: total.playingRooms + game.playingRooms, onlinePlayers: total.onlinePlayers + game.onlinePlayers,
        activeGames: total.activeGames + game.activeGames, savedSessions: total.savedSessions + game.savedSessions,
      }), { rooms: 0, waitingRooms: 0, playingRooms: 0, onlinePlayers: 0, activeGames: 0, savedSessions: 0 }),
    };
  }
  app.get('/api/hub/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(status(snapshots()));
  });
  app.get('/api/hub/rooms', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const rooms = snapshots().flatMap(({ snapshot }) => snapshot.rooms)
      .filter(room => !room.isPrivate && room.state !== 'cleanup' && room.state !== 'finished')
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ timestamp: new Date().toISOString(), rooms });
  });
  app.get('/api/admin/overview', (_req, res) => {
    const sources = snapshots();
    const overview: AdminOverview = {
      ...status(sources),
      rooms: sources.flatMap(({ snapshot }) => snapshot.rooms).sort((a, b) => b.createdAt - a.createdAt),
      onlineUsers: sources.flatMap(({ game, snapshot }) => snapshot.onlineUsers.map(user => ({ ...user, gameId: game.id }))),
      daily: stats.toJSON(), history: stats.history(7),
      system: { uptimeSeconds: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        pendingCleanup: sources.reduce((total, { snapshot }) => total + snapshot.pendingCleanup, 0) },
    };
    res.json(overview);
  });
  app.post('/api/admin/cleanup', (_req, res) => {
    const cleaned = { sessions: 0, rooms: 0, connections: 0 };
    for (const game of games) {
      const result = game.cleanup?.();
      if (!result) continue;
      cleaned.sessions += result.sessions; cleaned.rooms += result.rooms; cleaned.connections += result.connections;
    }
    res.json({ cleaned, message: `已清理 ${cleaned.rooms} 个失效房间、${cleaned.sessions} 个孤立会话、${cleaned.connections} 个断开连接` });
  });
}
