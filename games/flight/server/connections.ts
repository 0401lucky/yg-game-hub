import { send } from './transport.ts';
import { normalizeInboundMessage } from '../protocol.ts';
import WebSocket from 'ws';
import crypto from 'node:crypto';

import type { IncomingMessage } from 'node:http';
import * as auth from '../../../backend/auth.ts';
import type { AccountSocket } from '../../../backend/gameModule.ts';
import type { PlayerId } from '../../shared/protocol.ts';

import { Player, Room, GameSession, roomManager, ROOM_LIFECYCLE } from './roomManager.ts';

import { dailyStats, sanitizeText } from './runtime.ts';
import { getDefaultNickname, getBroadcastTarget, requireBroadcastTarget, withRoomValidation, withGameSessionValidation } from './roomHelpers.ts';


import { handleMessage } from './messages.ts';
import { handlePlayerDisconnect } from './lifecycle.ts';


export function handleConnection(ws: AccountSocket, req: IncomingMessage) {
  let playerId: PlayerId | null = null;

  ws.on('message', (data) => {
    try {
      const message = normalizeInboundMessage(JSON.parse(String(data)));

      // 初始化玩家ID
      if (!playerId) {
        playerId = (message.playerId as string | null | undefined)?.startsWith('player_') ? message.playerId! : generatePlayerId();
        console.log(`玩家 ${playerId} 连接`);
        // 发送连接确认
        send(ws, { type: 'connected', playerId });
        // 已登录账号：把临时 playerId 与账号绑定，结算时据此写战绩
        if (ws.user) auth.rememberPlayer(playerId, ws.user.id);
      }

      // 重连：取消断开定时器
      if (roomManager.disconnectTimers.has(playerId)) {
        clearTimeout(roomManager.disconnectTimers.get(playerId));
        roomManager.disconnectTimers.delete(playerId);
      }

      if (roomManager.disconnectDebounceTimers.has(playerId)) {
        clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
        roomManager.disconnectDebounceTimers.delete(playerId);
      }

      // 不要把 identify/getReconnectInfo 当成“重连回来了”。
      // 只有在收到明确的回房间/回会话指令时才恢复isConnected并广播。
      const isExplicitRejoin = message.type === 'rejoinGameSession' || message.type === 'rejoinRoom' || message.type === 'join_room';

      if (isExplicitRejoin) {
        if (message.type === 'rejoinGameSession') {
          // 仅更新连接引用，状态恢复由 handleRejoinGameSession 显式触发，
          // 以便正确检测 wasDisconnected 并发送归来广播。
          const gameSession = roomManager.getPlayerGameSession(playerId);
          if (gameSession) {
            const player = gameSession.players.get(playerId);
            if (player) {
              player.ws = ws;
            }
          }

          roomManager.setPlayerConnection(playerId, ws);
          handleMessage(ws, playerId, message);
          return;
        }

        const gameSession = roomManager.getPlayerGameSession(playerId);
        if (gameSession) {
          const player = gameSession.players.get(playerId);
          if (player) {
            player.ws = ws;
            // 不要在这里设置 isConnected = true，交给业务处理器处理
            roomManager.setPlayerConnection(playerId, ws);
          }
        } else {
          const room = roomManager.getPlayerRoom(playerId);
          if (room) {
            const player = room.players.get(playerId);
            if (player) {
              player.ws = ws;
              // 不要在这里设置 isConnected = true，交给业务处理器处理
              roomManager.setPlayerConnection(playerId, ws);
              console.log(`玩家 ${playerId} WebSocket 已连接，等待业务重连确认...`);
            }
          } else {
            roomManager.setPlayerConnection(playerId, ws);
          }
        }
      } else {
        // 非重连场景（identify/ping等）：如果玩家在游戏会话或房间中，新连接说明是页面跳转完成或重连，
        // 立即注册新WS并取消旧WS的断线去抖定时器，防止1500ms去抖在rejoinGameSession到达前就触发。
        const inGameSession = !!roomManager.getPlayerGameSession(playerId);
        const inRoom = !!roomManager.getPlayerRoom(playerId);
        if (inGameSession || inRoom) {
          roomManager.setPlayerConnection(playerId, ws);
          if (roomManager.disconnectDebounceTimers.has(playerId)) {
            clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
            roomManager.disconnectDebounceTimers.delete(playerId);
            console.log(`玩家 ${playerId} 新WS连接（${inGameSession ? '游戏会话' : '房间'}），取消断线去抖定时器`);
          }
        } else {
          roomManager.setPlayerConnection(playerId, ws);
        }
      }

      handleMessage(ws, playerId, message);
    } catch (error) {
      console.error('消息解析错误:', error);
      send(ws, { type: 'error', message: '消息格式错误' });
    }
  });

  function onDisconnect(playerId: PlayerId): void {

    if (roomManager.disconnectDebounceTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
      roomManager.disconnectDebounceTimers.delete(playerId);
    }

    // 连接切换去抖：页面跳转/短暂网络抖动时，客户端可能会迅速建立新连接。
    const debounceMs = 1500;
    const debounceTimer = setTimeout(() => {
      roomManager.disconnectDebounceTimers.delete(playerId);

      const currentWs = roomManager.getPlayerConnection(playerId);
      const switchedConnection = !!(currentWs && currentWs !== ws);

      if (!switchedConnection) {
        roomManager.playerConnections.delete(playerId);
      }

      if (roomManager.disconnectTimers.has(playerId)) {
        clearTimeout(roomManager.disconnectTimers.get(playerId));
        roomManager.disconnectTimers.delete(playerId);
      }

      // 如果玩家已经有了新的WebSocket连接（例如从房间页跳转到游戏页），
      if (switchedConnection) {
        console.log(`玩家 ${playerId} WebSocket 连接已切换到新连接，跳过断线处理`);
        return;
      }

      const roomCode = roomManager.playerRooms.get(playerId);
      const room = roomCode ? roomManager.getRoom(roomCode) : null;
      const gameSession = roomManager.getPlayerGameSession(playerId);

      if (room && room.gameState !== 'playing' && !gameSession) {
        const disconnectTimeout = 10000;
        console.log(`玩家 ${playerId} 在房间配置阶段断开，标记为离线，${disconnectTimeout / 1000}秒后移除`);

        const player = room.players.get(playerId);
        if (player) {
          player.isConnected = false;
          player.disconnectedAt = Date.now();
        }

        room.broadcast({
          type: 'playerDisconnected',
          playerId,
          room: room.toJSON()
        });

        const timer = setTimeout(() => {
          console.log(`玩家 ${playerId} 重连超时，执行移除`);
          const currentPlayer = room.players.get(playerId);
          if (currentPlayer && !currentPlayer.isConnected) {
            room.removePlayer(playerId);
            roomManager.playerRooms.delete(playerId);

            if (room.players.size > 0) {
              // 如果房间中已经没有任何人类玩家（只剩AI），直接走房间销毁流程
              if (!room.hasHumanPlayers()) {
                console.log(`房间 ${roomCode} 仅剩AI玩家，立即销毁`);
                roomManager.immediateDestroyRoom(roomCode!);
              } else {
                room.broadcast({
                  type: 'playerLeft',
                  playerId,
                  room: room.toJSON()
                });
              }
            } else {
              console.log(`房间 ${roomCode} 已无玩家，立即销毁`);
              roomManager.immediateDestroyRoom(roomCode!);
            }
          }
          roomManager.disconnectTimers.delete(playerId);
        }, disconnectTimeout);
        roomManager.disconnectTimers.set(playerId, timer);
        return;
      }

      handlePlayerDisconnect(playerId);
    }, debounceMs);

    roomManager.disconnectDebounceTimers.set(playerId, debounceTimer);
  }
  ws.on('close', () => {
    console.log(`玩家 ${playerId} 断开连接`);

    if (!playerId) return;
    onDisconnect(playerId);
  });
}


// 生成玩家ID
export function generatePlayerId() {
  return `player_${Math.random().toString(36).substr(2, 4)}`;
}
