import type { AccountStats } from '../../games/shared/protocol.ts';

// Only the browser-visible state used by tests. Importing frontend classes here
// would mix Node timer types into the independently checked DOM source files.
declare global {
  interface Window {
    gameState?: { gamePhase: string; diceStatistics: Record<number, Record<number, number>> };
    gameInstance?: { multiplayerGameManager?: { gameSessionId?: string | null; isSpectator: boolean } };
    accountUI?: { getStats(): AccountStats | null };
  }
}
