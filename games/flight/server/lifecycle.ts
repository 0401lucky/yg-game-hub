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
import type { FlightRequest, FlightResponse } from '../protocol.ts';
import type { FlightGameData } from '../types.ts';
import { backgroundPlayers, isOnGamePage, gamePagePlayers, markGamePage, sendSnapshotTo, sendGameInfoHistoryTo, accumulatePausedTime, getAuthoritySession, commitSnapshot, botDriver } from './authorityRuntime.ts';
import { recordHostChange, broadcastSystemChat } from './chat.ts';


// -------------------------- 断开连接处理（优化冗余逻辑）--------------------------
export function handlePlayerDisconnect(playerId: PlayerId) {
  console.log(`处理玩家 ${playerId} 断开连接`);

  // 清理玩家连接映射
  roomManager.playerConnections.delete(playerId);
  // 前后台标记跟着连接走：断线的人已经不在「等演完」的名单里，别留脏标记
  backgroundPlayers.delete(playerId);
  // 对局页标记也摘掉：他要是只开着大厅，后面再断开就不该再往对局里播一条退出
  const wasOnGamePage = isOnGamePage(playerId);
  gamePagePlayers.delete(playerId);

  // 1. 游戏会话中处理
  let handledInSession = false;
  for (const gameSession of roomManager.gameSessions.values()) {
    if (!gameSession.players.has(playerId)) continue;

    handledInSession = true;
    const player = gameSession.players.get(playerId)!;
    if (player) {
      const wasHost = player.isHost || false;

      // 检查是否已经发送过退出消息，避免重复
      const alreadyLeft = !player.isConnected && !!player.disconnectedAt;

      player.isConnected = false;
      player.ws = null;
      player.disconnectedAt = player.disconnectedAt || Date.now();

      // 房主转移逻辑
      if (wasHost) {
        const doTransfer = () => {
          // 重新检查当前房主是否仍不在线（可能已经重连了）
          const currentHost = gameSession.players.get(playerId)!;
          const currentWs = roomManager.getPlayerConnection(playerId);
          const isCurrentWsOpen = currentWs && currentWs.readyState === 1;

          if (currentHost && currentHost.isConnected && isCurrentWsOpen) {
            console.log(`房主 ${playerId} 已在线，取消房主转移`);
            return;
          }

          // 如果在等待期间，有其他人通过重连已经接管了房主，也不需要再转移了
          const actualCurrentHost = Array.from(gameSession.players.values()).find(p => p.isHost);
          if (actualCurrentHost && actualCurrentHost.id !== playerId && actualCurrentHost.isConnected) {
             console.log(`房主已变更为 ${actualCurrentHost.id}，取消转移`);
             return;
          }

          // 找到第一个在线且WebSocket真实打开的真实玩家作为新房主
          let newHost = null;
          for (const [pId, p] of gameSession.players) {
            const pWs = roomManager.getPlayerConnection(pId);
            const isWsOpen = pWs && pWs.readyState === 1;
            if (pId !== playerId && p.isConnected && isWsOpen && !p.isAI) {
              newHost = p;
              break;
            }
          }

          if (newHost) {
            console.log(`房主 ${playerId} 离线，转移房主给 ${newHost.id}`);
            for (const [pId, p] of gameSession.players) {
              if (p) p.isHost = (pId === newHost.id);
            }
            gameSession.hostId = newHost.id;

            // 同步更新Room中的房主（如果房间存在）
            if (gameSession.roomCode) {
              const room = roomManager.getRoom(gameSession.roomCode);
              if (room) {
                const roomNewHost = room.players.get(newHost.id);
                if (roomNewHost) {
                  room.host = roomNewHost;
                  for (const p of room.players.values()) {
                    if (p) p.isHost = (p.id === roomNewHost.id);
                  }
                  console.log(`房间 ${room.code} 房主已同步更新为 ${newHost.id}`);
                }
              }
            }

            // 广播房主变更消息（各端会自己渲染一条提示，这里顺带留档供刷新后回放）
            recordHostChange(gameSession, newHost);
            gameSession.broadcast({
              type: 'hostChanged',
              oldHostId: playerId,
              newHostId: newHost.id,
              newHostNickname: newHost.nickname,
              gameSession: gameSession.toJSON(),
              timestamp: Date.now()
            });

            console.log(`新房主: ${newHost.id} (${newHost.nickname})`);
          } else {
            console.log(`房主 ${playerId} 断开连接，但没有其他在线玩家可以接管`);
          }
        };

        const timeSinceStart = Date.now() - (gameSession.createdAt || 0);
        const isInitialLoading = timeSinceStart < 15000;

        if (isInitialLoading) {
          console.log(`游戏刚开始（加载中），延迟 10 秒后检查是否需要转移房主`);
          setTimeout(doTransfer, 10000);
        } else {
          doTransfer();
        }
      }

      // 广播离线消息：已经报过离线的、或者本来就没在对局页面上的（只是大厅那条连接断了）
      // 都不再往对局里播「退出游戏」——否则回到房间列表再关窗口会白报一条
      if (!alreadyLeft && wasOnGamePage) {
        broadcastSystemChat(gameSession, `${player.nickname}退出游戏`);
      }
      // 广播断开状态（只发送玩家列表，不发送全量 gameData 减轻其他客户端解析负担）
      const playersArray = Array.from(gameSession.players.values()).map(p => ({
        id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
        isHost: p.isHost || false, isConnected: p.isConnected, isAI: p.isAI
      }));
      gameSession.broadcast({
        type: 'playerDisconnected',
        playerId,
        players: playersArray
      });

      // 如果是当前玩家断线
      if (gameSession.gameData && player.color === gameSession.gameData.currentPlayer) {
        // 如果游戏尚未正式开始（首发玩家还没投骰子就跑了）
        if (!gameSession.gameData.gameOfficiallyStarted) {
          // 找到下一个在线的人类玩家
          const allPlayers = Array.from(gameSession.players.values());
          const humanPlayers = allPlayers.filter(p => !p.isAI && p.id !== playerId && p.isConnected);

          if (humanPlayers.length > 0) {
            // 按照颜色顺序找下一个
            const sortedHumans = humanPlayers.sort((a, b) => a.color - b.color);
            // 找比当前颜色大的最小颜色，如果没有就找最小的
            let nextHuman = sortedHumans.find(p => p.color > player.color);
            if (!nextHuman) nextHuman = sortedHumans[0];
            // 执行转移
            gameSession.gameData.currentPlayer = nextHuman.color;
            gameSession.gameData.thinkingStartTime = Date.now(); // 重置思考时间

            // 广播转移消息
            broadcastSystemChat(gameSession, `首发玩家离线，首发权转移给 ${nextHuman.nickname}`);

            gameSession.broadcast({
              type: 'playerTurnChange',
              newPlayer: nextHuman.color,
              timestamp: Date.now(),
              reason: 'first_player_disconnect'
            });
          } else {
            console.log(`[开局优化] 没有其他在线人类玩家可以接管首发权，保持原样（将由AI接管）`);
          }
        } else {
          console.log(`当前玩家${player.color}断线（游戏阶段：${gameSession.gameData.gamePhase}），等待超时自动接管`);
        }
      }

      // 同步更新房间中的玩家状态（如果房间存在）
      if (gameSession.roomCode) {
        const room = roomManager.getRoom(gameSession.roomCode);
        if (room) {
          const roomPlayer = room.players.get(playerId);
          if (roomPlayer) {
            roomPlayer.isConnected = false;
            roomPlayer.ws = null;
            roomPlayer.disconnectedAt = Date.now();
          }
          // 检查房间是否已没有人类玩家
          room.checkEmptyRoom();
        }
      }
    }
  }

  if (handledInSession) {
    return;
  }

  // 1.5 观战者处理
  const spectatingRoomCode = roomManager.playerSpectatingRooms.get(playerId);
  if (spectatingRoomCode) {
    const room = roomManager.getRoom(spectatingRoomCode);
    if (room) {
      room.spectators.delete(playerId);
      room.spectatorNames.delete(playerId);
      if (room.gameSessionId) {
        const gameSession = roomManager.getGameSession(room.gameSessionId);
        if (gameSession) {
          gameSession.spectators.delete(playerId);
        }
      }
    }
    roomManager.playerSpectatingRooms.delete(playerId);
    return;
  }

  // 2. 房间中处理（非游戏状态）
  const roomCode = roomManager.playerRooms.get(playerId);
  if (!roomCode) return;

  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  // 游戏中保留位置
  if (room.gameState === 'playing') {
    const player = room.players.get(playerId);
    if (player) {
      player.isConnected = false;
      player.ws = null;
      player.disconnectedAt = Date.now();

      // 同步更新游戏会话中的玩家连接状态，确保重连信息能正确匹配
      if (room.gameSessionId) {
        const gameSession = roomManager.getGameSession(room.gameSessionId);
        if (gameSession) {
          const sessionPlayer = gameSession.players.get(playerId)!;
          if (sessionPlayer) {
            sessionPlayer.isConnected = false;
          }
        }
      }

      // 广播离线消息
      broadcastSystemChat(room, `${player.nickname}退出游戏`);
      // 广播断开状态
      room.broadcast({
        type: 'playerDisconnected',
        playerId,
        room: room.toJSON()
      });
    }
    return;
  }

  // 3. 非游戏状态：30秒后移除玩家
  const player = room.players.get(playerId);
  if (player) {
    player.isConnected = false;
    player.ws = null;
    player.disconnectedAt = Date.now();

    // 检查房间是否已没有人类玩家
    room.checkEmptyRoom();

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
            roomManager.immediateDestroyRoom(roomCode);
          } else {
            room.broadcast({
              type: 'playerLeft',
              playerId,
              room: room.toJSON()
            });
          }
        } else {
          console.log(`房间 ${roomCode} 已无玩家，立即销毁`);
          roomManager.immediateDestroyRoom(roomCode);
        }
      }
      roomManager.disconnectTimers.delete(playerId);
    }, 30000);
    roomManager.disconnectTimers.set(playerId, timer);
    return;
  }

  handlePlayerDisconnect(playerId);
}


export function forceDetachPlayerFromExistingContexts(playerId: PlayerId, nextRoomCode: string | null = null, isSilentMigration = false) {
  const currentRoomCode = roomManager.playerRooms.get(playerId);
  const currentSessionId = roomManager.playerSessions.get(playerId);

  if (currentRoomCode && nextRoomCode && currentRoomCode === nextRoomCode) {
    return;
  }

  if (currentSessionId) {
    const gs = roomManager.getGameSession(currentSessionId);
    if (gs && gs.players && gs.players.has(playerId)) {
      const p = gs.players.get(playerId);
      if (p) {
        p.isConnected = false;
        p.ws = null;
        p.disconnectedAt = Date.now();
      }

      // 如果玩家是主动切换到其他房间/会话：
      // 1. 如果游戏已结束或未开始，彻底移除
      // 2. 如果游戏进行中，保留玩家数据（转为离线/被托管），仅删除 Session 映射
      if (gs.gameState !== 'playing') {
        gs.players.delete(playerId);
        // 显式清理音频加载状态等残留标记
        if (gs.audioLoadedPlayers) gs.audioLoadedPlayers.delete(playerId);
        if (gs.aiTakeoverPlayers) gs.aiTakeoverPlayers.delete(playerId);
      } else {
        console.log(`[迁移] 玩家 ${playerId} 正在游戏中迁移，保留会话内数据以供观战/托管`);
        // 确保被标记为托管（如果之前没托管的话）
        if (gs.aiTakeoverPlayers) gs.aiTakeoverPlayers.add(playerId);
      }

      // 如果是静默迁移，严禁发送任何广播
      if (!isSilentMigration) {
        try {
          broadcastSystemChat(gs, `${p?.nickname || playerId}退出游戏`);
          const detachPlayers = Array.from(gs.players.values()).map(p => ({
            id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
            isHost: p.isHost || false, isConnected: p.isConnected, isAI: p.isAI
          }));
          gs.broadcast({
            type: 'playerDisconnected',
            playerId,
            players: detachPlayers
          });
        } catch (e) {
          console.error('forceDetachPlayerFromExistingContexts 游戏会话广播失败:', e);
        }
      } else {
        console.log(`[迁移] 玩家 ${playerId} 静默脱离旧游戏会话 ${currentSessionId}`);
      }
    }
    roomManager.playerSessions.delete(playerId);
  }

  if (currentRoomCode) {
    const room = roomManager.getRoom(currentRoomCode);
    if (room && room.players && room.players.has(playerId)) {
      const rp = room.players.get(playerId);
      if (rp) {
        rp.isConnected = false;
        rp.ws = null;
        rp.disconnectedAt = Date.now();
      }

      // 玩家已切换房间：从旧房间彻底移除
      room.removePlayer(playerId);

      // 如果是静默迁移，严禁发送任何广播
      if (!isSilentMigration) {
        try {
          room.broadcast({
            type: 'playerDisconnected',
            playerId,
            room: room.toJSON()
          });
        } catch (e) {
          console.error('forceDetachPlayerFromExistingContexts 房间广播失败:', e);
        }
      } else {
        console.log(`[迁移] 玩家 ${playerId} 静默脱离旧房间 ${currentRoomCode}`);
      }
    }
    roomManager.playerRooms.delete(playerId);
  }
}


export function handleLeaveRoom(ws: AccountSocket, playerId: PlayerId, message: Partial<FlightRequest<'leave_room' | 'leaveRoom'>> = {}, isSilentMigration = false) {
  // 处理观战者离开
  const spectatingRoomCode = roomManager.playerSpectatingRooms.get(playerId);
  if (spectatingRoomCode) {
    const room = roomManager.getRoom(spectatingRoomCode);
    if (room) {
      room.spectators.delete(playerId);
      room.spectatorNames.delete(playerId);
      if (room.gameSessionId) {
        const gameSession = roomManager.getGameSession(room.gameSessionId);
        if (gameSession) {
          gameSession.spectators.delete(playerId);
        }
      }
    }
    roomManager.playerSpectatingRooms.delete(playerId);
    return;
  }

  const roomCode = roomManager.playerRooms.get(playerId);
  if (!roomCode) return;

  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  // 如果是静默迁移（加入新房间时），跳过所有广播逻辑，仅清理映射
  if (isSilentMigration) {
    console.log(`[迁移] 玩家 ${playerId} 正在从旧房间 ${roomCode} 静默迁移到新房间，彻底拦截广播`);

    // 清除断线延迟定时器
    if (roomManager.disconnectTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectTimers.get(playerId));
      roomManager.disconnectTimers.delete(playerId);
    }

    // 从房间数据结构中彻底移除，不走任何广播逻辑
    room.removePlayer(playerId);
    roomManager.playerRooms.delete(playerId);

    // 如果玩家在游戏会话中，也仅做映射清理，不触发 handlePlayerDisconnect
    const gameSessionId = roomManager.playerSessions.get(playerId);
    if (gameSessionId) {
      const gameSession = roomManager.getGameSession(gameSessionId);
      if (gameSession && gameSession.players.has(playerId)) {
        const player = gameSession.players.get(playerId)!;
        player.isConnected = false;
        player.ws = null;
        player.disconnectedAt = player.disconnectedAt || Date.now();
        // 关键：不要在这里调用 gameSession.broadcast 或 handlePlayerDisconnect
      }
      roomManager.playerSessions.delete(playerId);
    }

    // 如果旧房间空了且没在游戏中，销毁
    if (room.players.size === 0 && room.gameState !== 'playing') {
      roomManager.rooms.delete(roomCode);
    }
    return;
  }

  // 检查是否是游戏结束后离开
  const isGameEnded = message.reason === 'game_ended';

  const leaveReason = message.reason;
  const isHardLeave = leaveReason === 'return_home' || leaveReason === 'quit_game' || leaveReason === 'user_quit_game';

  // 游戏进行中：leave_room 视为“软掉线/可重连离开”，不移除玩家、不销毁会话
  // 典型场景：玩家从游戏页返回主页/联机面板、刷新页面等
  if (room.gameState === 'playing' && !isGameEnded && !isHardLeave) {
    console.log(`玩家 ${playerId} 在游戏中发送leave_room，按掉线处理（保留重连资格）`);
    try {
      handlePlayerDisconnect(playerId);
    } catch (e) {
      console.error('处理游戏中leave_room为断线时出错:', e);
    }

    // 尝试给客户端一个确认（连接可能即将关闭，失败可忽略）
    try {
      send(ws, { type: 'roomLeft', soft: true });
    } catch (err) {
      // ignore
    }
    return;
  }

  if (room.gameState === 'playing' && !isGameEnded && isHardLeave) {
    console.log(`玩家 ${playerId} 在游戏中发送leave_room(${leaveReason})，按主动退出处理（不保留重连资格）`);

    // 清除断线延迟定时器（玩家主动离开，无需等待）
    if (roomManager.disconnectTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectTimers.get(playerId));
      roomManager.disconnectTimers.delete(playerId);
    }

    const gameSessionId = roomManager.playerSessions.get(playerId);
    const gameSession = gameSessionId ? roomManager.getGameSession(gameSessionId) : null;
    const leavingFromSession = !!(gameSession && gameSession.players && gameSession.players.has(playerId));

    let leavingPlayerSnapshot = null;
    if (leavingFromSession) {
      leavingPlayerSnapshot = gameSession.players.get(playerId)!;
    }

    // 从房间移除
    room.removePlayer(playerId);
    roomManager.playerRooms.delete(playerId);

    // 清理连接映射
    roomManager.playerConnections.delete(playerId);

    // 从会话处理
    if (leavingFromSession) {
      const wasHost = !!(leavingPlayerSnapshot && leavingPlayerSnapshot.isHost);
      const leavingColor = leavingPlayerSnapshot ? leavingPlayerSnapshot.color : null;

      // 不要从游戏会话中删除主动退出的玩家，而是将他们保留，仅标记为离线
      const sessionPlayer = gameSession.players.get(playerId)!;
      if (sessionPlayer) {
        sessionPlayer.isConnected = false;
        sessionPlayer.isHost = false;
        console.log(`玩家${playerId}主动退出游戏`);
      }

      // 房主转移
      if (wasHost) {
        let newHost = null;
        for (const [pId, p] of gameSession.players) {
          if (p && !p.isAI && p.isConnected) {
            newHost = p;
            break;
          }
        }

        if (!newHost) {
          for (const [pId, p] of gameSession.players) {
            if (p && !p.isAI) {
              newHost = p;
              break;
            }
          }
        }

        if (newHost) {
          for (const [pId, p] of gameSession.players) {
            if (p) p.isHost = (pId === newHost.id);
          }
          gameSession.hostId = newHost.id;

          const roomNewHost = room.players.get(newHost.id);
          if (roomNewHost) {
            room.host = roomNewHost;
            for (const p of room.players.values()) {
              if (p) p.isHost = (p.id === roomNewHost.id);
            }
          }

          recordHostChange(gameSession, newHost);
          gameSession.broadcast({
            type: 'hostChanged',
            oldHostId: playerId,
            newHostId: newHost.id,
            newHostNickname: newHost.nickname,
            gameSession: gameSession.toJSON(),
            timestamp: Date.now()
          });
        }
      }

      // 广播状态更新，前端会据此更新为AI状态
      gameSession.broadcast({
        type: 'playerUpdated',
        players: Array.from(gameSession.players.values()),
        timestamp: Date.now()
      });

      // 触发断开连接消息，确保前端UI表现一致（断开线标志等）
      const disconnectPlayers = Array.from(gameSession.players.values()).map(p => ({
        id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
        isHost: p.isHost || false, isConnected: false, isAI: p.isAI
      }));
      gameSession.broadcast({
        type: 'playerDisconnected',
        playerId,
        players: disconnectPlayers
      });
    }

    // 广播房间更新
    if (room.hasHumanPlayers()) {
      room.broadcast({ type: 'playerLeft', playerId, room: room.toJSON() });
    } else {
      console.log(`房间 ${roomCode} 已无人类玩家，立即销毁`);
      roomManager.immediateDestroyRoom(roomCode);
    }

    try {
      send(ws, { type: 'roomLeft' });
    } catch (err) {
      // ignore
    }
    return;
  }

  // 清除断线延迟定时器（玩家主动离开，无需等待）
  if (roomManager.disconnectTimers.has(playerId)) {
    clearTimeout(roomManager.disconnectTimers.get(playerId));
    roomManager.disconnectTimers.delete(playerId);
  }

  // 执行离开逻辑
  room.removePlayer(playerId);
  roomManager.playerRooms.delete(playerId);

  // 如果是游戏结束后离开，且房间已空，标记为已结算
  if (isGameEnded && room.players.size === 0 && room.gameState === 'playing') {
    console.log(`房间 ${roomCode} 游戏已结束，所有玩家已离开，标记为已结算`);
    room.gameState = 'finished';
  }

  // 立即广播离开消息（在发送确认之前，确保其他玩家立即收到）
  if (room.hasHumanPlayers()) {
    room.broadcast({ type: 'playerLeft', playerId, room: room.toJSON() });
  } else {
    // 如果没有人类玩家了（只剩AI或全空），立即销毁
    console.log(`房间 ${roomCode} 已无人类玩家，立即销毁`);
    roomManager.immediateDestroyRoom(roomCode);
  }

  // 发送离开确认（在广播之后）
  try {
    send(ws, { type: 'roomLeft' });
  } catch (err) {
    console.log(`发送离开确认失败（连接可能已关闭）: ${errorMessage(err)}`);
  }
}


export function handleRejoinRoom(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'rejoinRoom'>) {
  const roomCode = message.roomCode;
  const isReady = message.isReady;

  const room = roomManager.getRoom(roomCode);
  if (!room) {
    send(ws, { type: 'error', message: '房间不存在', code: 'roomGone' });
    return;
  }

  // 检查玩家是否在房间中，如果不在但在游戏会话中，执行自动恢复
  let player = room.players.get(playerId);
  if (!player) {
    const gameSession = roomManager.getPlayerGameSession(playerId);
    if (gameSession && gameSession.roomCode === roomCode && gameSession.players.has(playerId)) {
      console.log(`玩家 ${playerId} 正在重回房间 ${roomCode} (通过 rejoinRoom 从会话恢复)`);
      const sessionPlayer = gameSession.players.get(playerId)!;
      player = new Player(playerId, ws, sessionPlayer.nickname, sessionPlayer.emoji);
      player.color = sessionPlayer.color;
      player.isHost = sessionPlayer.isHost;

      room.players.set(playerId, player);
      roomManager.playerRooms.set(playerId, roomCode);
    } else {
      // 超时被移出了：客户端收到这个 code 会清掉本地房间上下文并回首页
      send(ws, { type: 'error', message: '您不在该房间中', code: 'notInRoom' });
      return;
    }
  }

  // 清除断开连接定时器（如果有）
  if (roomManager.disconnectTimers.has(playerId)) {
    clearTimeout(roomManager.disconnectTimers.get(playerId));
    roomManager.disconnectTimers.delete(playerId);
    console.log(`玩家 ${playerId} 重连，清除断开定时器`);
  }

  // 恢复玩家在线状态
  const wasDisconnected = !player.isConnected;
  player.isConnected = true;
  player.ws = ws;
  player.disconnectedAt = null;

  // 重新关联房间
  roomManager.playerRooms.set(playerId, roomCode);
  roomManager.setPlayerConnection(playerId, ws);

  // 更新准备状态（如果客户端提供了）
  if (typeof isReady === 'boolean') {
    room.playerReadyStatus.set(playerId, isReady);
  }

  // 发送重连成功消息给当前玩家
  send(ws, {
    type: 'roomRejoined',
    playerId,
    roomCode,
    room: room.toJSON()
  });

  // 如果之前是离线状态，广播重连消息给房间内其他玩家
  if (wasDisconnected) {
    console.log(`玩家 ${playerId} 重连成功，广播给房间内其他玩家`);
    room.broadcast({
      type: 'playerReconnected',
      playerId,
      room: room.toJSON()
    }, playerId); // 排除当前玩家

    // 广播“回来了”系统消息（排除本人）
    broadcastSystemChat(room, `${player.nickname}回来了`, playerId);
  }
}


export function handleRejoinGameSession(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'rejoinGameSession'>) {
  const gameSessionId = message.gameSessionId;
  const gameSession = roomManager.getGameSession(gameSessionId);
  if (!gameSession) {
    send(ws, { type: 'error', message: '游戏会话不存在' });
    return;
  }

  if (!gameSession.players.has(playerId)) {
    send(ws, { type: 'error', message: '您不在该游戏会话中' });
    return;
  }

  // 重新进对局页面：从现在起这台要参与「等演完」，离开/断开时清掉
  markGamePage(playerId);

  // 重连冷却限制：防止玩家通过频繁刷新页面干扰其他玩家游戏流程
  // 2秒内多次重连跳过非必要的重复处理，但连接状态（ws、isConnected、disconnectedAt）必须更新
  if (!roomManager.rejoinCooldowns) roomManager.rejoinCooldowns = new Map();
  const now = Date.now();
  const lastRejoin = roomManager.getRejoinCooldown(playerId);
  if (now - lastRejoin < 2000) {
    console.log(`玩家 ${playerId} 重连过于频繁（${now - lastRejoin}ms内），跳过完整重连处理`);

    // 基础连接状态必须更新，防止断线定时器误判
    const player = gameSession.players.get(playerId)!;
    if (player) {
      player.isConnected = true;
      player.ws = ws;
      player.disconnectedAt = null;

      // 同步更新 roomManager 的连接引用（否则 boardSyncData 无法转发）
      roomManager.setPlayerConnection(playerId, ws);
      roomManager.playerSessions.set(playerId, gameSessionId);

      // 同步更新房间引用
      if (gameSession.roomCode) {
        const room = roomManager.getRoom(gameSession.roomCode);
        if (room) {
          const roomPlayer = room.players.get(playerId);
          if (roomPlayer) {
            roomPlayer.isConnected = true;
            roomPlayer.ws = ws;
            delete roomPlayer.disconnectedAt;
          }
        }
      }

      // 取消断线去抖定时器（如果有）
      roomManager.clearPlayerTimers(playerId);
    }

    // 广播给其他玩家：该玩家已重连
    gameSession.broadcast({
      type: 'playerReconnected',
      playerId,
      timestamp: Date.now()
    });

    // 仍然发送最新游戏数据给重连玩家
    send(ws, { type: 'gameSessionConnected', playerId, gameSessionId, gameSession: gameSession.toJSON() });
    sendSnapshotTo(ws, gameSessionId);
    if (message.needsHistory) {
      sendGameInfoHistoryTo(ws, gameSession);
    }

    return;
  }
  roomManager.markRejoin(playerId, now);

  // 重新关联会话
  roomManager.playerSessions.set(playerId, gameSessionId);
  roomManager.setPlayerConnection(playerId, ws);

  // 取消旧 WS 的断线去抖定时器（页面跳转场景：旧 WS close → 新 WS rejoin）
  if (roomManager.disconnectDebounceTimers.has(playerId)) {
    clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
    roomManager.disconnectDebounceTimers.delete(playerId);
    console.log(`玩家 ${playerId} 重新加入游戏会话，取消断线去抖定时器`);
  }

  const player = gameSession.players.get(playerId)!;
  let wasDisconnected = false;
  let disconnectDuration = 0;

  if (player) {
    // 在发送 gameSessionConnected 之前先恢复状态
    // 这样 toJSON() 返回的数据中 isConnected 就是正确的 true，解决“加载不出数据”的问题
    wasDisconnected = !player.isConnected || !!player.disconnectedAt;
    disconnectDuration = player.disconnectedAt ? Date.now() - player.disconnectedAt : 0;

    player.isConnected = true;
    player.ws = ws;
    player.disconnectedAt = null;

    // 同步更新房间引用
    if (gameSession.roomCode) {
      const room = roomManager.getRoom(gameSession.roomCode);
      if (room) {
        const roomPlayer = room.players.get(playerId);
        if (roomPlayer) {
          roomPlayer.isConnected = true;
          roomPlayer.ws = ws;
          delete roomPlayer.disconnectedAt;
        }
        room.checkEmptyRoom();
      }
    }

    // === 人类玩家重连后自动恢复自动暂停的游戏 ===
    // 只有因所有人类玩家离线导致的自动暂停才恢复，手动暂停不自动恢复
    if (gameSession.gameData && gameSession.gameData.isPaused && gameSession.gameData.pauseReason === 'all_humans_disconnected') {
      console.log(`[重连] 游戏处于自动暂停状态，检测到人类玩家${playerId}重连，自动恢复游戏`);
      gameSession.gameData.isPaused = false;
      delete gameSession.gameData.pauseReason;
      accumulatePausedTime(gameSession.gameData);
      if (gameSession.gameData.gamePhase === 'paused') {
        gameSession.gameData.gamePhase = gameSession.gameData.gamePhaseBeforePause || 'rolling';
      }
      const resumedSession = getAuthoritySession(gameSession.gameSessionId);
      // 广播游戏恢复消息给所有玩家（包括重连者将会在 gameSessionConnected 中同步）
      gameSession.broadcast({
        type: 'gameResumed',
        playerId,
        reason: 'human_player_reconnected',
        timestamp: Date.now()
      });
      // 恢复后补一份权威快照，让各端立刻对齐阶段（markResumed 同时重置看门狗计时）
      if (resumedSession) {
        commitSnapshot(gameSession, resumedSession.markResumed());
      }
    }

  }

  // 更新其他玩家的连接状态（仅连接状态，不要修改音频加载状态）
  // 音频加载状态必须只由客户端显式发送 audioLoaded 来驱动，否则会导致 allAudioLoaded 被提前广播。
  gameSession.players.forEach((p, id) => {
    if (id !== playerId) {
      const otherWs = roomManager.getPlayerConnection(id);
      if (otherWs?.readyState === WebSocket.OPEN) {
        // 同时更新其他玩家的isConnected状态
        if (!p.isAI && !p.isConnected) {
          p.isConnected = true;
          console.log(`[重连] 更新玩家${id}的isConnected状态为true`);
        }
      }
    }
  });

  // 发送重连确认
  console.log(`[重连] 发送gameSessionConnected给玩家${playerId}，currentPlayer=${gameSession.gameData.currentPlayer}`);
  send(ws, {
    type: 'gameSessionConnected',
    playerId,
    gameSessionId,
    gameSession: gameSession.toJSON(),
    audioLoadedPlayers: Array.from(gameSession.audioLoadedPlayers) // 同步已加载玩家列表
  });
  sendSnapshotTo(ws, gameSessionId);
  if (message.needsHistory) {
    sendGameInfoHistoryTo(ws, gameSession);
  }

  // 如果所有人（包括重连者之前记录的状态）都已经加载完音频，
  // 补发一个 allAudioLoaded 信号给重连玩家，确保其 UI 能正常关闭
  const realPlayerCount = Array.from(gameSession.players.values()).filter(p => !p.isAI).length;
  console.log(`[重连] 检查音频加载状态: ${gameSession.audioLoadedPlayers.size}/${realPlayerCount}`);
  if (gameSession.audioLoadedPlayers.size === realPlayerCount) {
    console.log(`[重连] 所有玩家已加载，补发 allAudioLoaded 给玩家 ${playerId}`);
    send(ws, {
      type: 'allAudioLoaded',
      gameSessionId: gameSession.gameSessionId,
      isResync: true
    });
  }

  // 广播重连（只发送玩家列表，不发送全量 gameData 减轻其他客户端解析负担）
  console.log(`[重连] 玩家${playerId}重连成功，广播playerReconnected给其他玩家`);

  const playersArray = Array.from(gameSession.players.values()).map(p => ({
    id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
    isHost: p.isHost || false, isConnected: p.isConnected, isAI: p.isAI
  }));
  for (const [otherPlayerId] of gameSession.players) {
    if (otherPlayerId === playerId) continue;
    const otherWs = roomManager.getPlayerConnection(otherPlayerId);
    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
      send(otherWs, {
        type: 'playerReconnected',
        playerId,
        players: playersArray
      });
    }
  }

  // 如果游戏处于激活状态（非暂停），确保 gameData.thinkingStartTime 已设置
  //（progressBarStart 已在第3145行保存到 gameData，但如果还没有 progressBarStart，
  // 设置一个当前时间作为 fallback）
  if (wasDisconnected && gameSession.gameData && !gameSession.gameData.isPaused) {
    if (!gameSession.gameData.thinkingStartTime) {
      gameSession.gameData.thinkingStartTime = Date.now();
      console.log(`[重连] 无 thinkingStartTime，设置当前时间: ${gameSession.gameData.thinkingStartTime}`);
    } else {
      console.log(`[重连] 现有 thinkingStartTime=${gameSession.gameData.thinkingStartTime}，传给重连者`);
    }
  }

  // 发送重连消息
  if (wasDisconnected && player) {
    console.log(`[重连] 玩家${playerId}断开时长${disconnectDuration}ms，广播“回来了”系统消息`);
    broadcastSystemChat(gameSession, `${player.nickname}回来了`, playerId);
  }

  // 骰子/阶段等棋面状态统一由上面的 sendSnapshotTo 权威快照恢复，无需额外补发

  // 检查当前房主是否在线，如果不在线且当前重连的是真实玩家，则接管房主
  // 仅在游戏稳定期（开始15秒后）才允许重连者主动接管，防止开局加载时的竞争
  const timeSinceStart = Date.now() - (gameSession.createdAt || 0);
  if (timeSinceStart >= 15000 && player && !player.isAI) {
    const currentHost = Array.from(gameSession.players.values()).find(p => p.isHost);

    // 如果重连的人自己就是房主，并且他成功连上了，那他理所当然保留房主，无需接管逻辑
    if (currentHost && currentHost.id === playerId) {
      console.log(`[重连] 房主 ${playerId} 成功归来，继续担任房主`);
    } else {
      const hostWs = currentHost ? roomManager.getPlayerConnection(currentHost.id) : null;
      const isHostOnline = currentHost && currentHost.isConnected && hostWs && hostWs.readyState === 1;

      if (!isHostOnline) {
        console.log(`[重连] 房主 ${currentHost ? currentHost.id : '无'} 不在线，玩家 ${playerId} 接管房主`);

        for (const [pId, p] of gameSession.players) {
          if (p) p.isHost = (pId === playerId);
        }
        gameSession.hostId = playerId;

        if (gameSession.roomCode) {
          const room = roomManager.getRoom(gameSession.roomCode);
          if (room) {
            const roomNewHost = room.players.get(playerId);
            if (roomNewHost) {
              room.host = roomNewHost;
              for (const p of room.players.values()) {
                if (p) p.isHost = (p.id === playerId);
              }
            }
          }
        }

        recordHostChange(gameSession, player);
        gameSession.broadcast({
          type: 'hostChanged',
          oldHostId: currentHost ? currentHost.id : null,
          newHostId: playerId,
          newHostNickname: player.nickname,
          gameSession: gameSession.toJSON(),
          timestamp: Date.now()
        });
      }
    }
  }
}


// 游戏暂停（使用通用广播目标）
export function handleGamePause(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'gamePause'>) {
  const target = requireBroadcastTarget(playerId);

  if (target instanceof GameSession && target.gameData) {
    target.gameData.isPaused = true;
    target.gameData.pauseReason = 'manual';
    target.gameData.pausedAt = Date.now();
    target.gameData.gamePhaseBeforePause = target.gameData.gamePhase;
    target.gameData.gamePhase = 'paused';
  }

  target.broadcast({
    type: 'gamePaused',
    playerId,
    timestamp: message.timestamp
  });
}


// 游戏继续（使用通用广播目标）
export function handleGameResume(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'gameResume'>) {
  const target = requireBroadcastTarget(playerId);
  const session = target instanceof GameSession ? getAuthoritySession(target.gameSessionId) : null;

  if (target instanceof GameSession && target.gameData) {
    target.gameData.isPaused = false;
    delete target.gameData.pauseReason;
    accumulatePausedTime(target.gameData);
    if (target.gameData.gamePhase === 'paused') {
      target.gameData.gamePhase = target.gameData.gamePhaseBeforePause || 'rolling';
    }
  }

  target.broadcast({
    type: 'gameResumed',
    playerId,
    timestamp: message.timestamp
  });

  // 暂停期间各端的本地阶段可能被冻在半截（刷新回来的客户端会停在 waiting），
  // 补一份权威快照让所有人立刻对齐，而不是等 25 秒心跳
  if (session) {
    commitSnapshot(target as GameSession, session.markResumed());
    botDriver.kick(target as GameSession);
  }
}


// AI托管切换（房主代理发送，message.playerId 才是被托管的玩家）
export function handleAITakeoverChange(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'aiTakeoverChange'>) {
  const target = requireBroadcastTarget(playerId);
  const targetPlayerId = message.playerId || playerId;

  // isAITakeover 是权威层判定「谁能代理这个玩家发起 intent」的依据
  if (target.players && target.players.has(targetPlayerId)) {
    target.players.get(targetPlayerId)!.isAITakeover = message.isActive;
  }

  target.broadcast({
    type: 'aiTakeoverChange',
    playerId: targetPlayerId,
    isActive: message.isActive,
    auto: message.auto,
    reason: message.reason,
    timestamp: message.timestamp
  });

  // 托管开关一变就重排一拍：开着托管又正轮到他（比如刚掷完骰子在选子），
  // AI 要立刻接手，别干等思考窗口——原来就是这个空档，看着像卡住了
  if (target instanceof GameSession) botDriver.kick(target);
}


// 音效开关（玩家自己的偏好，落在会话与房间上以便刷新/重连恢复）
export function handleAudioEnabledChange(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'audioEnabledChange'>) {
  const target = requireBroadcastTarget(playerId);
  const enabled = !!message.enabled;

  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (gameSession && gameSession.players.has(playerId)) {
    gameSession.players.get(playerId)!.audioEnabled = enabled;
  }
  const room = roomManager.getPlayerRoom(playerId);
  if (room && room.players.has(playerId)) {
    room.players.get(playerId)!.audioEnabled = enabled;
  }

  target.broadcast({
    type: 'audioEnabledChange',
    playerId,
    enabled,
    timestamp: message.timestamp || Date.now()
  });
}


// 先广播，再清理会话映射。
// 否则 removeGameSession 会清空 playerSessions，导致 GameSession.broadcast 由于映射校验而不发送给任何人。
export function broadcastEndPayload(target: Room | GameSession, payload: FlightResponse<'gameEnd'> | FlightResponse<'forceSettlement'>) {
  try {
    if (target && target.players && typeof target.players.forEach === 'function') {
      const connectionSnapshot: { playerId: PlayerId; isAI: boolean; wsOpen: boolean }[] = [];
      target.players.forEach(p => {
        const conn = roomManager.getPlayerConnection(p.id);
        connectionSnapshot.push({ playerId: p.id, isAI: !!p.isAI, wsOpen: !!(conn && conn.readyState === WebSocket.OPEN) });
      });
      console.log(`[${payload.type}] broadcast snapshot:`, connectionSnapshot);
    }
  } catch (e) {
    // ignore
  }

  const gameData: Partial<FlightGameData> = target && target.gameData ? target.gameData : {};
  target.broadcast({
    ...payload,
    gameStartTime: gameData.gameStartTime,
    progressHistory: gameData.progressHistory,
    currentRound: gameData.currentRound
  });
}


// 结算后统一收尾：终止会话、清理掉线玩家、必要时销毁空房间
export function finalizeGameRoom(playerId: PlayerId, logLabel: string) {
  const room = roomManager.getPlayerRoom(playerId);
  if (!room || room.gameState !== 'playing') return;

  console.log(`房间 ${room.code} ${logLabel}，状态改为 finished`);
  room.gameState = 'finished';

  if (room.gameSessionId) {
    roomManager.removeGameSession(room.gameSessionId);
    room.gameSessionId = null;
  }

  try {
    const offlinePlayerIds = [];
    for (const [pid, p] of room.players) {
      if (p && p.isConnected === false) offlinePlayerIds.push(pid);
    }

    if (offlinePlayerIds.length > 0) {
      console.log(`房间 ${room.code} ${logLabel}后清理已掉线玩家:`, offlinePlayerIds);
      for (const offlineId of offlinePlayerIds) {
        room.removePlayer(offlineId);
        roomManager.playerRooms.delete(offlineId);
      }
      if (room.players.size > 0) {
        room.broadcast({ type: 'roomUpdated', room: room.toJSON() });
      }
    }
  } catch (e) {
    console.error(`${logLabel}后清理离线玩家时出错:`, e);
  }

  if (room.players.size === 0) {
    console.log(`房间 ${room.code} ${logLabel}后无玩家，加入清理队列`);
    roomManager.scheduleRoomDestroy(room.code);
  }

  dailyStats.recordGameFinished();
}


// 游戏结束
export function handleGameEnd(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'gameEnd'>) {
  const target = requireBroadcastTarget(playerId);
  broadcastEndPayload(target, {
    type: 'gameEnd',
    playerId,
    winnerPlayer: message.winnerPlayer,
    titleStats: message.titleStats || undefined,
    timestamp: message.timestamp
  });
  finalizeGameRoom(playerId, '游戏结束');
}


// 强制结算
export function handleForceSettlement(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'forceSettlement'>) {
  const target = requireBroadcastTarget(playerId);
  broadcastEndPayload(target, {
    type: 'forceSettlement',
    playerId,
    rankings: message.rankings,
    titleStats: message.titleStats || undefined,
    timestamp: message.timestamp
  });
  finalizeGameRoom(playerId, '被房主强制结算');
}
