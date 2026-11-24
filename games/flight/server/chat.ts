import WebSocket from 'ws';
import crypto from 'node:crypto';


import * as auth from '../../../backend/auth.ts';
import type { AccountSocket } from '../../../backend/gameModule.ts';
import type { PlayerId } from '../../shared/protocol.ts';

import { Player, Room, GameSession, roomManager, ROOM_LIFECYCLE } from './roomManager.ts';
import type { SessionPlayer } from './roomManager.ts';
import { dailyStats, sanitizeText } from './runtime.ts';
import { getDefaultNickname, getBroadcastTarget, requireBroadcastTarget, withRoomValidation, withGameSessionValidation } from './roomHelpers.ts';
import type { FlightRequest, FlightResponse } from '../protocol.ts';




// 昵称变化只负责把显示名转发给同局其他人，权威昵称仍由 update_nickname 写入
export function handleNicknameChange(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'nicknameChange'>) {
  const target = requireBroadcastTarget(playerId);

  // 房主可代理由其托管的玩家发起改名
  const targetPlayerId = message.playerId || playerId;
  const manualInput = message.manualInput === true;
  const rawNickname = message.nickname == null ? '' : String(message.nickname);
  const nextNickname = manualInput ? sanitizeText(rawNickname) : rawNickname;

  target.broadcast({
    type: 'nicknameChange',
    playerId: targetPlayerId,
    nickname: nextNickname,
    timestamp: message.timestamp
  });
}



// 游戏信息同步（使用通用广播目标，避免回显给发送者）
// 战报的正史由服务端事件流留档（authority.eventLog）承担，这里只做实时转发，
// 不再复制一份消息，避免刷新回放与实时消息叠加出重复。
export function handleGameInfo(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'gameInfo'>) {
  const target = requireBroadcastTarget(playerId);

  // 战报由发送方本地先渲染一次，这里排除发送者避免重复
  target.broadcast({
    type: 'gameInfo',
    playerId,
    messageData: message.messageData,
    timestamp: message.timestamp
  }, playerId);
}


/**
 * 房主变更只留档、不广播：各端收到 hostChanged 后会自己渲染一条本地提示，
 * 这里再播一遍就重复了；但那份提示是客户端本地生成的，刷新即丢，所以补一条历史。
 */
export function recordHostChange(gameSession: GameSession, newHost: SessionPlayer) {
  if (!gameSession || !newHost) return;
  gameSession.recordChat({
    type: 'chatMessage',
    message: `${newHost.nickname} 成为了新房主`,
    playerNumber: null,
    playerName: null,
    isSystemMessage: true,
    timestamp: Date.now()
  });
}


/**
 * 系统提示（退出/回来了/首发权转移…）：广播的同时在会话或房间的聊天历史里留一份。
 * 原来只广播不留档，刷新后这些行就没了（右侧面板里只剩玩家聊天）。
 */
export function broadcastSystemChat(target: Room | GameSession, messageText: string, excludePlayerId: PlayerId | null = null) {
  const payload: FlightResponse<'chatMessage'> = {
    type: 'chatMessage',
    message: messageText,
    playerNumber: null,
    playerName: null,
    isSystemMessage: true,
    timestamp: Date.now()
  };
  if (target instanceof GameSession) target.recordChat(payload);
  else if (target instanceof Room) target.appendRoomChatMessage(payload);
  target.broadcast(payload, excludePlayerId);
}


// 观战者没填昵称时拿 playerId 兜底，前缀换成中文，面板里不至于露出一串英文 ID
export function spectatorDisplayName(playerId: PlayerId) {
  return String(playerId).replace(/^player_/, '玩家_');
}


// 处理聊天消息
export function handleChatMessage(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'chatMessage'>) {
  const rawMessage = message?.message ?? '';
  const sanitizedMessage = sanitizeText(rawMessage);
  if (!String(sanitizedMessage).trim()) {
    return;
  }

  // 观战者不在 playerRooms / playerSessions 里，只能借观战映射定位房间；
  // 广播与留档沿用房间/会话既有通道，观战席位已在两者的 broadcast 投递范围内
  const spectatingRoomCode = roomManager.playerSpectatingRooms.get(playerId);
  if (spectatingRoomCode) {
    const room = roomManager.getRoom(spectatingRoomCode);
    if (!room) throw new Error('观战房间不存在');
    const gameSession = room.gameSessionId ? roomManager.getGameSession(room.gameSessionId) : null;
    const chatPayload: FlightResponse<'chatMessage'> = {
      type: 'chatMessage',
      playerId,
      playerNumber: null,
      playerName: room.spectatorNames.get(playerId) || spectatorDisplayName(playerId),
      message: sanitizedMessage,
      isSpectatorMessage: true,
      timestamp: message?.timestamp || Date.now()
    };
    if (gameSession) gameSession.recordChat(chatPayload);
    else room.appendRoomChatMessage({ ...chatPayload, isSystemMessage: false });
    (gameSession || room).broadcast(chatPayload);
    return;
  }

  const target = requireBroadcastTarget(playerId);

  // 获取玩家信息
  const player = target.players.get(playerId);
  if (!player) throw new Error('找不到玩家信息');

  const chatPayload: FlightResponse<'chatMessage'> = {
    type: 'chatMessage',
    playerId,
    playerNumber: player.color, // 统一用color（1-4）
    playerName: sanitizeText(player.nickname),
    message: sanitizedMessage,
    timestamp: message?.timestamp || Date.now()
  };

  // 在房间阶段写入房间聊天历史（保留最近50条）
  if (target instanceof Room) {
    target.appendRoomChatMessage({
      playerId: chatPayload.playerId,
      playerNumber: chatPayload.playerNumber,
      playerName: chatPayload.playerName,
      message: chatPayload.message,
      timestamp: chatPayload.timestamp,
      isSystemMessage: false
    });
  } else if (target instanceof GameSession) {
    // 对局内聊天同样留一份，刷新/重连后可回放
    target.recordChat(chatPayload);
  }

  // 广播聊天消息
  target.broadcast(chatPayload);
}
