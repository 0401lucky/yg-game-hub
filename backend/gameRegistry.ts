import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GAMES_DIR } from './config.ts';
import type { GameContext, GameFactory, GameModule } from './gameModule.ts';

/** New games register by adding games/<id>/server.ts, with no host routing edits. */
export async function loadGameModules(context: GameContext): Promise<GameModule[]> {
  const modules: GameModule[] = [];
  for (const entry of fs.readdirSync(GAMES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'shared') continue;
    const file = path.join(GAMES_DIR, entry.name, 'server.ts');
    if (!fs.existsSync(file)) continue;
    const exports = await import(pathToFileURL(file).href) as { createGameModule?: unknown };
    if (typeof exports.createGameModule !== 'function') throw new Error(`${entry.name}/server.ts 缺少 createGameModule`);
    const game = await (exports.createGameModule as GameFactory)(context);
    if (game.id !== entry.name) throw new Error(`游戏注册 id 与目录不符: ${entry.name}`);
    if (game.websocketPaths.some(route => modules.some(existing => existing.websocketPaths.includes(route)))) {
      throw new Error(`游戏 WebSocket 路径重复: ${game.id}`);
    }
    if (game.fallbackWebSocket && modules.some(existing => existing.fallbackWebSocket)) throw new Error('只能注册一个默认 WebSocket 协议');
    modules.push(game);
  }
  return modules;
}
