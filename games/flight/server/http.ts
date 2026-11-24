import WebSocket from 'ws';
import crypto from 'node:crypto';
import type { Express } from 'express';

import * as auth from '../../../backend/auth.ts';


import { errorMessage } from '../../shared/errors.ts';
import { Player, Room, GameSession, roomManager, ROOM_LIFECYCLE } from './roomManager.ts';

import { dailyStats, sanitizeText } from './runtime.ts';
import { getDefaultNickname, getBroadcastTarget, requireBroadcastTarget, withRoomValidation, withGameSessionValidation } from './roomHelpers.ts';


import { authoritySessions, finishedReplays, getReplayArchive } from './authorityRuntime.ts';


/**
 * 清理孤立资源的核心函数
 * @returns {Object} 清理结果 { sessions: 清理的会话数, rooms: 清理的房间数 }
 */
export function cleanupOrphanedResources() {
  console.log('\n===== 开始清理孤立资源 =====');
  let cleanedSessions = 0;
  let cleanedRooms = 0;
  let cleanedConnections = 0;
  for (const [playerId, ws] of roomManager.playerConnections.entries()) {
    if (ws.readyState !== WebSocket.OPEN) {
      roomManager.playerConnections.delete(playerId);
      cleanedConnections++;
    }
  }

  // 1. 清理孤立的游戏会话（对应房间不存在或已finished）
  const orphanedSessions = [];
  for (const [sessionId, session] of roomManager.gameSessions.entries()) {
    const room = session.roomCode ? roomManager.getRoom(session.roomCode) : null;

    // 会话孤立的条件：
    // - 没有关联房间
    // - 关联的房间不存在
    // - 关联的房间状态为finished
    if (!session.roomCode || !room || room.gameState === 'finished') {
      orphanedSessions.push(sessionId);
      console.log(`  发现孤立会话: ${sessionId} (房间: ${session.roomCode || '无'}, 房间状态: ${room ? room.gameState : '不存在'})`);
    }
  }

  // 删除孤立会话
  for (const sessionId of orphanedSessions) {
    roomManager.removeGameSession(sessionId);
    cleanedSessions++;
  }

  // 2. 清理非游戏进行中且无人类玩家的房间，以及空置超时的游戏房间
  const emptyRoomsToClean = [];
  const NOW = Date.now();
  for (const [roomCode, room] of roomManager.rooms.entries()) {
    if (!room.hasHumanPlayers()) {
      if (room.gameState !== 'playing') {
        emptyRoomsToClean.push(roomCode);
        console.log(`  发现无人类玩家的僵尸房间 (${room.gameState}): ${roomCode}`);
      } else {
        // 游戏中房间先靠延迟销毁定时器，这里兜底定时器丢失：以「全员离线自动暂停的时刻」
        // 为起点，超过销毁窗口还没走掉就强制清理（定时器跑过会把自己从表里摘掉，不能只看它）
        const session = roomManager.getGameSession(room.gameSessionId);
        const pausedAt = session?.gameData?.pausedAt || 0;
        const destroyEntry = roomManager.roomDestroyTimers.get(roomCode);
        const deadline = ROOM_LIFECYCLE.EMPTY_ROOM_DESTROY_MS + 60 * 1000;
        const overdueByTimer = destroyEntry?.startedAt && NOW - destroyEntry.startedAt > deadline;
        const overdueByPause = pausedAt && NOW - pausedAt > deadline;
        if (overdueByTimer || overdueByPause) {
          emptyRoomsToClean.push(roomCode);
          console.log(`  发现空置超时的僵尸游戏房间 (${room.gameState}): ${roomCode}`);
        }
      }
    } else if (room.gameState === 'finished') {
      // 如果房间是finished且没有人类玩家（上面已处理），或者是全空的
      if (room.players.size === 0) {
        emptyRoomsToClean.push(roomCode);
        console.log(`  发现已结束空房间: ${roomCode}`);
      }
    }
  }

  // 删除这些房间
  for (const roomCode of emptyRoomsToClean) {
    const room = roomManager.rooms.get(roomCode);
    if (!room) continue;

    roomManager.immediateDestroyRoom(roomCode);
    cleanedRooms++;
  }

  console.log(`===== 清理完成: ${cleanedSessions}个会话, ${cleanedRooms}个房间, ${cleanedConnections}个死连接 =====\n`);

  return {
    sessions: cleanedSessions,
    rooms: cleanedRooms,
    connections: cleanedConnections
  };
}
export function registerHttp(app: Express): void {


/**
 * 查询所有房间信息
 * GET /api/rooms
 */
app.get('/api/rooms', (req, res) => {
  try {
    const roomsInfo = Array.from(roomManager.rooms.values()).map(room => room.toJSON());

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalRooms: roomsInfo.length,
      rooms: roomsInfo
    });
  } catch (error) {
    console.error('获取房间信息失败:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error)
    });
  }
});


/**
 * 查询所有游戏会话信息
 * GET /api/sessions
 */
app.get('/api/sessions', (req, res) => {
  try {
    const sessionsInfo = [];

    for (const [sessionId, session] of roomManager.gameSessions.entries()) {
      const players = Array.from(session.players.values()).map(p => ({
        id: p.id,
        nickname: p.nickname,
        emoji: p.emoji,
        playerNumber: p.color,
        isConnected: p.isConnected,
        isAI: p.isAI,
        isHost: p.id === session.hostId // 添加房主标志
      }));

      sessionsInfo.push({
        sessionId,
        roomCode: session.roomCode,
        hostId: session.hostId,
        playerCount: session.players.size,
        players,
        pieceCount: session.pieceCount,
        skillMode: session.skillMode,
        gameState: session.gameData ? {
          currentPlayer: session.gameData.currentPlayer,
          gamePhase: session.gameData.gamePhase,
          diceValue: session.gameData.diceValue,
          winner: session.gameData.winner
        } : null,
        createdAt: session.createdAt
      });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalSessions: sessionsInfo.length,
      sessions: sessionsInfo
    });
  } catch (error) {
    console.error('获取游戏会话信息失败:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error)
    });
  }
});


/**
 * 获取在线用户列表及其详细状态
 * GET /api/online-users
 */
app.get('/api/online-users', (req, res) => {
  try {
    const users = [];

    // 遍历所有活跃的 WebSocket 连接
    for (const [playerId, ws] of roomManager.playerConnections.entries()) {
      if (ws.readyState !== WebSocket.OPEN) {
        roomManager.playerConnections.delete(playerId);
        continue;
      }

      let status = 'idle'; // 默认：首页/空闲
      let roomCode = null;
      let gameSessionId = null;
      let nickname = `玩家_${String(playerId).slice(-4)}`;

      // 1. 检查是否在游戏中
      const gameSession = roomManager.getPlayerGameSession(playerId);
      if (gameSession) {
        status = 'playing';
        gameSessionId = gameSession.gameSessionId;
        roomCode = gameSession.roomCode;
        const p = gameSession.players.get(playerId);
        if (p) nickname = p.nickname;
      }
      // 2. 检查是否在观战中
      else if (roomManager.playerSpectatingRooms.has(playerId)) {
        status = 'spectating';
        roomCode = roomManager.playerSpectatingRooms.get(playerId);
        // 观战者通常没有存储在房间的 players Map 里，使用默认昵称或尝试从之前的连接中寻找
      }
      // 3. 检查是否在房间中
      else {
        const room = roomManager.getPlayerRoom(playerId);
        if (room) {
          status = 'in_room';
          roomCode = room.code;
          const p = room.players.get(playerId);
          if (p) nickname = p.nickname;
        }
      }

      users.push({
        playerId,
        nickname,
        status,
        roomCode,
        gameSessionId
      });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalOnline: users.length,
      users
    });
  } catch (error) {
    console.error('获取在线用户列表失败:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error)
    });
  }
});


/**
 * 查询每日统计
 * GET /api/daily-stats
 */
app.get('/api/daily-stats', (req, res) => {
  res.json(dailyStats.toJSON());
});


/**
 * 查询最近若干天的统计（默认 30 天，最多 90 天，最新在前）
 * GET /api/daily-history?days=30
 */
app.get('/api/daily-history', (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days), 10) || 30, 1), 90);
  res.json({ days: dailyStats.history(days) });
});


/**
 * 进行中的对局档案一览（回放用）
 * GET /api/replays
 */
app.get('/api/replays', (req, res) => {
  const replays = [];
  for (const [gameSessionId, session] of authoritySessions) {
    const config = session.replayConfig || {};
    replays.push({
      gameSessionId,
      engineVersion: config.engineVersion,
      colors: config.colors || [],
      pieceCount: config.pieceCount,
      happy: Boolean(config.happy),
      skillMode: Boolean(config.skillMode),
      players: config.players || [],
      actionCount: session.actions ? session.actions.length : 0,
      turn: session.state ? session.state.turn : 0,
      finished: Boolean(session.state && session.state.phase === 'ended'),
      winner: (session.state && session.state.winner) || null
    });
  }
  for (const [gameSessionId, item] of finishedReplays) {
    const archive = item.archive || {};
    replays.push({
      gameSessionId,
      colors: archive.colors || [],
      pieceCount: archive.pieceCount,
      happy: Boolean(archive.happy),
      skillMode: Boolean(archive.skillMode),
      players: (archive.players || []).map((player) => ({ color: player[0], nickname: player[1], isAI: Boolean(player[2]) })),
      actionCount: archive.actionCount || 0,
      turn: archive.turn || 0,
      finished: true,
      winner: archive.winner || 0,
      retired: true
    });
  }
  res.json({ replays });
});


/**
 * 取一份完整回放档案
 * GET /api/replay/:gameSessionId            直接拿 JSON（给播放器用）
 * GET /api/replay/:gameSessionId?download=1  作为文件下载（紧凑格式，无需解压）
 */
app.get('/api/replay/:gameSessionId', (req, res) => {
  const found = getReplayArchive(req.params.gameSessionId);
  if (!found) {
    res.status(404).json({ error: '这局对局结束太久，档案已经回收（保留两小时）' });
    return;
  }

  // 会话里存的本来就是紧凑元组，导出即原样序列化，不做二次加工
  const payload = JSON.stringify(found.archive);
  if (req.query.download === undefined) {
    res.type('application/json').send(payload);
    return;
  }

  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', 'attachment; filename="replay-' + String(req.params.gameSessionId).slice(0, 12) + '.json"');
  res.send(payload);
});


/**
 * 查询服务器统计信息
 * GET /api/stats
 */
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      rooms: {
        total: roomManager.rooms.size,
        waiting: 0,
        playing: 0,
        ...({} as { finished?: number; cleanup?: number })
      },
      sessions: {
        total: roomManager.gameSessions.size
      },
      players: {
        totalConnections: 0,
        inRooms: 0, // 仅统计在线
        inSessions: 0 // 仅统计在线
      },
      timers: {
        roomDestroyTimers: roomManager.roomDestroyTimers.size,
        disconnectTimers: roomManager.disconnectTimers.size
      }
    };

    // 统计在线玩家分布
    for (const [playerId, ws] of roomManager.playerConnections.entries()) {
      if (ws.readyState !== WebSocket.OPEN) {
        roomManager.playerConnections.delete(playerId);
        continue;
      }

      stats.players.totalConnections++;

      if (roomManager.playerSessions.has(playerId)) {
        stats.players.inSessions++;
      } else if (roomManager.playerRooms.has(playerId)) {
        stats.players.inRooms++;
      }
    }

    // 更新每日峰值在线
    dailyStats.recordConnectionCount(stats.players.totalConnections);

    // 统计房间状态
    let cleanupRoomsCount = 0;
    for (const room of roomManager.rooms.values()) {
      if (room.gameState === 'waiting') {
        stats.rooms.waiting++;
      } else if (room.gameState === 'playing') {
        stats.rooms.playing++;
      } else if (room.gameState === 'finished') {
        stats.rooms.finished = (stats.rooms.finished || 0) + 1;
      }

      // 如果没有人类玩家且状态是游戏中或等待中，逻辑上属于待清理状态
      // 或者是没有任何玩家（连AI都没有）的空房间
      const noHumanPlayers = !room.hasHumanPlayers();
      const isEmpty = room.players.size === 0;

      const isCleanupState =
        (noHumanPlayers && (room.gameState === 'playing' || room.gameState === 'waiting')) ||
        (isEmpty && room.gameState === 'finished');

      if (isCleanupState) {
        cleanupRoomsCount++;
      }
    }
    stats.rooms.cleanup = cleanupRoomsCount;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats
    });
  } catch (error) {
    console.error('获取统计信息失败:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error)
    });
  }
});


/**
 * 手动清理孤立资源
 * POST /api/cleanup
 */
app.post('/api/cleanup', (req, res) => {
  try {
    const result = cleanupOrphanedResources();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      cleaned: result,
      message: `清理完成: ${result.sessions}个孤立会话, ${result.rooms}个已结束房间, ${result.connections}个死连接`
    });
  } catch (error) {
    console.error('清理失败:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error)
    });
  }
});
}
