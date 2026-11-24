export type Difficulty = 'easy' | 'normal' | 'hard';
export type GameMode = 'classic' | 'daily';
export type GameStatus = 'playing' | 'won' | 'lost';
export type CellDisplay = 'hidden' | 'flagged' | 'revealed' | 'mine' | 'exploded' | 'wrongflag';
export type ToolMode = 'reveal' | 'flag';

export interface DifficultyConfig {
  readonly id: Difficulty;
  readonly label: string;
  readonly title: string;
  readonly rows: number;
  readonly cols: number;
  readonly mines: number;
  readonly baseScore: number;
  readonly timeBonusSeconds: number;
}

export interface Cell {
  mine: boolean;
  adjacent: number;
  revealed: boolean;
  flagged: boolean;
}

export interface GameState {
  version: 1;
  seed: string;
  difficulty: Difficulty;
  rows: number;
  cols: number;
  mines: number;
  status: GameStatus;
  firstRevealDone: boolean;
  firstIndex: number | null;
  revealedSafe: number;
  flagsUsed: number;
  moves: number;
  exploded: number | null;
  cells: Cell[];
}

export interface CellView {
  index: number;
  display: CellDisplay;
  adjacent: number;
}

export interface GameView {
  difficulty: Difficulty;
  rows: number;
  cols: number;
  mines: number;
  status: GameStatus;
  firstRevealDone: boolean;
  revealedSafe: number;
  flagsUsed: number;
  moves: number;
  exploded: number | null;
  cells: CellView[];
}

export type GridAction = { type: 'reveal'; index: number } | { type: 'flag'; index: number } | { type: 'chord'; index: number };
export type GameAction = GridAction | { type: 'pause' } | { type: 'resume' };
export type ActionResult = { ok: true; state: GameState; message: string; revealedDelta: number } | { ok: false; message: string };

export interface GameStats {
  games: number;
  wins: number;
  bestTimes: Record<GameMode, Partial<Record<Difficulty, number>>>;
}

export interface GameResult {
  id: string;
  won: boolean;
  difficulty: Difficulty;
  mode: GameMode;
  date: string | null;
  durationMs: number;
  moves: number;
  revealedSafe: number;
  safeCells: number;
  score: number;
  recorded: boolean;
  accountId: number | null;
  personalBest: boolean;
  endedAt: number;
}

export interface SessionView {
  id: string;
  revision: number;
  mode: GameMode;
  date: string | null;
  state: GameView;
  elapsedMs: number;
  running: boolean;
  paused: boolean;
  result: GameResult | null;
}

export interface StartInput {
  difficulty?: Difficulty;
  mode?: GameMode;
  replaceSessionId?: string;
}

export interface StepInput {
  sessionId: string;
  revision: number;
  requestId: string;
  action: GameAction;
}

export interface StatusResponse {
  date: string;
  difficulties: DifficultyConfig[];
  session: SessionView | null;
  stats: GameStats | null;
}

export interface SessionResponse {
  session: SessionView;
  message?: string;
}

export interface AccountUser {
  id: number;
  nickname: string;
  username?: string;
}

export interface AccountMatch {
  gameId: string;
  roomCode: string | null;
  mode: string;
  players: Array<{ userId: number; playerId: string; nickname: string; color: number }>;
  winnerColors: number[];
  durationMs: number;
}

/** Existing account system or the TS migration can implement this small adapter. */
export interface AuthAdapter {
  parseCookies?(header: string): Record<string, string>;
  userFromCookieHeader?(header: string): AccountUser | null;
  minesweeperStatsOf?(userId: number): GameStats | null;
  recordMatch?(match: AccountMatch): number | null;
}

export interface AccountUI {
  getUser(): AccountUser | null;
  onChange(callback: (user: AccountUser | null) => void): void;
  refresh(): Promise<unknown>;
  openLogin(): void;
}
