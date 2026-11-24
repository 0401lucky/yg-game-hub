import { send } from './transport.ts';
import * as authority from './authority.ts';
import type { AuthoritySession } from './authority.ts';
import { BotDriver } from './botDriver.ts';
interface AnimationWaiter { seq: number; pending: Set<PlayerId>; resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }
import WebSocket from 'ws';
import crypto from 'node:crypto';


import * as auth from '../../../backend/auth.ts';
import type { AccountSocket } from '../../../backend/gameModule.ts';
import type { PlayerId } from '../../shared/protocol.ts';
import { errorMessage } from '../../shared/errors.ts';
import { Player, Room, GameSession, roomManager, ROOM_LIFECYCLE } from './roomManager.ts';

import { dailyStats, sanitizeText } from './runtime.ts';
import { getDefaultNickname, getBroadcastTarget, requireBroadcastTarget, withRoomValidation, withGameSessionValidation } from './roomHelpers.ts';
import type { FlightRequest } from '../protocol.ts';
import type { GameSnapshot, FlightGameData, FlightAction, PackedReplay } from '../types.ts';


export const authoritySessions: Map<string, AuthoritySession> = new Map();


export function getAuthoritySession(gameSessionId: string | null | undefined) {
  return gameSessionId ? authoritySessions.get(gameSessionId) || null : null;
}


// 刚打完的对局：会话销毁时把档案挪到这里留一阵，否则结算页点「查看回放」时档案已经没了
export const finishedReplays: Map<string, {archive: PackedReplay; savedAt: number}> = new Map();

export const REPLAY_KEEP_AFTER_END_MS = 2 * 60 * 60 * 1000;

export const REPLAY_KEEP_MAX = 50;


export function retireAuthoritySession(gameSessionId: string) {
  pruneFinishedReplays();
  const session = authoritySessions.get(gameSessionId);
  if (session && session.actions && session.actions.length) {
    finishedReplays.set(gameSessionId, { archive: session.getReplay(), savedAt: Date.now() });
    while (finishedReplays.size > REPLAY_KEEP_MAX) {
      finishedReplays.delete(finishedReplays.keys().next().value!);
    }
  }
  authoritySessions.delete(gameSessionId);
}


export function pruneFinishedReplays(now = Date.now()) {
  for (const [gameSessionId, item] of finishedReplays) {
    if (now - item.savedAt > REPLAY_KEEP_AFTER_END_MS) finishedReplays.delete(gameSessionId);
  }
}


export function getReplayArchive(gameSessionId: string) {
  const live = authoritySessions.get(gameSessionId);
  if (live) return { archive: live.getReplay(), finished: live.state.phase === 'ended' };
  const kept = finishedReplays.get(gameSessionId);
  if (kept) return { archive: kept.archive, finished: true };
  return null;
}


export function dropAuthoritySession(gameSessionId: string) {
  if (!gameSessionId) return;
  botDriver.dropSession(gameSessionId);
  const waiter = animationWaiters.get(gameSessionId);
  if (waiter) finishAnimationWait(gameSessionId, waiter);
  animationAckers.delete(gameSessionId);
  retireAuthoritySession(gameSessionId);
}


// 把权威快照同步进 gameData，让重连、观战、既有 HTTP 接口都看到同一份棋面
export function mirrorSnapshot(gameSession: GameSession, snapshot: GameSnapshot) {
  const data = gameSession.gameData;
  const previousPlayer = data.currentPlayer;
  const previousPhase = data.gamePhase;

  data.currentPlayer = snapshot.currentPlayer;
  data.gamePhase = snapshot.gamePhase === 'ended' ? 'finished' : snapshot.gamePhase;
  data.diceValue = snapshot.diceValue;
  data.winner = snapshot.winner;
  data.consecutiveSixes = snapshot.consecutiveSixes;
  data.currentRound = snapshot.round;
  data.pieceCount = snapshot.pieceCount;
  if (Array.isArray(snapshot.progressHistory)) {
    data.progressHistory = snapshot.progressHistory;
  }
  for (const color of Object.keys(snapshot.playerChess)) {
    data.playerChess[Number(color)] = snapshot.playerChess[Number(color)].map(chess => ({
      position: chess.position,
      finished: chess.finished
    }));
  }
  for (const attacker of Object.keys(snapshot.defeatCounts)) {
    data.defeatCounts[Number(attacker)] = { ...snapshot.defeatCounts[Number(attacker)] };
  }

  // 思考窗口只在这里开：换人，或同一人重新进入掷骰阶段（连投 6 重掷）。
  // 掷出点数后进入选子沿用同一扇窗：那一步不重置进度条。
  // 刷新、重连、补快照都只是重发同一扇窗，狂刷页面换不来额外思考时间
  const openedWindow = data.currentPlayer !== previousPlayer
    || (data.gamePhase === 'rolling' && previousPhase !== 'rolling' && previousPhase !== 'paused');
  if (openedWindow) {
    data.thinkingStartTime = Date.now();
    data.pausedTotalMs = 0;
  }
}


/** 把服务端维护的思考窗口带进快照：客户端据此渲染进度条，也据此判定超时 */
export function attachTiming(snapshot: GameSnapshot, gameData: Partial<FlightGameData>) {
  snapshot.thinkingStartTime = gameData.thinkingStartTime || null;
  snapshot.pausedThinkingMs = gameData.pausedTotalMs || 0;
  return snapshot;
}


/** 结束暂停：把这段暂停时长折算进去，思考窗口顺延，不因暂停而流失 */
export function accumulatePausedTime(gameData: FlightGameData) {
  if (!gameData || !gameData.pausedAt) return;
  gameData.pausedTotalMs = (gameData.pausedTotalMs || 0) + (Date.now() - gameData.pausedAt);
  gameData.pausedAt = null;
}


/** 思考时间是否已经用完（与前端 gameState.THINKING_TIME 对齐；未正式开局不计时） */
export function isThinkingExpired(gameSession: GameSession, now: number) {
  const data = gameSession.gameData;
  if (!data || !data.gameOfficiallyStarted || !data.thinkingStartTime || data.isPaused) return false;
  if (data.gamePhase !== 'rolling' && data.gamePhase !== 'selecting') return false;
  const elapsed = now - data.thinkingStartTime - (data.pausedTotalMs || 0);
  return elapsed > THINKING_TIME_MS;
}


/** 快照是否已经体现出对局推进，用来把「尚未开局」与「进行中」区分开 */
export function hasGameProgress(snapshot: GameSnapshot | null) {
  if (!snapshot) return false;
  if ((snapshot.round || 0) > 0 || (snapshot.diceValue || 0) > 0) return true;
  const playerChess = snapshot.playerChess || {};
  return Object.keys(playerChess).some(color => {
    const chesses = playerChess[Number(color)];
    return Array.isArray(chesses) && chesses.some(chess => chess && (chess.position !== -1 || chess.finished));
  });
}


export async function startAuthoritySession(gameSession: GameSession) {
  const colorList = Array.from(gameSession.players.values()).map(p => p.color);
  const players = Array.from(gameSession.players.values()).map(p => ({
    color: p.color!,
    nickname: p.nickname || `玩家${p.color}`,
    isAI: Boolean(p.isAI)
  }));
  const session = await authority.createAuthoritySession({
    gameSessionId: gameSession.gameSessionId,
    colors: colorList,
    pieceCount: gameSession.pieceCount,
    happy: gameSession.happyMode,
    skillMode: gameSession.skillMode,
    // 初始积分：房主在房间里选的值优先，没选过才退回环境变量给的启动资金
    startEnergy: Number(gameSession.initialEnergy || process.env.START_ENERGY) || 0,
    // 回放用：这颗种子定死整局的随机，动作流跟着一起留档
    seed: crypto.randomInt(0, 0xffffffff),
    players
  });
  authoritySessions.set(gameSession.gameSessionId, session);
  mirrorSnapshot(gameSession, session.snapshot());
  gameSession.broadcast(attachTiming(session.snapshot(), gameSession.gameData));
  console.log(`[权威棋面] 会话 ${gameSession.gameSessionId} 已接管，玩家颜色: ${colorList.join(',')}，种子 ${session.seed}`);
  return session;
}


export function colorOfPlayer(gameSession: GameSession, playerId: PlayerId) {
  const player = gameSession.players.get(playerId);
  return player ? player.color : null;
}


// 旧协议中会直接改写服务端棋面的消息类型
export const LEGACY_BOARD_REPORTS = new Set([
  'diceRoll', 'playerTurnChange', 'pieceMove', 'chessMove',
  'finalMoveResult', 'moveChessToStart', 'moveChessToFinish', 'noMovableChess',
  'defeatCountChange', 'boardSyncData'
]);


export function isLegacyBoardReport(type: string) {
  return LEGACY_BOARD_REPORTS.has(type);
}


export function isAuthorityManaged(playerId: PlayerId) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  return Boolean(gameSession && authoritySessions.has(gameSession.gameSessionId));
}


export function handleSnapshotRequest(ws: AccountSocket, playerId: PlayerId) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  // 对局已结束/会话已销毁时客户端的兜底心跳还会来要快照，这不是异常，
  // 静默忽略即可，报错只会把各端控制台刷满
  if (!gameSession) return;
  markGamePage(playerId);
  const session = getAuthoritySession(gameSession.gameSessionId);
  if (!session) return;
  send(ws, attachTiming(session.snapshot(), gameSession.gameData));
}


// 重连与观战都走同一条补发路径，保证新连上来的人立刻拿到权威棋面
export function sendSnapshotTo(ws: AccountSocket, gameSessionId: string) {
  const session = getAuthoritySession(gameSessionId);
  if (!session || !ws || ws.readyState !== 1) return false;
  const gameSession = roomManager.getGameSession(gameSessionId);
  send(ws, attachTiming(session.snapshot(), gameSession ? gameSession.gameData : {}));
  return true;
}


// 页面刚加载完（刷新）时右侧面板是空的，这里把服务端留存的事件流与聊天补回去，
// 客户端用同一套事件回放层静默重建战报；只是普通的断线重连则面板内容仍在，
// 客户端不会请求历史，避免重复堆叠。
export function sendGameInfoHistoryTo(ws: AccountSocket, gameSession: GameSession) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const session = getAuthoritySession(gameSession.gameSessionId);
  send(ws, {
    type: 'gameInfoHistory',
    gameSessionId: gameSession.gameSessionId,
    events: session ? session.eventLog : [],
    chat: gameSession.chatHistory || []
  });
}


export function handleIntent(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'intent'>) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (!gameSession) throw new Error('玩家不在任何游戏会话中');
  markGamePage(playerId);
  const session = getAuthoritySession(gameSession.gameSessionId);
  if (!session) throw new Error('本局尚未由服务端接管');

  const color = colorOfPlayer(gameSession, playerId);
  if (color === null) throw new Error('玩家不属于本局');

  const intent: FlightAction = message.intent || { type: message.action } as FlightAction;

  // 暂停是对局的冻结状态：客户端漏检（旧页面、超时回调）也推不动棋面
  if (gameSession.gameData && gameSession.gameData.isPaused) {
    const rejectWs = roomManager.getPlayerConnection(playerId) || ws;
    send(rejectWs, {
      type: 'intentRejected',
      gameSessionId: gameSession.gameSessionId,
      reason: '对局已暂停',
      intent
    });
    return;
  }

  const result = session.applyIntent(color, intent);

  if (!result.ok) {
    // 被拒绝时退回请求者，托管方据此知道自己代理的动作没生效
    const rejectWs = roomManager.getPlayerConnection(playerId) || ws;
    send(rejectWs, {
      type: 'intentRejected',
      gameSessionId: gameSession.gameSessionId,
      reason: result.error,
      intent
    });
    return;
  }

  // 买道具后玩家要选点/选子，客户端会重置进度条：服务端同步开一扇新窗，
  // 否则玩家看着满格进度条、服务端却按旧窗口到点代走
  if (intent.type === 'item' && intent.item && gameSession.gameData) {
    gameSession.gameData.thinkingStartTime = Date.now();
    gameSession.gameData.pausedTotalMs = 0;
  }

  commitSnapshot(gameSession, result.snapshot);
}


/**
 * 对局结束时把战况写进账号战绩表。只记录已登录的玩家，未登录玩家跳过。
 * 任何异常都不影响对局收尾。
 */
export function recordAccountMatch(gameSession: GameSession, snapshot: GameSnapshot) {
  try {
    const players = Array.from(gameSession.players.values()).map((p) => ({
      playerId: p.id,
      nickname: p.nickname,
      color: p.color,
      userId: p.isAI ? null : auth.userIdOfPlayer(p.id),
    }));
    if (!players.some((p) => p.userId)) return;
    const startedAt = gameSession.createdAt ? new Date(gameSession.createdAt).getTime() : null;
    auth.recordMatch({
      gameId: 'flight',
      roomCode: gameSession.roomCode,
      mode: gameSession.skillMode ? 'skill' : gameSession.happyMode ? 'happy' : 'classic',
      players,
      winnerColor: snapshot.winner,
      durationMs: startedAt ? Date.now() - startedAt : null,
    });
  } catch (err) {
    console.error('[战绩] 记录对局失败:', errorMessage(err));
  }
}


/** 权威快照落地的唯一出口：镜像进 gameData 后广播，并在对局结束时就地收尾 */
export function commitSnapshot(gameSession: GameSession, snapshot: GameSnapshot) {
  mirrorSnapshot(gameSession, snapshot);
  // 一旦出现推进痕迹就固化「已正式开始」，让重连/断线处理能区分加载中与进行中
  if (!gameSession.gameData.gameOfficiallyStarted && hasGameProgress(snapshot)) {
    gameSession.gameData.gameOfficiallyStarted = true;
  }
  gameSession.broadcast(attachTiming(snapshot, gameSession.gameData));
  if (snapshot.gamePhase === 'ended' && gameSession.gameState === 'playing') {
    gameSession.gameState = 'finished';
    recordAccountMatch(gameSession, snapshot);
  }
  // 轮到 AI 就接着往下推（驱动内部会判断暂停/结束，可安全重复调用）
  botDriver.kick(gameSession);
}



// -------------------------- 服务端 AI --------------------------
// 机器人与被托管玩家的回合不再由房主浏览器代打：服务端自己按节奏推，
// 房主切后台、关页面都不影响，看门狗退回「管人类挂机」的兜底角色
export const isAiDrivenColor = (gameSession: GameSession, color: number) => {
  for (const player of gameSession.players.values()) {
    if (player.color === color) return Boolean(player.isAI || player.isAITakeover);
  }
  return false;
};


export const playerOfColor = (gameSession: GameSession, color: number) => {
  for (const player of gameSession.players.values()) {
    if (player.color === color) return player;
  }
  return null;
};


export const botDriver = new BotDriver({
  sessionOf: (gameSession) => getAuthoritySession(gameSession.gameSessionId),
  isAiDriven: isAiDrivenColor,
  difficultyOf: (gameSession, color) => {
    const player = playerOfColor(gameSession, color);
    return (player && player.difficulty) || 'easy';
  },
  isPaused: (gameSession) => Boolean(gameSession.gameData && gameSession.gameData.isPaused),
  isEnded: (gameSession) => gameSession.gameState !== 'playing',
  applyAction: (gameSession, color, action) => {
    const session = getAuthoritySession(gameSession.gameSessionId);
    if (!session || !action) throw new Error('没有可执行的动作');
    const result = session.applyIntent(color, action);
    if (!result.ok) throw new Error(result.error);
    commitSnapshot(gameSession, result.snapshot);
    return { events: result.snapshot.events, seq: result.snapshot.seq };
  },
  settled: (gameSession, seq) => waitForClientsSettled(gameSession, seq)
});


// -------------------------- 演完回执 --------------------------
// AI 的下一手要等各端把这一帧演完再出，节奏才跟人操作一样。
// 认不到回执（有人在刷新）、或者对端在后台（定时器被节流、动画要拖很久）就不等它，
// 别让整桌陪着慢；那台回前台时会自己拉全量快照追上来。
export const ANIMATION_ACK_TIMEOUT_MS = 2500;

export const animationWaiters: Map<string, AnimationWaiter> = new Map();
 // gameSessionId → { seq, pending:Set<playerId>, resolve, timer }
// 认得出会回执的客户端：从没回过执的（脚本、旧页面）不参与等待，免得每拍都等满超时
export const animationAckers: Map<string, Set<PlayerId>> = new Map();
 // gameSessionId → Set<playerId>
// 当前在后台的客户端：它自己报的（visibilityChange），后台期间也回执不了动画，一并摘出去
export const backgroundPlayers: Set<PlayerId> = new Set();
 // playerId
// 对局页面上的客户端：只有 game.html 会发这几类消息（回执、周期快照、重连对局、出手）。
// 大厅页连上 socket 时同样占着 playerConnections，但它不在对局里演动画，
// 等它等于每拍都要白等满回执超时；离开对局/断开时把这个标记清掉。
export const gamePagePlayers: Map<PlayerId, number> = new Map();
 // playerId → 最近一次对局页消息的时间
export const GAME_PAGE_TTL_MS = 60000;

export function markGamePage(playerId: PlayerId) {
  if (playerId) gamePagePlayers.set(playerId, Date.now());
}

export function isOnGamePage(playerId: PlayerId) {
  const at = gamePagePlayers.get(playerId);
  return Boolean(at && Date.now() - at < GAME_PAGE_TTL_MS);
}


export function connectedHumanIds(gameSession: GameSession) {
  const ids = [];
  for (const [playerId, player] of gameSession.players) {
    if (player.isAI || backgroundPlayers.has(playerId) || !isOnGamePage(playerId)) continue;
    const ws = roomManager.getPlayerConnection(playerId);
    if (ws && ws.readyState === WebSocket.OPEN) ids.push(playerId);
  }
  return ids;
}


/**
 * 等各端把这一帧演完。
 * 返回值告诉驱动「是不是真有人回执」：有人回执 → 等回执花掉的时间就是这段演出的时长，
 * 驱动可以直接接下一拍；没人能回执（脚本、旧页面）→ 返回 false，让驱动按估时表配节奏。
 */
export function waitForClientsSettled(gameSession: GameSession, seq: number) : Promise<boolean> {
  if (!gameSession || typeof seq !== 'number') return Promise.resolve(false);
  const ackers = animationAckers.get(gameSession.gameSessionId);
  const pending = new Set(connectedHumanIds(gameSession).filter((id) => ackers && ackers.has(id)));
  if (!pending.size) return Promise.resolve(false);

  const key = gameSession.gameSessionId;
  const previous = animationWaiters.get(key);
  if (previous) {
    clearTimeout(previous.timer);
    previous.resolve(true);
  }

  return new Promise((resolve) => {
    const waiter = { seq, pending, resolve } as AnimationWaiter;
    waiter.timer = setTimeout(() => finishAnimationWait(key, waiter), ANIMATION_ACK_TIMEOUT_MS);
    animationWaiters.set(key, waiter);
  });
}


export function finishAnimationWait(key: string, waiter: AnimationWaiter) {
  if (animationWaiters.get(key) !== waiter) return;
  clearTimeout(waiter.timer);
  animationWaiters.delete(key);
  // 超时也算「等过了」：某一端卡住/切后台时让它自己追赶，别在它身上再叠一层停顿
  waiter.resolve(true);
}


/** 客户端把某一帧演完了 */
export function handleAnimationDone(ws: AccountSocket, playerId: PlayerId, message: FlightRequest<'animationDone'>) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (!gameSession) return;
  const key = gameSession.gameSessionId;
  markGamePage(playerId);
  if (!animationAckers.has(key)) animationAckers.set(key, new Set());
  animationAckers.get(key)!.add(playerId);
  // 回执自己带了前后台标记：漏收 visibilityChange 时也按它记一份
  if (message.hidden) backgroundPlayers.add(playerId);
  else backgroundPlayers.delete(playerId);
  const waiter = animationWaiters.get(key);
  if (!waiter || message.seq < waiter.seq) return;
  // 后台页面的定时器被浏览器节流，它的「演完」会晚上很多，等它等于让整桌陪它慢
  waiter.pending.delete(playerId);
  if (!message.hidden && !waiter.pending.size) finishAnimationWait(gameSession.gameSessionId, waiter);
}


// -------------------------- 回合看门狗 --------------------------
// 看门狗现在只管人：思考窗口到点就替这位玩家走一步（防挂机、防刷新拖延），
// 再留一条「空闲过久」的兜底——AI 的回合已由服务端自己驱动（见 botDriver.ts），
// 走到这里说明那条链也停了，按最小合法路径把回合交出去。
export const WATCHDOG_INTERVAL_MS = 5000;


/** 单回合思考时长，与前端 gameState.THINKING_TIME 对齐；可用环境变量覆盖，便于测试 */
export const THINKING_TIME_MS = Number(process.env.THINKING_TIME_MS) || 20000;


export function startTurnWatchdog() {
  return setInterval(() => {
    const now = Date.now();
    for (const [gameSessionId, session] of authoritySessions) {
      const gameSession = roomManager.getGameSession(gameSessionId);
      if (!gameSession) {
        retireAuthoritySession(gameSessionId);
        continue;
      }
      // 暂停是对局冻结状态，看门狗同样不许代走
      if (gameSession.gameData && gameSession.gameData.isPaused) continue;
      // 思考时间用完立刻代走：前端计时器可被刷新或改脚本绕开，
      // 这里才是「拖延时间拿不到额外回合」的保证
      const thinkingExpired = isThinkingExpired(gameSession, now);

      if (!thinkingExpired && !session.isStuck(now)) continue;

      const stuckColor = session.state.currentPlayer;
      const player = playerOfColor(gameSession, stuckColor);

      // 机器人 / 托管玩家的回合归 botDriver 按节奏走，看门狗只在它那条链真断了
      //（60 秒没动静）时才兜底；否则会在客户端还在演动画时插一脚，
      // 代走好几步却只播最后一帧，看着就是「一瞬间过去一手」
      if (player && (player.isAI || player.isAITakeover)) {
        if (!session.isStuck(now)) continue;
      } else if (thinkingExpired && player) {
        // 真人思考窗口到点：转成 AI 托管，让 botDriver 接手按正常节奏走完这一手，
        // 各端照常演动画、记战报（昵称上的【Bot】标记也是这么来的）
        player.isAITakeover = true;
        gameSession.broadcast({
          type: 'aiTakeoverChange',
          playerId: player.id,
          isActive: true,
          auto: true,
          reason: 'thinking_timeout',
          timestamp: now
        });
        botDriver.kick(gameSession);
        continue;
      }

      const results = session.advanceStuckTurn();
      if (!results.length) continue;

      commitSnapshot(gameSession, results[results.length - 1].snapshot);
      console.log(`[回合看门狗] 玩家 ${stuckColor} ${thinkingExpired ? '思考超时' : '空闲超时'}，服务端代走 ${results.length} 步`);
    }
  }, WATCHDOG_INTERVAL_MS);
}
