import { send } from './transport.ts';
import WebSocket from 'ws';
import crypto from 'node:crypto';


import * as auth from '../../../backend/auth.ts';
import type { AccountSocket } from '../../../backend/gameModule.ts';
import type { PlayerId } from '../../shared/protocol.ts';
import { errorMessage } from '../../shared/errors.ts';
import { Player, Room, GameSession, roomManager, ROOM_LIFECYCLE } from './roomManager.ts';

import { dailyStats, sanitizeText } from './runtime.ts';
import { getDefaultNickname, getBroadcastTarget, requireBroadcastTarget, withRoomValidation, withGameSessionValidation } from './roomHelpers.ts';
import type { FlightClientMessage } from '../protocol.ts';

import { isLegacyBoardReport, isAuthorityManaged, handleIntent, handleAnimationDone, backgroundPlayers, handleSnapshotRequest } from './authorityRuntime.ts';
import { handleGetReconnectInfo, handleCreateRoom, handleJoinRoom, handleSpectateRoom, handleListRooms, handleSelectColor, handleUpdateNickname, handleUpdateEmoji, handlePlayerStats, relayDisplay, handleProgressBarStart, handleUpdatePlayer, handleUpdateSettings, handleUpdateRoomName, handleUpdateRoomPrivacy, handleReturnToRoom, handleToggleReady, handleStartGame, handleAddAIPlayer, handleRemoveAIPlayer, handleUpdateAIDifficulty, handleKickPlayer, handleConfigurePieceCount, handleAudioLoaded } from './rooms.ts';
import { handleLeaveRoom, handleRejoinRoom, handleRejoinGameSession, handleAITakeoverChange, handleAudioEnabledChange, handleGameEnd, handleForceSettlement, handleGamePause, handleGameResume } from './lifecycle.ts';
import { handleNicknameChange, handleGameInfo, handleChatMessage } from './chat.ts';


export function handleMessage(ws: AccountSocket, playerId: PlayerId, message: FlightClientMessage) {
  // 心跳一来一回很频繁，不写日志，免得把真正有用的消息淹掉
  if (message.type !== 'ping') {
    console.log(`处理消息类型: ${message.type}, 玩家: ${playerId}`);
  }
  try {
    // 棋面已由服务端接管后，旧协议里"客户端上报棋面"的消息一律不再受理，
    // 否则客户端可以绕过规则直接改写权威棋面。客户端应改发 intent。
    if (isLegacyBoardReport(message.type) && isAuthorityManaged(playerId)) {
      console.warn(`[权威棋面] 忽略旧协议消息 ${message.type}（玩家 ${playerId}）`);
      return;
    }
    switch (message.type) {
      case 'ping':
        try {
          send(ws, {
            type: 'pong',
            timestamp: Date.now(),
            playerId
          });
        } catch (e) {
          // ignore
        }
        break;
      case 'pong':
        // 客户端可能会主动回传pong，服务器无需处理
        break;
      case 'identify':
        console.log(`玩家 ${playerId} 身份确认`);
        break;
      case 'getReconnectInfo':
        handleGetReconnectInfo(ws, playerId);
        break;
      case 'createRoom':
        handleCreateRoom(ws, playerId, message);
        break;
      case 'join_room':
        handleJoinRoom(ws, playerId, message);
        break;
      case 'spectate_room':
        handleSpectateRoom(ws, playerId, message);
        break;
      case 'listRooms':
        handleListRooms(ws);
        break;
      case 'leaveRoom':
      case 'leave_room':
        handleLeaveRoom(ws, playerId, message);
        break;
      case 'select_color':
        handleSelectColor(ws, playerId, message);
        break;
      case 'update_nickname':
        handleUpdateNickname(ws, playerId, message);
        break;
      case 'update_emoji':
        handleUpdateEmoji(ws, playerId, message);
        break;
      case 'player_stats':
        handlePlayerStats(ws, playerId, message);
        break;
      case 'teleportIcon':
      case 'diceReset':
        relayDisplay(message.type, playerId, message);
        break;
      case 'progressBarStart':
        handleProgressBarStart(ws, playerId, message);
        break;
      case 'rejoinRoom':
        handleRejoinRoom(ws, playerId, message);
        break;
      case 'rejoinGameSession':
        handleRejoinGameSession(ws, playerId, message);
        break;
      case 'intent':
        handleIntent(ws, playerId, message);
        break;
      case 'animationDone':
        handleAnimationDone(ws, playerId, message);
        break;
      case 'visibilityChange':
        // 前端报前后台：后台页面的动画会被节流，改成不等它演完
        if (message.hidden) backgroundPlayers.add(playerId);
        else backgroundPlayers.delete(playerId);
        break;
      case 'snapshotRequest':
        handleSnapshotRequest(ws, playerId);
        break;
      case 'updatePlayer':
        handleUpdatePlayer(ws, playerId, message);
        break;
      case 'updateSettings':
        handleUpdateSettings(ws, playerId, message);
        break;
      case 'update_room_name':
        handleUpdateRoomName(ws, playerId, message);
        break;
      case 'update_room_privacy':
        handleUpdateRoomPrivacy(ws, playerId, message);
        break;
      case 'returnToRoom':
        handleReturnToRoom(ws, playerId, message);
        break;
      case 'toggle_ready':
        handleToggleReady(ws, playerId, message);
        break;
      case 'start_game':
      case 'startGame':
        handleStartGame(ws, playerId, message);
        break;
      case 'add_ai_player':
        handleAddAIPlayer(ws, playerId, message);
        break;
      case 'remove_ai_player':
        handleRemoveAIPlayer(ws, playerId, message);
        break;
      case 'update_ai_difficulty':
        handleUpdateAIDifficulty(ws, playerId, message);
        break;
      case 'kickPlayer':
        handleKickPlayer(ws, playerId, message);
        break;
      case 'configure_piece_count':
        handleConfigurePieceCount(ws, playerId, message);
        break;
      case 'aiTakeoverChange':
        handleAITakeoverChange(ws, playerId, message);
        break;
      case 'audioEnabledChange':
        handleAudioEnabledChange(ws, playerId, message);
        break;
      case 'nicknameChange':
        handleNicknameChange(ws, playerId, message);
        break;
      case 'gameEnd':
        handleGameEnd(ws, playerId, message);
        break;
      case 'forceSettlement':
        handleForceSettlement(ws, playerId, message);
        break;
      case 'gamePause':
        handleGamePause(ws, playerId, message);
        break;
      case 'gameResume':
        handleGameResume(ws, playerId, message);
        break;
      case 'gameInfo':
        handleGameInfo(ws, playerId, message);
        break;
      case 'audioLoaded':
        handleAudioLoaded(ws, playerId, message);
        break;
      case 'chatMessage':
        handleChatMessage(ws, playerId, message);
        break;
      default:
        console.log(`未知消息类型: ${message.type}`);
        send(ws, { type: 'error', message: `未知消息类型: ${message.type}` });
    }
  } catch (error) {
    console.error('处理消息错误:', error);
    send(ws, { type: 'error', message: errorMessage(error) });
  }
}
