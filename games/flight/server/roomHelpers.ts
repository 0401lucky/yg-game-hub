import { roomManager } from './roomManager.ts';
import type { Room, GameSession, Player, SessionPlayer } from './roomManager.ts';
import type { AccountSocket } from '../../../backend/gameModule.ts';
import type { PlayerId } from '../../shared/protocol.ts';
import type { FlightClientPayloads, FlightRequest } from '../protocol.ts';

export function getDefaultNickname(playerId: PlayerId): string {
  return `玩家_${String(playerId).slice(-4)}`;
}
export function getBroadcastTarget(playerId: PlayerId): GameSession | Room | null {
  return roomManager.getPlayerGameSession(playerId) || roomManager.getPlayerRoom(playerId) || null;
}
export function requireBroadcastTarget(playerId: PlayerId): GameSession | Room {
  const target = getBroadcastTarget(playerId);
  if (!target) throw new Error('玩家不在任何房间或游戏会话中');
  return target;
}
export function withRoomValidation<Type extends keyof FlightClientPayloads>(
  handler: (ws: AccountSocket, playerId: PlayerId, message: FlightRequest<Type>, room: Room, player: Player) => void,
  requireHost = false,
) {
  return (ws: AccountSocket, playerId: PlayerId, message: FlightRequest<Type>): void => {
    const room = roomManager.getPlayerRoom(playerId);
    if (!room) throw new Error('玩家不在任何房间中');
    const player = room.players.get(playerId);
    if (!player) throw new Error('玩家不存在');
    if (requireHost && room.host.id !== playerId) throw new Error('只有房主可以执行此操作');
    handler(ws, playerId, message, room, player);
  };
}
export function withGameSessionValidation<Type extends keyof FlightClientPayloads>(
  handler: (ws: AccountSocket, playerId: PlayerId, message: FlightRequest<Type>, gameSession: GameSession, player: SessionPlayer) => void,
) {
  return (ws: AccountSocket, playerId: PlayerId, message: FlightRequest<Type>): void => {
    const session = roomManager.getPlayerGameSession(playerId);
    const player = session?.players.get(playerId);
    if (!session || !player) return;
    handler(ws, playerId, message, session, player);
  };
}
