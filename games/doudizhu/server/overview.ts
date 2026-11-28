import type { GameSnapshot, HubRoom, RoomState } from '../../../web/operationsProtocol.ts';
import type { DoudizhuService } from './service.ts';

export function getOverview(service: DoudizhuService): GameSnapshot {
  const rooms: HubRoom[] = [...service.rooms.values()].map(room => {
    const players = room.players.filter(player => player !== null).map(player => ({
      nickname: player.nickname, isAI: player.isBot, connected: player.isBot || player.connected,
      isHost: player.id === room.hostId, ready: player.ready,
    }));
    const state: RoomState = !players.some(player => !player.isAI && player.connected) ? 'cleanup'
      : !room.game ? 'waiting' : room.game.phase === 'ended' ? 'finished' : 'playing';
    const label = { waiting: '等待开局', playing: room.game?.phase === 'bidding' ? '叫分中' : '出牌中', finished: '已结算', cleanup: '等待清理' };
    const host = players.find(player => player.isHost);
    const modeName = room.mode === 'roguelike' ? '肉鸽斗地主' : room.mode === 'laizi' ? '癞子斗地主' : '经典斗地主';
    return { gameId: 'doudizhu', code: room.code, name: `${host?.nickname ?? '牌友'}的牌桌`,
      mode: `${modeName} · ${{ easy: '简单', hard: '困难', hell: '地狱' }[room.difficulty]}人机`,
      state, phaseLabel: label[state], players, capacity: 3, createdAt: room.createdAt, isPrivate: false,
      joinUrl: state === 'waiting' && players.length < 3 ? `/games/doudizhu/?room=${encodeURIComponent(room.code)}` : null,
      spectateUrl: null };
  });
  const onlineUsers = [...service.sessions.values()].filter(session => session.ws?.readyState === 1).map(session => {
    const room = session.roomCode ? service.rooms.get(session.roomCode) : null;
    return { nickname: session.nickname,
      status: room?.game && room.game.phase !== 'ended' ? 'playing' as const : room ? 'in_room' as const : 'idle' as const,
      roomCode: room?.code ?? null };
  });
  return { rooms, onlineUsers, activeGames: rooms.filter(room => room.state === 'playing').length,
    savedSessions: [...service.rooms.values()].filter(room => room.game !== null).length,
    pendingCleanup: rooms.filter(room => room.state === 'cleanup').length };
}
