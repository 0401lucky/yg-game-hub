import type { GameContext, GameModule } from '../../backend/gameModule.ts';
import { mountWatermelonRoutes } from './server/service.ts';
import type { WatermelonService } from './server/service.ts';

export function createGameModule(context: GameContext): GameModule {
  let service: WatermelonService;
  return {
    id: 'watermelon', websocketPaths: [],
    registerHttp(app) { service = mountWatermelonRoutes(app, { auth: context.auth, stats: context.stats }); },
    getOverview() {
      const now = service.now();
      const sessions = [...service.sessions.values()].filter(session => now - session.touchedAt < service.ttl);
      return { rooms: [], onlineUsers: [], savedSessions: sessions.length,
        activeGames: sessions.filter(session => !session.result && !session.paused && now - session.touchedAt < 5 * 60000).length,
        pendingCleanup: service.sessions.size - sessions.length };
    },
    cleanup() {
      const before = service.sessions.size; service.prune();
      return { sessions: before - service.sessions.size, rooms: 0, connections: 0 };
    },
  };
}
