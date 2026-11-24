import { send } from './transport.ts';
import WebSocket from 'ws';
import crypto from 'node:crypto';


import * as auth from '../../../backend/auth.ts';
import type { AccountSocket } from '../../../backend/gameModule.ts';
import type { PlayerId } from '../../shared/protocol.ts';
import { errorMessage } from '../../shared/errors.ts';
import { Player, Room, GameSession, roomManager, ROOM_LIFECYCLE } from './roomManager.ts';
import type { SessionPlayer, SessionPlayerInput } from './roomManager.ts';
import { dailyStats, sanitizeText } from './runtime.ts';
import { getDefaultNickname, getBroadcastTarget, requireBroadcastTarget, withRoomValidation, withGameSessionValidation } from './roomHelpers.ts';
import type { FlightRequest, FlightResponse, FlightEnvelope } from '../protocol.ts';

import { forceDetachPlayerFromExistingContexts } from './lifecycle.ts';
import { sendSnapshotTo, startAuthoritySession } from './authorityRuntime.ts';
import { spectatorDisplayName } from './chat.ts';


// ...

export function handleGetReconnectInfo(ws: AccountSocket, playerId: PlayerId) {
  try {
    // 优先：游戏会话（游戏进行中断线）
    const gameSession = roomManager.getPlayerGameSession(playerId);
    if (gameSession && gameSession.roomCode) {
      const room = roomManager.getRoom(gameSession.roomCode);
      const sessionPlayer = gameSession.players ? gameSession.players.get(playerId)! : null;

      const canReconnect = !!(
        room &&
        sessionPlayer &&
        sessionPlayer.isConnected === false &&
        gameSession.players.has(playerId)
      );
      console.log(`[重连信息] player=${playerId} sessionFound=true isConnected=${sessionPlayer?.isConnected} canReconnect=${canReconnect} roomCode=${gameSession.roomCode}`);

      send(ws, {
        type: 'reconnectInfo',
        canReconnect,
        roomCode: canReconnect ? gameSession.roomCode : null,
        source: 'gameSession'
      });
      return;
    }

    // 其次：房间配置阶段断线
    const room = roomManager.getPlayerRoom(playerId);
    if (room) {
      const roomPlayer = room.players ? room.players.get(playerId)! : null;

      const canReconnect = !!(
        roomPlayer &&
        roomPlayer.isConnected === false &&
        room.players.has(playerId)
      );
      console.log(`[重连信息] player=${playerId} roomFound=true isConnected=${roomPlayer?.isConnected} canReconnect=${canReconnect} roomCode=${room.code}`);

      send(ws, {
        type: 'reconnectInfo',
        canReconnect,
        roomCode: canReconnect ? room.code : null,
        source: 'room'
      });
      return;
    }

    console.log(`[重连信息] player=${playerId} 未找到任何会话或房间`);
    send(ws, { type: 'reconnectInfo', canReconnect: false, roomCode: null });
  } catch (error) {
    console.error('获取重连信息失败:', error);
    send(ws, { type: 'reconnectInfo', canReconnect: false, roomCode: null });
  }
}


export function handleListRooms(ws: AccountSocket) {
  try {
    const rooms = roomManager.listPublicRooms();
    send(ws, { type: 'roomsList', rooms });
  } catch (error) {
    console.error('获取房间列表失败:', error);
    send(ws, { type: 'error', message: '获取房间列表失败' });
  }
}


// 建房幂等缓存：同一个 requestId 在窗口期内只建一间房。
// 以前客户端断线重连会把 createRoom 补发一遍，服务端每收到一次就把玩家从原房间搬走、
// 建一间新房，原来那间随之销毁 —— 房里另一位玩家直接被告知「房间不存在」。
export const CREATE_ROOM_IDEMPOTENCY_MS = 60000;

export const createRoomRequests: Map<string, {roomCode: string; ts: number}> = new Map();
 // `${playerId}:${requestId}` -> { roomCode, ts }

export function pruneCreateRoomRequests(now: number) {
  for (const [key, entry] of createRoomRequests) {
    if (now - entry.ts > CREATE_ROOM_IDEMPOTENCY_MS) createRoomRequests.delete(key);
  }
}


export function handleCreateRoom(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'createRoom'>) {
  const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
  const now = Date.now();

  if (requestId) {
    pruneCreateRoomRequests(now);
    const cacheKey = `${playerId}:${requestId}`;
    const cached = createRoomRequests.get(cacheKey);
    if (cached && now - cached.ts <= CREATE_ROOM_IDEMPOTENCY_MS) {
      const existing = roomManager.getRoom(cached.roomCode);
      if (existing && existing.players.has(playerId)) {
        console.log(`[建房幂等] ${playerId} 重复请求 ${requestId}，复用房间 ${cached.roomCode}`);
        existing.players.get(playerId)!.ws = ws;
        roomManager.setPlayerConnection(playerId, ws);
        send(ws, { type: 'roomCreated', room: existing.toJSON(), replayed: true });
        return;
      }
    }
  }

  // 检查玩家是否在其他房间中
  const existingRoom = roomManager.getPlayerRoom(playerId);
  if (existingRoom) {
    console.log(`[迁移] 玩家 ${playerId} 已在房间 ${existingRoom.code} 中，执行静默物理分离以创建新房间`);

    // 直接执行底层静默清理
    forceDetachPlayerFromExistingContexts(playerId, null, true);
  }

  // 确保没有任何残留上下文
  forceDetachPlayerFromExistingContexts(playerId, null, true);

  const emoji = message.emoji;
  const player = new Player(playerId, ws, auth.nicknameForRequest(ws, message.nickname), emoji);
  const room = roomManager.createRoom(player);
  send(ws, { type: 'roomCreated', room: room.toJSON() });

  if (requestId) {
    createRoomRequests.set(`${playerId}:${requestId}`, { roomCode: room.code, ts: now });
  }

  // 每日统计：记录创建房间
  dailyStats.recordRoomCreated();
}


export function handleJoinRoom(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'join_room'>) {
  const roomCode = message.roomCode;
  const room = roomManager.getRoom(roomCode);
  if (!room) {
    send(ws, { type: 'error', message: '房间不存在或已被销毁', code: 'roomGone' });
    return;
  }

  // 检查玩家是否已经在该房间中，或者在当前房间的游戏会话中（硬离开后尝试回来）
  const gameSession = roomManager.getPlayerGameSession(playerId);
  const isInSession = !!(gameSession && gameSession.roomCode === roomCode && gameSession.players.has(playerId));

  if (room.players.has(playerId) || isInSession) {
    // 如果不在房间但在会话中，说明是之前“硬离开”后又想重连，需先恢复房间成员身份
    if (!room.players.has(playerId) && isInSession) {
      console.log(`玩家 ${playerId} 正在重回游戏中房间 ${roomCode} (从游戏会话恢复)`);
      const sessionPlayer = gameSession.players.get(playerId)!;
      const player = new Player(playerId, ws, sessionPlayer.nickname, sessionPlayer.emoji);
      player.color = sessionPlayer.color;
      player.isHost = sessionPlayer.isHost;

      // 重新加入房间映射
      room.players.set(playerId, player);
      roomManager.playerRooms.set(playerId, roomCode);
    }

    const existingPlayer = room.players.get(playerId)!;

    // 清除断开连接定时器（如果有）
    if (roomManager.disconnectTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectTimers.get(playerId));
      roomManager.disconnectTimers.delete(playerId);
      console.log(`玩家 ${playerId} 重新加入房间 ${roomCode}，清除断开定时器`);
    }

    // 恢复连接
    existingPlayer.ws = ws;
    existingPlayer.isConnected = true;
    existingPlayer.disconnectedAt = null;

    // 重新关联房间/连接映射
    roomManager.playerRooms.set(playerId, roomCode);
    roomManager.setPlayerConnection(playerId, ws);

    // 只有客户端显式传了 nickname/emoji 才更新（避免用 undefined/空值覆盖）
    if (Object.prototype.hasOwnProperty.call(message, 'nickname')) {
      const nicknameStr = (message.nickname == null ? '' : String(message.nickname));
      const trimmed = nicknameStr.trim();
      if (trimmed) {
        existingPlayer.nickname = trimmed;
      }
    }
    if (Object.prototype.hasOwnProperty.call(message, 'emoji')) {
      if (message.emoji != null) {
        existingPlayer.emoji = message.emoji;
      }
    }

    // 发送加入成功消息（如果游戏正在进行，补齐gameData以支持重连跳转）
    const response: FlightResponse<'roomJoined'> = { type: 'roomJoined', room: room.toJSON() };
    if (room.gameState === 'playing' && room.gameSessionId) {
      const gameSession = roomManager.getGameSession(room.gameSessionId);
      if (gameSession && gameSession.gameData) {
        response.gameData = gameSession.gameData;
      } else {
        response.gameData = { gameSessionId: room.gameSessionId };
      }
    }
    send(ws, response);

    // 广播重连消息给其他玩家
    room.broadcast({
      type: 'playerReconnected',
      playerId,
      room: room.toJSON()
    }, playerId);
    console.log(`玩家 ${playerId} 重新加入房间 ${roomCode}，广播 playerReconnected`);
    return;
  }
  // 对局已经开打：不在这一局里的人（比如超时被移除后又回来的）就别进房间了，
  // 这时房间里只剩个空壳，进来什么也做不了。客户端收到这个 code 会清掉本地房间并回首页
  if (room.gameState === 'playing' && room.gameSessionId) {
    send(ws, { type: 'error', message: '该房间的对局已开始', code: 'gameStarted' });
    return;
  }

  // 房间满员：计算已占用席位 = 真实玩家 + AI 玩家
  const aiCount = room.settings?.aiPlayers ? room.settings.aiPlayers.length : 0;
  const totalPlayerCount = room.players.size + aiCount;
  if (totalPlayerCount >= 4) {
    send(ws, { type: 'error', message: '房间已满', code: 'roomFull' });
    return;
  }

  // 检查玩家是否在其他房间中（非当前要加入的房间）
  const existingRoom = roomManager.getPlayerRoom(playerId);
  if (existingRoom && existingRoom.code !== roomCode) {
    console.log(`[迁移] 玩家 ${playerId} 已在房间 ${existingRoom.code} 中，执行静默物理分离以加入 ${roomCode}`);

    // 直接执行底层静默清理
    forceDetachPlayerFromExistingContexts(playerId, roomCode, true);
  }

  // 再次确保没有任何残留上下文（针对可能存在的残留 Session）
  forceDetachPlayerFromExistingContexts(playerId, roomCode, true);

  const player = new Player(playerId, ws, auth.nicknameForRequest(ws, message.nickname), message.emoji);
  roomManager.joinRoom(roomCode, player);

  // 发送加入成功消息
  const response: FlightResponse<'roomJoined'> = { type: 'roomJoined', room: room.toJSON() };
  if (room.gameState === 'playing' && room.gameSessionId) {
    // 如果游戏正在进行，发送完整的游戏会话数据（包括defeatCounts等）
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession && gameSession.gameData) {
      response.gameData = gameSession.gameData;
      console.log(`发送游戏数据给重连玩家 ${playerId}，包含击败计数:`, gameSession.gameData.defeatCounts);
    } else {
      // 后备方案：只发送gameSessionId
      response.gameData = { gameSessionId: room.gameSessionId };
    }
  }
  send(ws, response);

  // 广播玩家加入
  room.broadcast({
    type: 'playerJoined',
    player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
    room: room.toJSON()
  }, playerId); // 排除当前玩家
}


export function handleSpectateRoom(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'spectate_room'>) {
  const roomCode = message.roomCode;
  const room = roomManager.getRoom(roomCode);
  if (!room) {
    send(ws, { type: 'error', message: '房间不存在或已被销毁' });
    return;
  }

  // 如果观战者本身就是游戏中的玩家，转为重连而非观战
  if (room.gameSessionId) {
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession && gameSession.players.has(playerId)) {
      console.log(`[观战→重连] 玩家 ${playerId} 试图观战自己的游戏，转为重连处理`);
      roomManager.setPlayerConnection(playerId, ws);
      const player = gameSession.players.get(playerId)!;
      if (player) {
        player.ws = ws;
      }
      const response: FlightResponse<'spectateJoined'> = {
        type: 'spectateJoined',
        room: room.toJSON(),
        gameData: gameSession.gameData,
        gameSessionId: room.gameSessionId,
        gameSession: gameSession.toJSON(),
        isReconnect: true
      };
      send(ws, response);
      sendSnapshotTo(ws, room.gameSessionId);
      console.log(`玩家 ${playerId} 已通过观战路径重连游戏`);
      return;
    }
  }

  // 正常观战者
  const MAX_SPECTATORS = 5;
  if (room.spectators.size >= MAX_SPECTATORS) {
    send(ws, { type: 'error', message: '观战人数已满' });
    return;
  }

  roomManager.setPlayerConnection(playerId, ws);
  roomManager.playerSpectatingRooms.set(playerId, roomCode);
  room.spectators.add(playerId);
  room.spectatorNames.set(playerId, sanitizeText(message.nickname).trim() || spectatorDisplayName(playerId));

  if (room.gameSessionId) {
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession) {
      gameSession.spectators.add(playerId);
    }
  }

  // 发送加入观战成功消息
  const response: FlightResponse<'spectateJoined'> = { type: 'spectateJoined', room: room.toJSON() };
  if (room.gameState === 'playing' && room.gameSessionId) {
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession && gameSession.gameData) {
      response.gameData = gameSession.gameData;
      response.gameSessionId = room.gameSessionId;
      response.gameSession = gameSession.toJSON();
    }
  }
  send(ws, response);
  if (room.gameSessionId) sendSnapshotTo(ws, room.gameSessionId);
  console.log(`玩家 ${playerId} 开始观战房间 ${roomCode}`);
}


// 选择颜色：四个座位颜色固定，谁坐哪个座位就按哪个颜色参加回合轮转。
// 座位已被其他玩家占用时，两人交换座位，避免先后入房顺序把座位锁死。
export const handleSelectColor = withRoomValidation<'select_color'>((ws, playerId, message, room, player) => {
  const colorIndex = Number(message.colorIndex);
  if (![1, 2, 3, 4].includes(colorIndex)) {
    send(ws, { type: 'error', message: '无效的颜色' });
    return;
  }

  // AI座位由房主通过AI配置增删，不参与玩家换座
  if (room.settings.aiPlayers.some(ai => ai.color === colorIndex)) {
    send(ws, { type: 'error', message: '该颜色已被AI玩家占用' });
    return;
  }

  const occupant = Array.from(room.players.values())
    .find(p => p.color === colorIndex && p.id !== playerId);

  const previousColor = player.color;
  if (occupant) {
    // 换座要求本人原有座位有效，否则会让两人撞到同一个颜色
    if (![1, 2, 3, 4].includes(previousColor!)) {
      send(ws, { type: 'error', message: '当前座位异常，无法换座' });
      return;
    }
    occupant.color = previousColor;
  }
  player.color = colorIndex;

  room.broadcast({
    type: 'playerUpdated',
    player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
    room: room.toJSON()
  });
});


// 玩家资料（昵称/表情）在游戏会话或房间两处都可能存在，统一走这条更新与广播路径
export function applyPlayerProfileUpdate(playerId: PlayerId, mutate: (player: Player | SessionPlayer) => void) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (gameSession && gameSession.players.has(playerId)) {
    mutate(gameSession.players.get(playerId)!);
    const player = gameSession.players.get(playerId)!;
    gameSession.broadcast({
      type: 'playerUpdated',
      player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji, stats: player.stats || null }
    });
    return true;
  }

  const room = roomManager.getPlayerRoom(playerId);
  if (room) {
    const player = room.players.get(playerId)!;
    if (player) {
      mutate(player);
      room.broadcast({
        type: 'playerUpdated',
        player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji, stats: player.stats || null },
        room: room.toJSON()
      });
    }
    return true;
  }

  return false;
}


// 更新昵称（不使用房间验证中间件，允许玩家在房间外更新）
export function handleUpdateNickname(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'update_nickname'>) {
  try {
    const nickname = message.nickname;
    const manualInput = message.manualInput === true;
    // 确保nickname是字符串，如果为null/undefined则设置为空字符串
    const nicknameStr = (nickname == null ? '' : String(nickname));
    const nextNickname = manualInput ? sanitizeText(nicknameStr) : nicknameStr;
    const newNickname = nextNickname.trim() || getDefaultNickname(playerId);

    const updated = applyPlayerProfileUpdate(playerId, (player) => {
      // 房主昵称变化时，默认房名跟随更新（自定义房名不动）
      const room = roomManager.getPlayerRoom(playerId);
      if (room && room.host && room.host.id === playerId) {
        const oldDefaultRoomName = `${player.nickname}的房间`;
        if (room.name === oldDefaultRoomName || !room.name) {
          room.name = `${newNickname}的房间`;
        }
      }
      player.nickname = newNickname;
    });

    if (!updated) {
      console.log(`玩家 ${playerId} 更新昵称为 ${newNickname}（不在房间中）`);
    }
  } catch (error) {
    console.error('更新昵称失败:', error);
    send(ws, { type: 'error', message: '更新昵称失败' });
  }
}


/** 玩家本机战绩（联机模式的对局数、胜率、称号数，只统计打完的局）：进入联机时上报，随玩家数据转给其他人 */
export function handlePlayerStats(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'player_stats'>) {
  try {
    const raw = message.stats || {};
    const games = Math.max(0, Math.floor(Number(raw.games) || 0));
    const wins = Math.max(0, Math.min(games, Math.floor(Number(raw.wins) || 0)));
    const titles = Math.max(0, Math.floor(Number(raw.titles) || 0));
    const updated = applyPlayerProfileUpdate(playerId, (player) => {
      player.stats = { games, wins, titles };
    });
    if (!updated) console.log(`玩家 ${playerId} 上报战绩 ${wins}/${games}（不在房间中，已忽略）`);
  } catch (error) {
    console.error('更新战绩失败:', error);
  }
}


export function handleUpdateEmoji(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'update_emoji'>) {  try {
    const emoji = message.emoji;
    const updated = applyPlayerProfileUpdate(playerId, (player) => {
      player.emoji = emoji;
    });

    if (!updated) {
      console.log(`玩家 ${playerId} 更新emoji为 ${emoji}（不在房间中）`);
    }
  } catch (error) {
    console.error('更新表情失败:', error);
    send(ws, { type: 'error', message: '更新表情失败' });
  }
}


export const handleUpdateRoomName = withRoomValidation<'update_room_name'>((ws, playerId, message, room) => {
  const name = message.name;
  const nameStr = (name == null ? '' : String(name));
  const newName = nameStr.trim();

  room.name = newName;

  room.broadcast({
    type: 'roomNameUpdated',
    name: room.name,
    room: room.toJSON()
  });
}, true);


export const handleUpdateRoomPrivacy = withRoomValidation<'update_room_privacy'>((ws, playerId, message, room) => {
  const isPrivate = !!message.isPrivate;
  room.isPrivate = isPrivate;
  room.broadcast({ type: 'roomPrivacyUpdated', isPrivate, room: room.toJSON() });
}, true);


export const handleReturnToRoom = withRoomValidation<'returnToRoom'>((ws, playerId, message, room, player) => {
  // 游戏结束后：首次返回房间的玩家成为房主且自动准备；后续返回者不允许覆盖房主
  if (room.postGameHostId && room.postGameHostId !== playerId) {
    room.broadcast({
      type: 'roomReset',
      room: room.toJSON()
    });
    return;
  }

  room.gameState = 'waiting';
  room.gameSessionId = null;

  // 锁定首次返回房间的房主
  room.postGameHostId = playerId;

  // 切换房主为触发者
  room.host = player;
  for (const p of room.players.values()) {
    p.isHost = (p.id === playerId);
  }

  // 重置准备状态：新房主已准备，其余未准备
  room.playerReadyStatus = new Map();
  for (const p of room.players.values()) {
    room.playerReadyStatus.set(p.id, p.id === playerId);
  }

  room.broadcast({
    type: 'roomReset',
    room: room.toJSON()
  });
}, true);


// 踢出玩家（需要房主权限）
export const handleKickPlayer = withRoomValidation<'kickPlayer'>((ws, playerId, message, room) => {
  const targetId = message.playerId;
  if (!targetId) throw new Error('缺少目标玩家ID');
  if (targetId === playerId) throw new Error('不能踢出自己');

  const targetPlayer = room.players.get(targetId);
  if (!targetPlayer) throw new Error('目标玩家不存在');

  if (room.gameState === 'playing') {
    throw new Error('游戏进行中，无法踢出玩家');
  }

  console.log(`[踢人] 房主 ${playerId} 准备踢出玩家 ${targetId} (${targetPlayer.nickname})`);

  // 向被踢玩家发送通知
  const targetWs = roomManager.getPlayerConnection(targetId);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    send(targetWs, {
      type: 'kicked',
      reason: 'host_kicked',
      message: '你已被房主踢出房间'
    });
  }

  // 从房间移除玩家
  room.removePlayer(targetId);
  roomManager.playerRooms.delete(targetId);

  // 广播玩家被踢出的消息
  room.broadcast({
    type: 'playerLeft',
    playerId: targetId,
    reason: 'kicked',
    room: room.toJSON()
  });

  console.log(`[踢人] 房主 ${playerId} 已踢出玩家 ${targetId}`);
}, true);


export function handleUpdatePlayer(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'updatePlayer'>) {
  const room = roomManager.getPlayerRoom(playerId);
  if (!room) throw new Error('玩家不在任何房间中');

  const player = room.players.get(playerId)!;
  if (!player) throw new Error('玩家不存在');

  // 更新玩家信息
  if (message.nickname !== undefined) {
    // 确保nickname是字符串，如果为null/undefined则设置为空字符串
    const nicknameStr = (message.nickname == null ? '' : String(message.nickname));
    player.nickname = nicknameStr.trim() || getDefaultNickname(playerId);
  }
  if (message.emoji !== undefined) {
    player.emoji = message.emoji;
  }
  if (message.color !== undefined) {
    player.color = message.color;
  }

  // 广播更新
  room.broadcast({
    type: 'playerUpdated',
    player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
    room: room.toJSON()
  });
}


// 更新房间设置（需要房主权限）
export const handleUpdateSettings = withRoomValidation<'updateSettings'>((ws, playerId, message, room) => {
  room.updateSettings(message.settings);
  room.broadcast({ type: 'settingsUpdated', settings: room.settings, room: room.toJSON() });
}, true);


// 切换玩家准备状态
export function handleToggleReady(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'toggle_ready'>) {
  try {
    const room = roomManager.getPlayerRoom(playerId);
    if (!room) throw new Error('玩家不在任何房间中');

    const player = room.players.get(playerId)!;
    if (!player) throw new Error('玩家不在房间中');

    // 房主自动准备，不需要手动切换
    if (player.isHost) {
      return;
    }

    // 更新准备状态
    const isReady = message.isReady ?? false;
    room.playerReadyStatus.set(playerId, isReady);

    console.log(`玩家 ${playerId} 准备状态更新为: ${isReady}`);

    // 广播准备状态变化
    room.broadcast({
      type: 'playerReadyStatusChanged',
      playerId: playerId,
      isReady: isReady
    });
  } catch (error) {
    console.error('切换准备状态失败:', error);
    send(ws, { type: 'error', message: errorMessage(error) });
  }
}


export function handleStartGame(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'startGame' | 'start_game'>) {
  const room = roomManager.getPlayerRoom(playerId);
  if (!room) throw new Error('玩家不在任何房间中');
  if (room.gameState === 'playing') throw new Error('游戏已经开始');
  if (room.players.size < 2) throw new Error('至少需要2名玩家才能开始游戏');

  // 房主眼前的面板设置随开局一起送来：中途那几条 updateSettings 万一丢了，
  // 开局用的还是这套配置（道具模式、欢乐模式、起手积分）
  if (message && message.settings && room.host && room.host.id === playerId) {
    room.updateSettings(message.settings);
  }

  // 开始新一局时，清除结算返回房主锁定
  room.postGameHostId = null;

  // 开始新一局时，重置所有真实玩家的AI托管状态（避免上一局/异常超时遗留导致开局即托管）
  for (const p of room.players.values()) {
    if (p && !p.isAI) {
      p.isAITakeover = false;
    }
  }

  // 检查所有非房主玩家是否都准备
  for (const [pId, player] of room.players.entries()) {
    if (!player.isHost) {
      const isReady = room.playerReadyStatus.get(pId) || false;
      if (!isReady) {
        throw new Error('请等待所有玩家准备');
      }
    }
  }

  // 更新房间状态
  if (room.gameSessionId) {
    console.log(`房间 ${room.code} 开启新游戏，立即清理旧会话: ${room.gameSessionId}`);
    roomManager.removeGameSession(room.gameSessionId);
  }

  room.gameState = 'playing';
  const gameSessionId = roomManager.generateGameSessionId();
  room.gameSessionId = gameSessionId;

  // 收集玩家（真实+AI），设置房主标志
  const realPlayers: SessionPlayerInput[] = Array.from(room.players.values()).map(p => ({
    id: p.id,
    color: p.color!,
    playerNumber: p.color,  // 玩家编号等于颜色编号（1-4）
    nickname: p.nickname,
    emoji: p.emoji,
    isAI: false,
    isAITakeover: false,
    // 沿用房间上记录的音效偏好，保证换局后仍能恢复
    audioEnabled: p.audioEnabled,
    isHost: p.id === room.host.id  // 设置房主标志
  }));
  const aiPlayers: SessionPlayerInput[] = room.settings.aiPlayers.map(ai => ({
    id: ai.color,
    color: ai.color,
    playerNumber: ai.color,  // 玩家编号等于颜色编号（1-4）
    nickname: ai.nickname,
    emoji: ai.emoji || 'bot',
    isAI: true,
    difficulty: ai.difficulty || 'easy',
    isHost: false  // AI玩家不是房主
  }));
  const allPlayers = [...realPlayers, ...aiPlayers];

  // 创建游戏会话
  const hostPlayer = realPlayers.find(p => p.isHost);
  const gameSession = roomManager.createGameSession(
    gameSessionId,
    allPlayers,
    room.settings.pieceCount,
    room.code,
    hostPlayer ? hostPlayer.id : null,
    room.settings.skillMode,
    room.settings.happyMode,
    room.settings.initialEnergy
  );

  // 继承房间内的观战者
  if (room.spectators) {
    room.spectators.forEach(s => gameSession.spectators.add(s));
  }

  console.log('游戏会话创建完成，房主:', realPlayers.find(p => p.isHost)?.id);

  // 设置初始当前玩家（颜色最小的玩家）
  const sortedPlayers = allPlayers.sort((a, b) => a.color - b.color);
  const firstPlayer = sortedPlayers[0].color;
  gameSession.gameData.currentPlayer = firstPlayer;
  gameSession.gameData.gamePhase = 'rolling';
  console.log(`游戏开始，设置初始当前玩家: ${firstPlayer}`);

  // 建立连接映射
  realPlayers.forEach(player => {
    roomManager.setPlayerConnection(player.id, roomManager.getPlayerConnection(player.id) || ws);
  });

  // 设置强制加载超时，防止有人掉线导致全部卡在加载页
  setTimeout(() => {
    const currentSession = roomManager.getGameSession(gameSessionId);
    if (currentSession) {
      const realCount = Array.from(currentSession.players.values()).filter(p => !p.isAI).length;
      if (currentSession.audioLoadedPlayers.size < realCount) {
        console.log(`[音频加载] 游戏会话 ${gameSessionId} 强制超时，发送 allAudioLoaded`);
        // 补充所有真实玩家到已加载列表，避免后续重连判定出错
        for (const [pId, p] of currentSession.players) {
          if (!p.isAI) currentSession.audioLoadedPlayers.add(pId);
        }
        currentSession.broadcast({ type: 'allAudioLoaded', gameSessionId });
      }
    }
  }, 15000);

  // 广播游戏开始
  room.broadcast({
    type: 'gameStarted',
    gameSessionId,
    pieceCount: room.settings.pieceCount,
    skillMode: room.settings.skillMode || false,
    happyMode: room.settings.happyMode || false,
    room: room.toJSON()
  });

  // 交给服务端权威层接管棋面：此后骰子与位置由服务端计算
  startAuthoritySession(gameSession).catch(error => {
    console.error(`[权威棋面] 会话 ${gameSessionId} 初始化失败:`, error);
  });

  // 每日统计：记录游戏开始
  dailyStats.recordGameStarted();
}


// 添加AI玩家（需要房主权限）
export const handleAddAIPlayer = withRoomValidation<'add_ai_player'>((ws, playerId, message, room) => {
  const { colorIndex, difficulty } = message;
  const usedColors = [...Array.from(room.players.values()).map(p => p.color), ...room.settings.aiPlayers.map(ai => ai.color)];
  if (usedColors.includes(colorIndex)) throw new Error('该颜色已被占用');

  // 生成AI玩家名称（与前端逻辑一致）
  const easyBots: number[] = [];
  const hardBots: number[] = [];

  // 包含当前要添加的AI玩家
  const allAIPlayers = [...room.settings.aiPlayers, { color: colorIndex, difficulty: difficulty || 'easy' }];

  allAIPlayers.forEach(ai => {
    if (ai.difficulty === 'hard') {
      hardBots.push(ai.color);
    } else {
      easyBots.push(ai.color);
    }
  });

  easyBots.sort((a, b) => a - b);
  hardBots.sort((a, b) => a - b);

  let botName;
  const aiDifficulty = difficulty || 'easy';

  if (aiDifficulty === 'hard') {
    const indexInHard = hardBots.indexOf(colorIndex) + 1;
    botName = `AI-${indexInHard}`;
  } else {
    const indexInEasy = easyBots.indexOf(colorIndex) + 1;
    botName = `Bot-${indexInEasy}`;
  }

  const aiPlayer = {
    color: colorIndex,
    difficulty: aiDifficulty,
    nickname: botName,
    emoji: 'bot'
  };
  room.settings.aiPlayers.push(aiPlayer);

  // 广播AI添加
  room.broadcast({ type: 'aiPlayerAdded', aiPlayer, room: room.toJSON() });
}, true);


// 移除AI玩家（需要房主权限）
export const handleRemoveAIPlayer = withRoomValidation<'remove_ai_player'>((ws, playerId, message, room) => {
  const { colorIndex } = message;
  const aiIndex = room.settings.aiPlayers.findIndex(ai => ai.color === colorIndex);
  if (aiIndex === -1) throw new Error('AI玩家不存在');

  room.settings.aiPlayers.splice(aiIndex, 1);

  // 重新编号剩余 AI 玩家的昵称
  const remainingAI = room.settings.aiPlayers;
  const easyBots = remainingAI.filter(ai => ai.difficulty === 'easy').sort((a, b) => a.color - b.color);
  const hardBots = remainingAI.filter(ai => ai.difficulty === 'hard').sort((a, b) => a.color - b.color);

  remainingAI.forEach(ai => {
    if (ai.difficulty === 'hard') {
      const indexInHard = hardBots.indexOf(ai) + 1;
      ai.nickname = `AI-${indexInHard}`;
    } else {
      const indexInEasy = easyBots.indexOf(ai) + 1;
      ai.nickname = `Bot-${indexInEasy}`;
    }
  });

  // 广播AI移除
  room.broadcast({ type: 'aiPlayerRemoved', colorIndex, room: room.toJSON() });
}, true);


// 更新AI难度（需要房主权限）
export const handleUpdateAIDifficulty = withRoomValidation<'update_ai_difficulty'>((ws, playerId, message, room) => {
  const { colorIndex, difficulty } = message;
  const aiPlayer = room.settings.aiPlayers.find(ai => ai.color === colorIndex);
  if (!aiPlayer) throw new Error('AI玩家不存在');

  // 更新难度
  aiPlayer.difficulty = difficulty;

  // 按难度分类所有AI玩家
  const easyBots: number[] = [];
  const hardBots: number[] = [];

  room.settings.aiPlayers.forEach(ai => {
    if (ai.difficulty === 'hard') {
      hardBots.push(ai.color);
    } else {
      easyBots.push(ai.color);
    }
  });

  // 按颜色排序
  easyBots.sort((a, b) => a - b);
  hardBots.sort((a, b) => a - b);

  // 重新计算所有AI玩家的昵称
  room.settings.aiPlayers.forEach(ai => {
    if (ai.difficulty === 'hard') {
      const indexInHard = hardBots.indexOf(ai.color) + 1;
      ai.nickname = `AI-${indexInHard}`;
    } else {
      const indexInEasy = easyBots.indexOf(ai.color) + 1;
      ai.nickname = `Bot-${indexInEasy}`;
    }
  });

  console.log(`所有AI玩家昵称已更新:`, room.settings.aiPlayers.map(ai => `${ai.nickname}(颜色${ai.color},难度${ai.difficulty})`));

  // 广播难度更新（包含所有AI玩家的最新数据）
  room.broadcast({ type: 'aiDifficultyUpdated', colorIndex, difficulty, room: room.toJSON() });
}, true);


// 掷骰子（使用通用广播目标）

// 展示类消息只是把发送者的表现转发给同局其他人，字段直接透传，不需服务端裁决
export const DISPLAY_RELAYS = {
  teleportIcon: [], // 只是「有人开了传送门」的信号，图标显隐由快照裁决
  progressBarStart: [],
  diceReset: []
};


export function relayDisplay(type: 'teleportIcon' | 'progressBarStart' | 'diceReset', playerId: PlayerId, message: FlightEnvelope) {
  const target = requireBroadcastTarget(playerId);

  const payload = { type, playerId, timestamp: message.timestamp };
  target.broadcast(payload);
}


export function handleProgressBarStart(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'progressBarStart'>) {
  // 只转发显示；思考窗口由服务端维护（见 mirrorSnapshot），
  // 收客户端上报的时间等于把「本回合还剩多久」交给客户端自己说了算
  relayDisplay('progressBarStart', playerId, message);
}


// 配置棋子数量（需要房主权限）
export const handleConfigurePieceCount = withRoomValidation<'configure_piece_count'>((ws, playerId, message, room) => {
  const { pieceCount } = message;
  if (![1, 2, 3, 4].includes(pieceCount)) throw new Error('无效的棋子数量');

  room.settings.pieceCount = pieceCount;
  // 广播配置结果
  room.broadcast({ type: 'pieceCountConfigured', pieceCount, room: room.toJSON() });
}, true);


// 音频加载完成（使用游戏会话中间件）
export const handleAudioLoaded = withGameSessionValidation<'audioLoaded'>((ws, playerId, message, gameSession) => {
  // 记录音频加载状态
  gameSession.audioLoadedPlayers.add(playerId);
  // 计算真实玩家数量（排除AI）
  const realPlayerCount = Array.from(gameSession.players.values()).filter(p => !p.isAI).length;
  console.log(`[音频加载] 玩家 ${playerId} 加载完成. 会话: ${gameSession.gameSessionId}, 当前已加载: ${gameSession.audioLoadedPlayers.size}/${realPlayerCount}. 列表:`, Array.from(gameSession.audioLoadedPlayers));

  // 广播加载状态
  gameSession.broadcast({
    type: 'audioLoaded',
    playerId,
    loadedCount: gameSession.audioLoadedPlayers.size,
    totalCount: realPlayerCount,
    allLoaded: gameSession.audioLoadedPlayers.size === realPlayerCount
  });

  // 所有真实玩家加载完成
  if (gameSession.audioLoadedPlayers.size === realPlayerCount) {
    // 如果游戏已经开始，说明这是重连补发的 audioLoaded，不广播 allAudioLoaded
    // 避免干扰其他玩家正在进行的游戏流程（如AI操作、骰子动画等）
    if (gameSession.gameData?.gameOfficiallyStarted) {
      console.log(`[音频加载] 游戏已开始，跳过 allAudioLoaded 广播（防止干扰进行中的游戏流程）`);
    } else {
      console.log(`[音频加载] 游戏会话 ${gameSession.gameSessionId} 所有玩家已加载，发送 allAudioLoaded`);
      gameSession.broadcast({ type: 'allAudioLoaded', gameSessionId: gameSession.gameSessionId });
    }
  }
});
