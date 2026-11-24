import type { DailyStats } from '../../../backend/dailyStats.ts';
import type { GameContext } from '../../../backend/gameModule.ts';

// The host supplies shared account and text services before opening the port.
export let dailyStats: DailyStats;
export let sanitizeText: (input: unknown) => string;
export function configureRuntime(context: GameContext): void {
  dailyStats = context.stats;
  sanitizeText = context.sanitizeText;
}
