/** Wire types shared by the server, the hub and every game. No platform globals. */
export type PlayerId = string | number;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Messages<Payloads> = {
  [Type in keyof Payloads]: { type: Type } & Payloads[Type];
}[keyof Payloads];
export interface WireProtocol<Inbound extends { type: string }, Outbound extends { type: string }> {
  decode(value: unknown): Inbound;
  encode(message: Outbound): string;
}

export interface PublicUser {
  id: number;
  username: string;
  nickname: string;
  createdAt: string;
}

export interface AccountMatchPlayer {
  userId?: number | null;
  playerId: PlayerId;
  nickname?: string;
  color: number | null;
}

export interface AccountMatch {
  gameId?: string;
  roomCode?: string | null;
  mode?: string;
  players: AccountMatchPlayer[];
  winnerColor?: number | null;
  winnerColors?: number[];
  durationMs?: number | null;
}

export interface AccountStats {
  games: number;
  wins: number;
  winRate: number;
  byGame: { gameId: string; games: number; wins: number }[];
  recent: {
    matchId: number;
    gameId: string;
    roomCode: string | null;
    mode: string | null;
    playerCount: number;
    endedAt: string;
    isWinner: boolean;
    color: number | null;
    score?: number;
    highest?: number;
  }[];
}

export interface AuthResponse {
  success: boolean;
  enabled?: boolean;
  user?: PublicUser | null;
  stats?: AccountStats | null;
  error?: string;
}

export interface SiteGame {
  id: string;
  name: string;
  subtitle?: string;
  emoji?: string;
  cover?: string;
  accent?: string;
  accentSoft?: string;
  desc?: string;
  path: string;
  status: string;
  players?: string;
  tags?: string[];
}

export interface SiteRegistry {
  site: { title?: string; subtitle?: string; owner?: string };
  games: SiteGame[];
}
