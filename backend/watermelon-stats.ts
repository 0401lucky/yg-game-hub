import type { DatabaseSync } from 'node:sqlite';
import type { WatermelonStats } from '../games/watermelon/protocol.ts';

export function readWatermelonStats(db: DatabaseSync, userId: number): WatermelonStats {
  const summary = db.prepare(`
    SELECT COUNT(*) AS games, SUM(mp.is_winner) AS wins, MAX(w.score) AS best, MAX(w.highest) AS highest
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    JOIN watermelon_results w ON w.match_id = m.id WHERE mp.user_id = ?
  `).get(userId);
  const recent = db.prepare(`
    SELECT w.*, m.duration_ms, m.ended_at, mp.is_winner
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    JOIN watermelon_results w ON w.match_id = m.id WHERE mp.user_id = ? ORDER BY m.id DESC LIMIT 5
  `).all(userId);
  return {
    games: Number(summary?.games ?? 0), wins: Number(summary?.wins ?? 0),
    bestScore: Number(summary?.best ?? 0), highest: Number(summary?.highest ?? -1),
    recent: recent.map(row => ({
      id: String(row.session_id), score: Number(row.score), highest: Number(row.highest), moves: Number(row.moves),
      durationMs: Number(row.duration_ms), endedAt: Date.parse(String(row.ended_at)),
      won: Boolean(row.is_winner), gameOver: Boolean(row.game_over), recorded: true, accountId: userId, personalBest: false,
    })),
  };
}
