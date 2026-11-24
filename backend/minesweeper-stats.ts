import type { DatabaseSync } from 'node:sqlite';
import type { GameStats } from '../games/minesweeper/types.ts';

/** Reuse the existing match tables; no schema migration or extra game database. */
export function readMinesweeperStats(db: DatabaseSync, userId: number): GameStats | null {
  try {
    const rows = db.prepare(`
      SELECT m.mode, COUNT(*) AS games,
             SUM(mp.is_winner) AS wins,
             MIN(CASE WHEN mp.is_winner = 1 THEN m.duration_ms END) AS best
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = ? AND m.game_id = 'minesweeper'
      GROUP BY m.mode
    `).all(userId);
    const result: GameStats = { games: 0, wins: 0, bestTimes: { classic: {}, daily: {} } };
    for (const row of rows) {
      result.games += Number(row.games);
      result.wins += Number(row.wins);
      const [mode, difficulty] = String(row.mode || '').split(':');
      if ((mode === 'classic' || mode === 'daily') && (difficulty === 'easy' || difficulty === 'normal' || difficulty === 'hard') && row.best != null) {
        result.bestTimes[mode][difficulty] = Number(row.best);
      }
    }
    return result;
  } catch (error) {
    console.error('[战绩] 扫雷查询失败:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
