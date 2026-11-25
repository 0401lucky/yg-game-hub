export type RoomState = 'waiting' | 'playing' | 'finished' | 'cleanup';

export interface RoomMember {
  nickname: string;
  isAI: boolean;
  connected: boolean;
  isHost: boolean;
  ready: boolean;
}

export interface HubRoom {
  gameId: string;
  code: string;
  name: string;
  mode: string;
  state: RoomState;
  phaseLabel: string;
  players: RoomMember[];
  capacity: number;
  createdAt: number;
  isPrivate: boolean;
  joinUrl: string | null;
  spectateUrl: string | null;
}

export interface OnlineMember {
  nickname: string;
  status: 'idle' | 'in_room' | 'playing' | 'spectating';
  roomCode: string | null;
}

/** Only presentation data crosses this boundary; game state and tokens stay in the game. */
export interface GameSnapshot {
  rooms: HubRoom[];
  onlineUsers: OnlineMember[];
  activeGames: number;
  savedSessions: number;
  pendingCleanup: number;
}

export interface GameSummary {
  id: string;
  name: string;
  emoji: string;
  path: string;
  onlinePlayers: number;
  roomCount: number;
  waitingRooms: number;
  playingRooms: number;
  activeGames: number;
  savedSessions: number;
}

export interface HubStatus {
  timestamp: string;
  totals: { rooms: number; waitingRooms: number; playingRooms: number; onlinePlayers: number; activeGames: number; savedSessions: number };
  games: GameSummary[];
}

export interface HubRoomsResponse { timestamp: string; rooms: HubRoom[] }
export interface AdminSession { configured: boolean; authenticated: boolean; expiresAt: number | null }
export interface DailyRow { date: string; gamesPlayed: number; gamesFinished: number; peakOnline: number; roomsCreated: number; uniquePlayers: number }
export interface AdminOverview extends HubStatus {
  rooms: HubRoom[];
  onlineUsers: (OnlineMember & { gameId: string })[];
  daily: DailyRow;
  history: DailyRow[];
  system: { uptimeSeconds: number; memoryMB: number; pendingCleanup: number };
}
export interface CleanupResponse {
  cleaned: { sessions: number; rooms: number; connections: number };
  message: string;
}
