import type { GameContext, GameModule } from '../../backend/gameModule.ts';
import { flightServerProtocol } from './protocol.ts';
import type { FlightClientMessage, FlightServerMessage } from './protocol.ts';
import { configureRuntime } from './server/runtime.ts';
import { configureRoomManager, roomManager } from './server/roomManager.ts';
import { getDefaultNickname } from './server/roomHelpers.ts';
import { handleConnection } from './server/connections.ts';
import { registerHttp, cleanupOrphanedResources } from './server/http.ts';
import { dropAuthoritySession, authoritySessions, startTurnWatchdog } from './server/authorityRuntime.ts';

export function createGameModule(context: GameContext): GameModule<FlightClientMessage, FlightServerMessage> {
  configureRuntime(context);
  configureRoomManager({ getDefaultNickname, dropAuthoritySession, stats: context.stats });
  let watchdog: ReturnType<typeof setInterval> | undefined;
  return {
    id: 'flight',
    websocketPaths: ['/', '/ws'],
    // Preserve the old server's flight protocol on all other WS paths.
    fallbackWebSocket: true,
    protocol: flightServerProtocol,
    registerHttp,
    handleConnection,
    start() { watchdog = startTurnWatchdog(); },
    cleanup: cleanupOrphanedResources,
    close() {
      clearInterval(watchdog);
      for (const id of authoritySessions.keys()) dropAuthoritySession(id);
      for (const entry of roomManager.roomDestroyTimers.values()) clearTimeout(entry.timer);
      for (const timer of roomManager.disconnectTimers.values()) clearTimeout(timer);
      for (const timer of roomManager.disconnectDebounceTimers.values()) clearTimeout(timer);
    },
  };
}
