const crypto = require('node:crypto');

const LEVELS = new Set(['easy', 'hard', 'hell']);
const REACTIONS = { hello: '牌友好呀', hurry: '轮到你啦', nice: '这手漂亮', thinking: '让我想想', wow: '好家伙！', gg: '打得不错' };
const BOT_NAMES = { easy: ['小青 · 陪练', '阿金 · 陪练'], hard: ['青狐 · 棋手', '金狐 · 棋手'], hell: ['玄鸦 · 魔王', '赤狐 · 魔王'] };

class DoudizhuService {
  constructor({ auth = {}, sanitizeText = text => text, turnMs = 30000, bidMs = 15000, botDelayMs = 900, tickMs = 200, disconnectGraceMs = 2500 } = {}) {
    Object.assign(this, { auth, sanitizeText, turnMs, bidMs, botDelayMs, disconnectGraceMs });
    this.rooms = new Map();
    this.sessions = new Map();
    this.ready = Promise.all([
      import('../games/doudizhu/engine.mjs'), import('../games/doudizhu/bot.mjs')
    ]).then(([engine, bot]) => { this.engine = engine; this.bot = bot; });
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref();
    this.lastCleanup = Date.now();
  }

  send(ws, message) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(message));
  }
  error(ws, code, message, requestId) { this.send(ws, { type: 'error', code, message, requestId }); }

  handleConnection(ws, req = {}) {
    let session = null;
    let queue = this.ready;
    let rateStart = Date.now();
    let messages = 0;
    let alive = true;
    const account = this.auth.userFromCookieHeader?.(req.headers?.cookie || '');
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      if (ws.readyState === 1) ws.ping();
    }, 25000);
    heartbeat.unref();
    ws.on('message', raw => {
      if (raw.length > 16384) { this.error(ws, 'tooLarge', '消息太长了'); return; }
      if (Date.now() - rateStart > 5000) { rateStart = Date.now(); messages = 0; }
      if (++messages > 60) { this.error(ws, 'rateLimit', '操作太快了，稍等一下'); return; }
      let message;
      try { message = JSON.parse(String(raw)); } catch { this.error(ws, 'invalidMessage', '消息格式不正确'); return; }
      if (!message || typeof message.type !== 'string') return;
      queue = queue.then(() => {
        if (ws.readyState !== 1) return;
        if (message.type === 'hello') {
          // 一条连接只绑定一次身份，避免中途换 token 留下幽灵玩家。
          if (session) { this.sendWelcome(session); return; }
          session = this.identify(ws, message, account);
        } else if (!session || session.ws !== ws) this.error(ws, 'identifyFirst', '请先连接到牌桌');
        else {
          session.lastSeen = Date.now();
          this.handleMessage(session, message);
        }
      }).catch(error => {
        console.error('[斗地主] 消息处理失败:', error);
        this.error(ws, 'serverError', '刚才的操作没有完成，请再试一次');
      });
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      if (!session || session.ws !== ws) return;
      session.ws = null;
      session.lastSeen = Date.now();
      const room = this.rooms.get(session.roomCode);
      const player = room?.players.find(item => item?.id === session.id);
      if (player) {
        player.connected = false;
        player.disconnectedAt = Date.now();
        if (!room.game) player.ready = player.id === room.hostId;
        this.publish(room);
      }
    });
    ws.on('error', () => {});
  }

  identify(ws, message, account) {
    const token = typeof message.token === 'string' ? message.token : '';
    let session = this.sessions.get(token);
    if (session && session.userId && session.userId !== account?.id) session = null;
    if (session && account) {
      const currentRoom = this.rooms.get(session.roomCode);
      const occupied = currentRoom?.players.find(item => item && !item.abandoned && item.id !== session.id && item.userId === account.id);
      const accountSession = occupied && [...this.sessions.values()].find(item => item.id === occupied.id && item.roomCode === currentRoom.code);
      if (accountSession) {
        // 游客登录已在本桌入座的账号时，接回账号原座位，避免一人占两席。
        this.leave(session);
        session = accountSession;
      }
    }
    if (!session) {
      session = {
        token: crypto.randomBytes(24).toString('hex'), id: `ddz_${crypto.randomBytes(9).toString('hex')}`,
        userId: account?.id || null, nickname: this.nickname(account?.nickname || message.nickname),
        ws: null, roomCode: null, lastSeen: Date.now(), createRequests: new Map()
      };
      this.sessions.set(session.token, session);
    }
    if (session.ws && session.ws !== ws) {
      this.send(session.ws, { type: 'superseded' });
      session.ws.close(4001, 'Opened in another connection');
    }
    session.ws = ws;
    session.lastSeen = Date.now();
    if (account) { session.userId = account.id; session.nickname = this.nickname(account.nickname); }
    const room = this.rooms.get(session.roomCode);
    if (!room) session.roomCode = null;
    const player = room?.players.find(item => item?.id === session.id && !item.abandoned);
    if (room && !player) session.roomCode = null;
    if (player) {
      player.connected = true;
      player.disconnectedAt = null;
      player.nickname = session.nickname;
      player.userId = session.userId;
      if (player.autoReason === 'offline') { player.auto = false; player.autoReason = null; }
    }
    this.sendWelcome(session);
    if (player) this.publish(room);
    return session;
  }

  nickname(value) {
    const text = this.sanitizeText(String(value || '')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return [...text].slice(0, 16).join('') || '今晚的牌友';
  }
  sendWelcome(session) {
    this.send(session.ws, { type: 'welcome', token: session.token, playerId: session.id, roomCode: session.roomCode, serverNow: Date.now() });
    const room = this.rooms.get(session.roomCode);
    if (room) this.sendState(room, session);
  }
  player(session, seat = 0, host = false) {
    return { id: session.id, nickname: session.nickname, userId: session.userId, seat, isBot: false, ready: host, connected: true, auto: false, autoReason: null, abandoned: false, rematchReady: false, avatar: ['queen', 'king', 'jack'][seat] };
  }
  makeBot(seat, level, variant = seat % 2) {
    return {
      id: `bot_${crypto.randomBytes(6).toString('hex')}`, nickname: BOT_NAMES[level][variant], seat,
      isBot: true, level, ready: true, connected: true, auto: true, abandoned: false, rematchReady: true,
      avatar: level === 'hell' ? (variant ? 'joker-red' : 'raven') : (variant ? 'joker-red' : 'joker-green')
    };
  }
  code() {
    let code;
    do { code = String(crypto.randomInt(100000, 1000000)); } while (this.rooms.has(code));
    return code;
  }

  handleMessage(session, message) {
    const data = message.data && typeof message.data === 'object' ? message.data : {};
    if (message.type === 'ping') { this.send(session.ws, { type: 'pong', serverNow: Date.now() }); return; }
    if (message.type === 'nickname') {
      if (!session.userId && !this.rooms.get(session.roomCode)?.game) session.nickname = this.nickname(data.nickname);
      return;
    }
    if (message.type === 'detachAccount') {
      // 退出账号只取消这一位玩家的战绩绑定，手牌、座位和对局继续保留。
      session.userId = null;
      const room = this.rooms.get(session.roomCode);
      const player = room?.players.find(item => item?.id === session.id);
      if (player) { player.userId = null; this.publish(room); }
      this.send(session.ws, { type: 'accountDetached' });
      return;
    }
    if (message.type === 'create') { this.create(session, data, message.requestId); return; }
    if (message.type === 'join') { this.join(session, data); return; }
    if (message.type === 'leave') { this.leave(session); return; }
    if (message.type === 'sync') {
      const room = this.rooms.get(session.roomCode);
      if (room) this.sendState(room, session);
      else this.send(session.ws, { type: 'left' });
      return;
    }
    const room = this.rooms.get(session.roomCode);
    const seat = room?.players.findIndex(item => item?.id === session.id && !item.abandoned);
    if (!room || seat < 0) { this.error(session.ws, 'roomGone', '房间已结束，可以重新开一桌'); return; }
    const player = room.players[seat];
    room.touchedAt = Date.now();
    const host = session.id === room.hostId;
    switch (message.type) {
      case 'ready':
        if (room.game) { this.error(session.ws, 'inProgress', '牌局已经开始了'); break; }
        player.ready = Boolean(data.ready);
        this.publish(room);
        break;
      case 'settings':
        if (!host) { this.error(session.ws, 'hostOnly', '只有房主可以设置牌桌'); break; }
        if (room.game) { this.error(session.ws, 'inProgress', '下一局再调整人机难度'); break; }
        if (data.difficulty !== undefined && !LEVELS.has(data.difficulty)) { this.error(session.ws, 'invalidLevel', '请选择简单、困难或地狱'); break; }
        if (data.difficulty) {
          room.difficulty = data.difficulty;
          room.players = room.players.map((item, index) => item?.isBot ? this.makeBot(index, room.difficulty) : item);
        }
        if (typeof data.autoFill === 'boolean') room.autoFill = data.autoFill;
        this.publish(room);
        break;
      case 'bot':
        if (!host) { this.error(session.ws, 'hostOnly', '只有房主可以增减人机'); break; }
        if (room.game) { this.error(session.ws, 'inProgress', '下一局再调整座位'); break; }
        if (!Number.isInteger(data.seat) || data.seat < 0 || data.seat > 2) break;
        if (room.players[data.seat] && !room.players[data.seat].isBot) { this.error(session.ws, 'humanSeat', '这位牌友的座位不能改成人机'); break; }
        room.players[data.seat] = data.enabled ? this.makeBot(data.seat, room.difficulty) : null;
        this.publish(room);
        break;
      case 'start':
        if (!host) { this.error(session.ws, 'hostOnly', '等房主开局'); break; }
        this.start(room, session);
        break;
      case 'action':
        if (!room.game) { this.error(session.ws, 'notStarted', '等大家到齐再开局'); break; }
        this.act(room, seat, data, 'human', session);
        break;
      case 'auto':
        if (!room.game || room.game.phase === 'ended') break;
        player.auto = Boolean(data.enabled);
        player.autoReason = player.auto ? 'manual' : null;
        if (room.game.turn === seat) room.botDue = Date.now() + this.botDelayMs;
        this.publish(room);
        break;
      case 'reaction':
        if (!REACTIONS[data.key] || Date.now() - (player.lastReaction || 0) < 2000) break;
        player.lastReaction = Date.now();
        for (const target of this.members(room)) this.send(target.ws, { type: 'reaction', seat, key: data.key, text: REACTIONS[data.key], id: crypto.randomBytes(4).toString('hex') });
        break;
      case 'rematch':
        if (room.game?.phase !== 'ended') break;
        player.rematchReady = true;
        if (room.players.filter(item => !item.isBot && !item.abandoned).every(item => item.rematchReady && item.connected)) {
          room.players = room.players.map((item, index) => item.abandoned ? this.makeBot(index, room.difficulty) : { ...item, ready: true, rematchReady: item.isBot });
          room.game = null;
          this.start(room, session, true);
        } else this.publish(room);
        break;
      case 'lobby':
        if (!host) { this.error(session.ws, 'hostOnly', '等房主返回房间'); break; }
        if (room.game?.phase !== 'ended') break;
        room.game = null;
        room.deadline = null;
        room.botDue = null;
        room.players = room.players.map((item, index) => item.abandoned ? null : { ...item, ready: item.isBot || item.id === room.hostId, rematchReady: item.isBot });
        this.publish(room);
        break;
      default:
        this.error(session.ws, 'invalidMessage', '无法识别这个操作');
    }
  }

  create(session, data, requestId) {
    const previous = typeof requestId === 'string' && session.createRequests.get(requestId);
    if (previous && session.roomCode === previous.code && Date.now() - previous.at < 60000 && this.rooms.has(previous.code)) {
      this.sendState(this.rooms.get(previous.code), session);
      return;
    }
    if (session.roomCode) { this.error(session.ws, 'alreadyInRoom', '先离开当前牌桌再开新房间', requestId); return; }
    if (!LEVELS.has(data.difficulty || 'hard')) { this.error(session.ws, 'invalidLevel', '请选择简单、困难或地狱', requestId); return; }
    if (!session.userId) session.nickname = this.nickname(data.nickname || session.nickname);
    const difficulty = data.difficulty || 'hard';
    const room = {
      code: this.code(), hostId: session.id, players: [this.player(session, 0, true), null, this.makeBot(2, difficulty)],
      difficulty, autoFill: data.autoFill !== false, game: null, round: 0, revision: 0,
      createdAt: Date.now(), touchedAt: Date.now(), deadline: null, botDue: null, recorded: false
    };
    this.rooms.set(room.code, room);
    session.roomCode = room.code;
    if (typeof requestId === 'string' && requestId.length <= 100) {
      for (const [key, entry] of session.createRequests) if (Date.now() - entry.at > 60000) session.createRequests.delete(key);
      session.createRequests.set(requestId, { at: Date.now(), code: room.code });
    }
    if (data.solo) { room.players[1] = this.makeBot(1, difficulty); this.start(room, session); }
    else this.publish(room);
  }

  join(session, data) {
    const code = String(data.code || '').replace(/[\s-]/g, '');
    const room = this.rooms.get(code);
    if (!room) { this.error(session.ws, 'roomGone', '没有找到这个房间，检查一下六位房间码'); return; }
    if (session.roomCode === code) { this.sendState(room, session); return; }
    if (session.roomCode) { this.error(session.ws, 'alreadyInRoom', '先离开当前牌桌再加入'); return; }
    if (room.game) { this.error(session.ws, 'inProgress', '这桌正在打牌，等牌友返回房间再加入'); return; }
    if (session.userId && room.players.some(item => item?.userId === session.userId)) { this.error(session.ws, 'sameAccount', '这个账号已经在房间里了'); return; }
    const seat = room.players.findIndex(item => !item);
    if (seat < 0) { this.error(session.ws, 'roomFull', '座位满了，让房主移除一位人机即可加入'); return; }
    if (!session.userId) session.nickname = this.nickname(data.nickname || session.nickname);
    room.players[seat] = this.player(session, seat);
    session.roomCode = code;
    this.publish(room);
  }

  leave(session) {
    const room = this.rooms.get(session.roomCode);
    session.roomCode = null;
    this.send(session.ws, { type: 'left' });
    if (!room) return;
    const seat = room.players.findIndex(item => item?.id === session.id);
    if (seat < 0) return;
    if (room.game) {
      Object.assign(room.players[seat], { connected: false, auto: true, autoReason: 'left', abandoned: true });
    } else room.players[seat] = null;
    const humans = room.players.filter(item => item && !item.isBot && !item.abandoned);
    if (!humans.length) { this.rooms.delete(room.code); return; }
    if (room.hostId === session.id) {
      room.hostId = (humans.find(item => item.connected) || humans[0]).id;
      if (!room.game) humans.find(item => item.id === room.hostId).ready = true;
    }
    this.publish(room);
  }

  start(room, session, rematch = false) {
    if (room.game) { this.error(session.ws, 'inProgress', '牌局已经开始了'); return; }
    const humans = room.players.filter(item => item && !item.isBot);
    if (humans.some(item => !item.connected || !item.ready)) { this.error(session.ws, 'notReady', '等牌友连接并准备好再开局'); return; }
    if (room.players.some(item => !item) && !room.autoFill) { this.error(session.ws, 'needPlayers', '需要三位玩家，可以添加人机或开启自动补位'); return; }
    room.players = room.players.map((item, seat) => item || this.makeBot(seat, room.difficulty));
    room.round++;
    room.recorded = false;
    room.startedAt = Date.now();
    const firstBidder = rematch ? (room.round - 1) % 3 : crypto.randomInt(0, 3);
    room.game = this.engine.createGame({ seed: crypto.randomBytes(4).readUInt32LE(), firstBidder });
    for (const player of room.players) { player.rematchReady = player.isBot; if (player.autoReason !== 'manual') { player.auto = player.isBot; player.autoReason = null; } }
    this.advanceClock(room, true);
    this.publish(room);
  }

  advanceClock(room, dealing = false) {
    room.deadline = room.game.phase === 'ended' ? null : Date.now() + (room.game.phase === 'bidding' ? this.bidMs : this.turnMs);
    room.botDue = room.game.phase === 'ended' ? null : Date.now() + this.botDelayMs + (dealing ? 800 : 0);
  }

  act(room, seat, action, source, session) {
    const result = this.engine.applyAction(room.game, seat, action);
    if (!result.ok) {
      if (session) this.error(session.ws, result.code, result.reason);
      return false;
    }
    room.game = result.state;
    room.game.lastAction.source = source;
    if (source === 'human') { room.players[seat].auto = false; room.players[seat].autoReason = null; }
    this.advanceClock(room, room.game.lastAction.type === 'redeal');
    if (room.game.phase === 'ended' && !room.recorded) {
      room.recorded = true;
      const winnerColors = room.game.winnerSide === 'landlord'
        ? [room.game.landlordSeat] : [0, 1, 2].filter(index => index !== room.game.landlordSeat);
      this.auth.recordMatch?.({
        gameId: 'doudizhu', roomCode: room.code, mode: `classic-${room.difficulty}`,
        players: room.players.map((player, color) => ({ playerId: player.id, nickname: player.nickname, color, userId: player.isBot ? null : player.userId })),
        winnerColors, durationMs: Date.now() - room.startedAt
      });
    }
    this.publish(room);
    return true;
  }

  members(room) {
    const ids = new Set(room.players.filter(item => item && !item.isBot && !item.abandoned).map(item => item.id));
    return [...this.sessions.values()].filter(session => ids.has(session.id) && session.roomCode === room.code);
  }
  roomInfo(room) {
    return {
      code: room.code, hostId: room.hostId, difficulty: room.difficulty, autoFill: room.autoFill, round: room.round,
      players: room.players.map(item => item ? {
        id: item.id, nickname: item.nickname, seat: item.seat, isBot: item.isBot, level: item.level,
        ready: item.ready, connected: item.connected, auto: item.auto, autoReason: item.autoReason,
        rematchReady: item.rematchReady, avatar: item.avatar
      } : null)
    };
  }
  sendState(room, session) {
    const seat = room.players.findIndex(item => item?.id === session.id);
    if (seat < 0) return;
    this.send(session.ws, {
      type: 'state', revision: room.revision, serverNow: Date.now(), room: this.roomInfo(room),
      me: { id: session.id, seat }, game: room.game ? { ...this.engine.publicState(room.game, seat), deadline: room.deadline } : null
    });
  }
  publish(room) {
    room.revision++;
    room.touchedAt = Date.now();
    for (const session of this.members(room)) this.sendState(room, session);
  }
  listRooms() {
    return [...this.rooms.values()].map(room => ({
      code: room.code, phase: room.game?.phase || 'waiting', difficulty: room.difficulty,
      playerCount: room.players.filter(Boolean).length,
      humans: room.players.filter(item => item && !item.isBot && item.connected).length,
      openSeats: room.players.filter(item => !item).length
    }));
  }

  tick() {
    if (!this.engine || !this.bot) return;
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (!room.game || room.game.phase === 'ended') continue;
      const seat = room.game.turn;
      const player = room.players[seat];
      const offline = !player.connected && now - (player.disconnectedAt || 0) >= this.disconnectGraceMs;
      if (offline && !player.auto) { player.auto = true; player.autoReason = 'offline'; this.publish(room); }
      if (!((player.isBot || player.auto) && now >= room.botDue) && now < room.deadline) continue;
      try {
        const view = this.bot.botView(room.game, seat);
        const action = this.bot.chooseAction(view, player.level || room.difficulty);
        if (action) this.act(room, seat, action, player.isBot ? 'bot' : player.auto ? 'auto' : 'timeout');
      } catch (error) {
        console.error('[斗地主] 人机思考失败:', error);
        // 即使某一策略失败，回合仍可用合法的最低开销动作继续。
        const action = room.game.phase === 'bidding' ? { type: 'bid', score: 0 }
          : room.game.trick ? { type: 'pass' } : { type: 'play', cards: [room.game.hands[seat].at(-1)] };
        this.act(room, seat, action, 'fallback');
      }
    }
    if (now - this.lastCleanup < 60000) return;
    this.lastCleanup = now;
    for (const [code, room] of this.rooms) {
      if (!room.players.some(item => item && !item.isBot && item.connected) && now - room.touchedAt > 15 * 60000) {
        this.rooms.delete(code);
        for (const session of this.sessions.values()) if (session.roomCode === code) session.roomCode = null;
      }
    }
    for (const [token, session] of this.sessions) if (!session.ws && !session.roomCode && now - session.lastSeen > 24 * 60 * 60000) this.sessions.delete(token);
  }

  close() {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.ws?.close();
  }
}

module.exports = { DoudizhuService };
