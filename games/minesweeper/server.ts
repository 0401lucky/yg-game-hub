import type { GameContext, GameModule } from '../../backend/gameModule.ts';
import { mountMinesweeperRoutes } from './server/service.ts';

export function createGameModule(context: GameContext): GameModule {
  return {
    id: 'minesweeper',
    websocketPaths: [],
    registerHttp(app) { mountMinesweeperRoutes(app, { auth: context.auth }); },
  };
}
