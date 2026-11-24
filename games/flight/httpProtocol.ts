import type { PlayerId } from '../shared/protocol.ts';
import type { FlightRoomInfo } from './types.ts';

export interface ServerStats {
  rooms: {total: number; waiting: number; playing: number; finished?: number; cleanup?: number};
  sessions: {total: number};
  players: {totalConnections: number; inRooms: number; inSessions: number};
  timers: {roomDestroyTimers: number; disconnectTimers: number};
}
export interface OnlineUser {playerId: PlayerId; nickname: string; status: string; roomCode: string | null; gameSessionId: string | null}
export interface DailyRow {date: string; gamesPlayed: number; gamesFinished: number; peakOnline: number; roomsCreated: number; uniquePlayers: number}
export interface RoomsResponse {success: boolean; totalRooms: number; rooms: FlightRoomInfo[]; timestamp: string}
