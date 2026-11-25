import type { GameContext, GameModule } from '../../backend/gameModule.ts';
import { serverProtocol } from './protocol.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';
import { DoudizhuService } from './server/service.ts';
import { getOverview } from './server/overview.ts';

export async function createGameModule(context: GameContext): Promise<GameModule<ClientMessage, ServerMessage>> {
  const service = new DoudizhuService({ auth: context.auth, sanitizeText: context.sanitizeText, stats: context.stats });
  await service.ready;
  return {
    id: 'doudizhu',
    websocketPaths: ['/ws/doudizhu'],
    protocol: serverProtocol,
    registerHttp(app) {
      app.get('/api/doudizhu/rooms', (_req, res) => res.json({ rooms: service.listRooms() }));
    },
    getOverview: () => getOverview(service),
    cleanup: () => service.cleanup(),
    handleConnection: (ws, request) => service.handleConnection(ws, request),
    close: () => service.close(),
  };
}
