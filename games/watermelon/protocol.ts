export interface WatermelonDrop { tick: number; x: number }
export interface WatermelonSnapshot {
  version: 'watermelon-v1'; tick: number; drops: number; score: number; highest: number;
  next_id: number; cooldown_ticks: number; overflow_ticks: number; phase: 'playing' | 'over';
  bodies: { id: number; level: number; age_ticks: number; touched: boolean; nodes: [number, number, number, number][] }[];
}
export interface WatermelonLimits { max_segment_ticks: number; max_drops: number; max_bodies: number }
export interface WatermelonResult {
  id: string; score: number; highest: number; moves: number; durationMs: number;
  won: boolean; gameOver: boolean; recorded: boolean; accountId: number | null;
  personalBest: boolean; endedAt: number;
}
export interface WatermelonStats {
  games: number; wins: number; bestScore: number; highest: number; recent: WatermelonResult[];
}
export interface WatermelonActiveSession {
  session_id: string; seed: string; engine_version: 'watermelon-v1'; tick_rate: 120;
  limits: WatermelonLimits; base_tick: number; base_moves: number; state: WatermelonSnapshot;
  paused: boolean; result: WatermelonResult | null; expires_at: string;
}
export interface WatermelonStart { request_id: string; replace_session_id?: string }
export interface WatermelonSegment {
  request_id: string; session_id: string; base_tick: number; base_moves: number;
  to_tick: number; drops: WatermelonDrop[]; paused: boolean;
}
export interface WatermelonStatus { active_session: WatermelonActiveSession | null; stats: WatermelonStats | null }
export interface WatermelonSessionResponse { session: WatermelonActiveSession; stats?: WatermelonStats | null }
export interface AccountUser { id: number; username?: string; nickname?: string }
export interface WatermelonAccountRecord {
  sessionId: string; userId: number; nickname: string; score: number; highest: number;
  moves: number; durationMs: number; gameOver: boolean; endedAt: number;
}
export interface AuthAdapter {
  parseCookies?(header: string): Record<string, string>;
  userFromCookieHeader?(header: string): AccountUser | null;
  watermelonStatsOf?(userId: number): WatermelonStats | null;
  recordWatermelonMatch?(record: WatermelonAccountRecord): number | null;
}
