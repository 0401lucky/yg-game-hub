import type { GameSnapshot, HubRoom, OnlineMember, RoomMember, RoomState } from '../../../web/operationsProtocol.ts';
import { roomManager } from './roomManager.ts';

export function getOverview(): GameSnapshot {
  const connected = new Set([...roomManager.playerConnections].filter(([, ws]) => ws.readyState === 1).map(([id]) => id));
  const rooms: HubRoom[] = [...roomManager.rooms.values()].map(room => {
    const session = room.gameSessionId ? roomManager.getGameSession(room.gameSessionId) : null;
    const players: RoomMember[] = [...(session?.players ?? room.players).values()].map(player => ({
      nickname: player.nickname, isAI: !!player.isAI, connected: !!player.isAI || connected.has(player.id),
      isHost: player.id === room.host.id, ready: room.playerReadyStatus.get(player.id) ?? false,
    }));
    if (!session) for (const ai of room.settings.aiPlayers) {
      players.push({ nickname: ai.nickname, isAI: true, connected: true, isHost: false, ready: true });
    }
    const occupied = players.some(player => !player.isAI && player.connected);
    const state: RoomState = !occupied && room.gameState !== 'finished' ? 'cleanup'
      : room.gameState === 'playing' ? 'playing' : room.gameState === 'finished' ? 'finished' : 'waiting';
    return {
      gameId: 'flight', code: room.code, name: room.name,
      mode: `${room.settings.happyMode ? '欢乐' : '经典'}${room.settings.skillMode ? ' · 道具' : ''} · ${room.settings.pieceCount} 枚棋子`,
      state, phaseLabel: { waiting: '等待开局', playing: '对局中', finished: '已结算', cleanup: '等待清理' }[state],
      players, capacity: 4, createdAt: room.createdAt, isPrivate: room.isPrivate,
      joinUrl: state === 'waiting' && players.length < 4 ? `/games/flight/?room=${encodeURIComponent(room.code)}` : null,
      spectateUrl: state === 'playing' && session ? `/games/flight/spectate.html?room=${encodeURIComponent(room.code)}` : null,
    };
  });
  const onlineUsers: OnlineMember[] = [...connected].map(id => {
    const session = roomManager.getPlayerGameSession(id);
    const room = roomManager.getPlayerRoom(id);
    const spectating = roomManager.playerSpectatingRooms.get(id);
    const player = session?.players.get(id) ?? room?.players.get(id);
    return {
      nickname: player?.nickname ?? roomManager.playerConnections.get(id)?.user?.nickname ?? `玩家_${String(id).slice(-4)}`,
      status: session ? 'playing' : spectating ? 'spectating' : room ? 'in_room' : 'idle',
      roomCode: session?.roomCode ?? spectating ?? room?.code ?? null,
    };
  });
  return { rooms, onlineUsers, activeGames: rooms.filter(room => room.state === 'playing').length,
    savedSessions: roomManager.gameSessions.size, pendingCleanup: rooms.filter(room => room.state === 'cleanup').length };
}
