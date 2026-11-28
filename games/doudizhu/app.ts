import { byId } from '../../web/js/dom.ts';
import { clientProtocol } from './protocol.ts';
import type { ClientPayloads, ClientMessage, ServerMessage, ReactionKey } from './protocol.ts';
import type { CardId, Difficulty, GameEvent, GameMode, PublicGame, RoomInfo, Play } from './types.ts';
interface DragSelection { pointerId: number; chosen: boolean; visited: Set<string>; previous: number }
interface Particle { x: number; y: number; vx: number; vy: number; born: number; life: number; angle: number; spin: number; width: number; color: string; gravity: number }
import { cardInfo, rankOf, rankLabel, sortCards, rankGroups, classify, canBeat, legalPlays, DECK, RANK_LABELS } from './engine.ts';
import { DIFFICULTIES, suggestedPlays } from './bot.ts';

function $<Id extends keyof import('../../web/js/dom.ts').HtmlIds>(id: Id): import('../../web/js/dom.ts').HtmlIds[Id];
function $(id: string): HTMLElement;
function $(id: string): Element { return byId(id)!; }
const escapeHtml = (value: string) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char]!);
const motionReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function stored(storage: Storage, key: string, fallback: string) { try { return storage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(storage: Storage, key: string, value: string) { try { storage.setItem(key, value); } catch {} }

const iconPaths: Record<string, string> = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  crown: '<path d="m3 6 4.5 4L12 4l4.5 6L21 6l-2 12H5L3 6Z"/><path d="M6 21h12"/>',
  leaf: '<path d="M19 3c-9-1-15 3-15 10a6 6 0 0 0 10 4c4-4 5-9 5-14Z"/><path d="M4 21 15 9"/>',
  flame: '<path d="M13 2c1 6-5 6-3 11 1-1 3-2 4-5 5 4 6 8 2 12-4 3-11 0-11-5 0-4 2-7 5-9-1 3 0 5 1 5 2-2 3-5 2-9Z"/>',
  cards: '<rect x="8" y="4" width="12" height="16" rx="2"/><path d="m6 6-3 1 4 15 10-3"/><path d="m14 8-3 4 3 3 3-3-3-4Z"/>',
  sound: '<path d="M11 4 6 8H3v8h3l5 4V4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="M11 4 6 8H3v8h3l5 4V4Z"/><path d="m16 9 6 6m0-6-6 6"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  robot: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4m-6 6h2m8 0h2M9 17h6M1 11v5m22-5v5"/><circle cx="12" cy="2" r="1"/>',
  chat: '<path d="M21 11a9 9 0 0 1-14 8l-4 2 1-5a9 9 0 1 1 17-5Z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/>',
  sort: '<path d="M7 4v16m-3-3 3 3 3-3M13 5h8m-8 6h6m-6 6h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  rocket: '<path d="M14 3c4-2 7-1 7-1s1 3-1 7l-9 9-5-5 8-10Z"/><circle cx="16" cy="7" r="2"/><path d="m7 12-4-1-1 6 5-1m5 1 1 5 6-1-1-4M5 19l-3 3m5-1-1 2"/>',
  bomb: '<circle cx="11" cy="14" r="7"/><path d="m15 8 2-3m-2-1 3 2 2-3m0-2 1 1M9 10l-2 2"/>',
  plane: '<path d="m21 3-7 18-3-8-8-3L21 3Z"/><path d="m11 13 10-10M3 19l3-3m1 5 2-2"/>',
  wind: '<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M5 16h5a3 3 0 1 1-3 3"/>',
  flower: '<path d="M12 12c-9-1-8-7-4-6-1-5 6-6 8-1 6-1 7 5 2 7 5 5-1 9-5 5-4 5-10 0-6-5Z"/><circle cx="12" cy="12" r="2"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>',
  flag: '<path d="M5 21V4m0 1h12l-2.5 4.5L17 14H5"/>',
  spark: '<path d="M12 2 14.5 9.5 22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>'
};
function icon(name: string) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.cards}</svg>`; }
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon!); });
document.querySelector<HTMLElement>('.fullscreen-button')!.innerHTML = icon('fullscreen');

const suitShapes: Record<string, string> = {
  spade: '<path d="M12 1C9 6 2 9 2 14c0 5 6 7 9 3l-2 6h6l-2-6c3 4 9 2 9-3C22 9 15 6 12 1Z"/>',
  heart: '<path d="M12 22C8 17 1 13 1 7a6 6 0 0 1 11-3A6 6 0 0 1 23 7c0 6-7 10-11 15Z"/>',
  club: '<path d="M12 1a5 5 0 0 0-4 8A6 6 0 1 0 10 19l-2 4h8l-2-4a6 6 0 1 0 2-10 5 5 0 0 0-4-8Z"/>',
  diamond: '<path d="m12 0 11 12-11 12L1 12 11 0Z"/>'
};
function suitSvg(suit: string) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${suitShapes[suit] || suitShapes.spade}</svg>`; }
function pipPositions(number: number) {
  const pairs = (rows: number[]) => rows.flatMap(y => [[0, y], [100, y]]);
  return ({
    2: [[50, 0], [50, 100]], 3: [[50, 0], [50, 50], [50, 100]],
    4: pairs([0, 100]), 5: [...pairs([0, 100]), [50, 50]], 6: pairs([0, 50, 100]),
    7: [...pairs([0, 50, 100]), [50, 25]], 8: [...pairs([0, 50, 100]), [50, 25], [50, 75]],
    9: [...pairs([0, 33, 67, 100]), [50, 50]], 10: [...pairs([0, 33, 67, 100]), [50, 17], [50, 83]]
  } as Record<number, number[][]>)[number] || [[50, 50]];
}
function cardHtml(id: CardId, { back = false, interactive = false, index = 0, laiziRank = game?.laiziRank ?? null }: { back?: boolean; interactive?: boolean; index?: number; laiziRank?: number | null } = {}) {
  if (back) return `<div class="card card-back" role="img" aria-label="未揭开的底牌" style="--index:${index}"><span class="back-emblem">♠</span></div>`;
  const card = cardInfo(id);
  if (!card) return '';
  const court = card.rank >= 11 && card.rank <= 13;
  const joker = card.rank >= 16;
  const ace = card.rank === 14;
  const isLaizi = laiziRank !== null && card.rank === laiziRank;
  const face = joker ? (card.red ? 'joker-red' : 'joker-green') : ({ 11: 'jack', 12: 'queen', 13: 'king' } as Record<number, string>)[card.rank];
  const center = court || joker
    ? `<div class="card-portrait"><img src="assets/${face}.webp" alt="" draggable="false"></div>${joker ? '<span class="joker-caption">JOKER</span>' : ''}`
    : `<div class="card-center">${ace ? '<span class="ace-rosette"></span>' : ''}${pipPositions(ace ? 1 : card.rank === 15 ? 2 : card.rank).map(([x, y]) => `<span class="pip ${y > 50 ? 'upside-down' : ''}" style="left:${x}%;top:${y}%">${suitSvg(card.suit)}</span>`).join('')}</div>`;
  const corner = `<b>${card.label}</b><span>${card.symbol}</span>`;
  const tag = interactive ? 'button' : 'div';
  const label = `${joker ? card.label : `${card.symbol} ${card.label}`}${isLaizi ? '（癞子）' : ''}`;
  const laiziTag = isLaizi ? '<span class="laizi-mark" aria-hidden="true">癞</span>' : '';
  return `<${tag} ${interactive ? 'type="button" aria-pressed="false"' : 'role="img"'} aria-label="${label}" class="card ${card.red ? 'red' : ''} ${court ? 'court' : ''} ${joker ? 'joker' : ''} ${ace ? 'ace' : ''} ${isLaizi ? 'is-laizi' : ''}" data-card="${id}" data-rank="${card.rank}" style="--index:${index}"><span class="card-corner" aria-hidden="true">${corner}</span>${laiziTag}${center}<span class="card-corner card-corner-bottom" aria-hidden="true">${corner}</span></${tag}>`;
}

const MODES: Record<GameMode, { name: string }> = { classic: { name: '经典' }, laizi: { name: '癞子' } };
let mode: GameMode = stored(localStorage, 'ddz_mode', 'classic') as GameMode;
if (!MODES[mode]) mode = 'classic';
let difficulty: Difficulty = stored(localStorage, 'ddz_difficulty', 'hard') as Difficulty;
if (!DIFFICULTIES[difficulty]) difficulty = 'hard';
let soundOn = stored(localStorage, 'ddz_sound', 'true') === 'true';
let token = stored(sessionStorage, 'ddz_session', '');
let ws: WebSocket | null = null;
let online = false;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
let superseded = false;
let busy = false;
let room: RoomInfo | null = null;
let game: PublicGame | null = null;
let me: {id: string; seat: number} | null = null;
let revision = -1;
let serverOffset = 0;
let restoredFromWelcome = false;
let inviteAttempted = false;
const invitedRoom = new URL(location.href).searchParams.get('room');
let selected: Set<string> = new Set();
let sortMode = 'rank';
let handKey = '';
let legalCacheKey = '';
let legalCache: Play[] = [];
let hintKey = '';
let hintMoves: (Play & {score: number})[] = [];
let hintIndex = 0;
let resultTimer: number | null = null;
let endingTimer: number | null = null;
let resultSeenKey = '';
let toastTimer: number | undefined;
let drag: DragSelection | null = null;
let lastPointerSelection = 0;
const reactions: Map<number, Extract<ServerMessage, {type: "reaction"}> & {expires: number}> = new Map();
let account = window.accountUI?.getUser() || null;
$('nickname').value = account?.nickname || stored(localStorage, 'ddz_nickname', '');

function toast(message: string) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800);
}
function send<Type extends Exclude<keyof ClientPayloads, 'hello'>>(type: Type, ...args: {} extends ClientPayloads[Type]
  ? [data?: ClientPayloads[Type], requestId?: string]
  : [data: ClientPayloads[Type], requestId?: string]) {
  const [data = {}, requestId] = args;
  if (!online || ws?.readyState !== WebSocket.OPEN) {
    toast('连接正在恢复，稍等一下再操作');
    return false;
  }
  ws.send(clientProtocol.encode({ type, data, ...(requestId ? { requestId } : {}) } as ClientMessage));
  return true;
}
function setBusy(value: boolean) { busy = value; updateConnection(); }
function updateConnection() {
  for (const id of ['soloButton', 'createButton']) ($(id) as HTMLButtonElement).disabled = busy;
  ($('joinForm').querySelector<HTMLElement>('button')! as HTMLButtonElement).disabled = busy;
  if (online) $('connectionBanner').hidden = true;
  else {
    $('connectionBanner').hidden = false;
    $('connectionBanner').innerHTML = superseded
      ? '这张牌桌已在另一个窗口打开。<button data-command="reconnect">接回这里</button>'
      : `${reconnectAttempts ? '连接断开，正在重连' : '正在连接牌桌…'}${room ? ' · 牌局已保留' : ''}`;
  }
  if (room && game) { updateSelection(); renderActionBar(); }
}
function connect() {
  if (superseded || ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimer!);
  online = false;
  updateConnection();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/doudizhu`);
  const current = ws;
  current.addEventListener('open', () => {
    if (current !== ws) return;
    current.send(JSON.stringify({ type: 'hello', token, nickname: $('nickname').value.trim() }));
  });
  current.addEventListener('message', event => {
    if (current !== ws) return;
    try { receive(clientProtocol.decode(JSON.parse(event.data))); } catch (error) { console.error('牌桌更新失败', error); toast('牌桌更新没有完成，正在重新同步'); if (online) send('sync'); }
  });
  current.addEventListener('close', event => {
    if (current !== ws) return;
    online = false;
    busy = false;
    if (event.code === 4001) superseded = true;
    updateConnection();
    if (!superseded) {
      reconnectAttempts++;
      reconnectTimer = setTimeout(connect, Math.min(12000, 700 * 1.7 ** reconnectAttempts) + Math.random() * 300);
    }
  });
  current.addEventListener('error', () => {});
}

function receive(message: ServerMessage) {
  if (Number.isFinite(message.serverNow)) serverOffset = message.serverNow! - Date.now();
  if (message.type === 'welcome') {
    token = message.token;
    save(sessionStorage, 'ddz_session', token);
    online = true;
    reconnectAttempts = 0;
    superseded = false;
    restoredFromWelcome = Boolean(message.roomCode);
    if (room && !message.roomCode) { resetRoom(); toast('这张牌桌已结束，可以重新入座'); }
    updateConnection();
    if (invitedRoom && !message.roomCode && !inviteAttempted) { inviteAttempted = true; joinRoom(invitedRoom); }
    return;
  }
  if (message.type === 'state') {
    if (room?.code === message.room!.code && message.revision <= revision) return;
    const previousGame = game;
    const previousRoom = room;
    const sameRound = previousRoom?.code === message.room!.code && previousRoom?.round === message.room!.round;
    const isNewAction = sameRound && previousGame && message.game?.seq! > previousGame.seq;
    const action = isNewAction ? message.game!.lastAction : null;
    const origins = action?.type === 'play' ? captureOrigins(action, message.me) : null;
    room = message.room;
    game = message.game;
    me = message.me;
    revision = message.revision;
    busy = false;
    selected = new Set([...selected].filter(id => game?.hand.includes(id)));
    if (game?.phase !== 'playing') selected.clear();
    const dealing = Boolean(game && (!previousGame || !sameRound || game!.deal !== previousGame.deal) && !restoredFromWelcome);
    const drawn = sameRound && previousGame?.phase === 'bidding' && game?.phase === 'playing' && game!.landlordSeat === me!.seat ? game!.bottom : [];
    if (!sameRound || game?.deal !== previousGame?.deal) { handKey = ''; hintKey = ''; selected.clear(); }
    render({ dealing, drawn, action });
    restoredFromWelcome = false;
    if (dealing) sounds.play('deal');
    if (drawn.length) sounds.play('reveal');
    if (action?.type === 'play') {
      animatePlay(action, origins!);
      sounds.play(['bomb', 'rocket'].includes(action.pattern.type) ? action.pattern.type : 'card');
      showCombo(action.pattern.type);
      if (game!.counts[action.seat] <= 2 && game!.counts[action.seat] > 0) sounds.play('warning');
    } else if (action?.type === 'pass') sounds.play('pass');
    else if (action?.type === 'landlord') sounds.play('reveal');
    else if (action?.type === 'openHand') {
      sounds.play('reveal');
      const actor = room!.players[action.seat];
      toast(`${action.seat === me!.seat ? '你' : actor?.nickname || '玩家'}选择了明牌！倍率 ×2`);
    } else if (action?.type === 'surrender') {
      sounds.play('pass');
      const actor = room!.players[action.seat];
      toast(`${action.seat === me!.seat ? '你' : actor?.nickname || '玩家'}已投降，牌局结束`);
    }
    if (game?.phase === 'ended') {
      if ($('surrenderDialog').open) $('surrenderDialog').close();
      if ($('resultDialog').open) renderResult();
      const key = `${room!.code}:${room!.round}`;
      if (resultSeenKey !== key) {
        resultSeenKey = key;
        if (account && previousGame?.phase === 'playing' && sameRound) window.accountUI?.refresh();
        clearTimeout(resultTimer!);
        clearTimeout(endingTimer!);
        const surrendered = game!.surrenderBy !== null;
        const animateEnding = previousGame?.phase === 'playing' && sameRound && !motionReduced() && !surrendered;
        const won = game!.scores![me!.seat] > 0;
        if (animateEnding) {
          endingTimer = setTimeout(() => {
            if (game?.phase !== 'ended' || `${room!.code}:${room!.round}` !== key) return;
            if (game!.spring) showCombo('spring');
            else if (won) particleBurst('victory');
            sounds.play(won ? 'win' : 'lose');
          }, 550);
        }
        const dramaticFinish = ['bomb', 'rocket'].includes(game!.lastAction?.pattern?.type ?? '');
        const resultDelay = surrendered ? 250 : !animateEnding ? 100 : game!.spring ? 2300 : dramaticFinish ? 1900 : won ? 1500 : 900;
        resultTimer = setTimeout(() => {
          if (game?.phase !== 'ended' || `${room!.code}:${room!.round}` !== key) return;
          renderResult();
          if (!$('resultDialog').open) $('resultDialog').showModal();
        }, resultDelay);
      }
    } else { clearTimeout(resultTimer!); clearTimeout(endingTimer!); if ($('resultDialog').open) $('resultDialog').close(); }
    return;
  }
  if (message.type === 'error') { busy = false; updateConnection(); toast(message.message || '这次操作没有完成'); return; }
  if (message.type === 'left') { resetRoom(); return; }
  if (message.type === 'superseded') { superseded = true; online = false; updateConnection(); return; }
  if (message.type === 'reaction' && room) {
    const reaction = { ...message, expires: Date.now() + 3200 };
    reactions.set(message.seat, reaction);
    renderPlayers();
    setTimeout(() => { if (reactions.get(message.seat)?.id === message.id) { reactions.delete(message.seat); renderPlayers(); } }, 3200);
  }
}

function resetRoom() {
  room = null; game = null; me = null;
  revision = -1;
  selected.clear();
  handKey = '';
  resultSeenKey = '';
  clearTimeout(resultTimer!);
  clearTimeout(endingTimer!);
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
  $('landing').hidden = false;
  $('tableView').hidden = true;
  document.body.classList.remove('in-table');
  history.replaceState(null, '', new URL('./', location.href).pathname);
  updateConnection();
}
function nickname() {
  const value = $('nickname').value.trim() || '今晚的牌友';
  save(localStorage, 'ddz_nickname', value);
  return value;
}
function createRoom(solo: boolean) {
  if (busy) return;
  if (!online) { toast('牌桌还在连接，请稍等片刻'); connect(); return; }
  const requestId = crypto.randomUUID();
  if (send('create', { difficulty, mode, solo, nickname: nickname(), autoFill: true }, requestId)) setBusy(true);
}
function joinRoom(code: string = $('roomCodeInput').value.trim()) {
  const clean = String(code).replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(clean)) { toast('输入六位数字的房间码就能入座'); return; }
  if (busy) return;
  if (send('join', { code: clean, nickname: nickname() })) setBusy(true);
}

function setMode(nextMode: GameMode) {
  if (!MODES[nextMode]) return;
  mode = nextMode;
  save(localStorage, 'ddz_mode', nextMode);
  $('modePicker').querySelectorAll<HTMLElement>('[data-mode]').forEach(button => {
    const chosen = button.dataset.mode === nextMode;
    button.classList.toggle('selected', chosen);
    button.setAttribute('aria-checked', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  });
}

function setDifficulty(level: Difficulty) {
  if (!DIFFICULTIES[level]) return;
  difficulty = level;
  save(localStorage, 'ddz_difficulty', level);
  $('difficultyPicker').querySelectorAll<HTMLElement>('[data-level]').forEach(button => {
    const chosen = button.dataset.level === level;
    button.classList.toggle('selected', chosen);
    button.setAttribute('aria-checked', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  });
}

function render({ dealing = false, drawn = [], action = null }: {dealing?: boolean; drawn?: CardId[]; action?: GameEvent | null} = {}) {
  if (!room || !me) return;
  $('landing').hidden = true;
  $('tableView').hidden = false;
  document.body.classList.add('in-table');
  const url = new URL(location.href);
  url.searchParams.set('room', room!.code);
  if (url.href !== location.href) history.replaceState(null, '', url.pathname + url.search);
  $('roomLabel').textContent = `${room!.code} · 好友牌桌`;
  $('tableDifficulty').textContent = `${room!.mode === 'laizi' ? '癞子 · ' : ''}${DIFFICULTIES[room!.difficulty].name}人机`;
  $('tableSurface').classList.toggle('is-playing', Boolean(game));
  $('waitingPanel').hidden = Boolean(game);
  for (const id of ['gameMetrics', 'bottomDeck', 'handWrap', 'tableUtilities', 'keyboardHint']) $(id).hidden = !game;
  for (const id of ['opponentLeft', 'opponentRight', 'selfPlayer', 'playLeft', 'playRight', 'playSelf']) $(id).hidden = !game;
  $('turnPrompt').hidden = !game;
  if (!game) {
    renderWaiting();
    $('actionBar').innerHTML = '';
    $('recorderPanel').hidden = true;
    $('reactionMenu').hidden = true;
    $('surrenderBanner').hidden = true;
  } else {
    renderPlayers();
    renderBottom(action);
    renderPlays(action);
    renderHand({ dealing, drawn });
    renderPrompt();
    renderActionBar();
    renderSurrenderBanner();
    $('baseScore').textContent = String(game!.highestBid || '—');
    if ($('multiplier').textContent !== String(game!.multiplier) && !motionReduced()) $('multiplier').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)', color: '#fff5bf' }, { transform: 'scale(1)' }], { duration: 500 });
    $('multiplier').textContent = String(game!.multiplier);
    if (game!.laiziRank !== null) {
      $('laiziBadge').hidden = false;
      $('laiziBadge').textContent = `癞子 ${rankLabel(game!.laiziRank)}`;
    } else {
      $('laiziBadge').hidden = true;
    }
    $('roundNumber').textContent = `第 ${room!.round} 局`;
    const isMyOpen = Boolean(game!.openSeats?.[me!.seat]);
    $('openHandButton').setAttribute('aria-pressed', String(isMyOpen));
    $('openHandButton').querySelector<HTMLElement>('span:last-child')!.textContent = isMyOpen ? '已明牌' : '明牌 ×2';
    $('openHandButton').disabled = isMyOpen || game!.phase === 'ended' || !online;
    const canSurrender = game!.phase === 'playing' && !room!.players[me!.seat]!.isBot && online;
    const pendingByMe = Boolean(game!.surrenderVote?.votes.includes(me!.seat));
    $('surrenderButton').disabled = !canSurrender || pendingByMe;
    $('surrenderButton').querySelector<HTMLElement>('span:last-child')!.textContent = pendingByMe ? '等队友确认' : '投降';
    $('autoButton').setAttribute('aria-pressed', String(room!.players[me!.seat]!.auto));
    $('autoButton').querySelector<HTMLElement>('span:last-child')!.textContent = String(room!.players[me!.seat]!.auto ? '收回' : '托管');
    $('autoButton').disabled = game!.phase === 'ended' || !online;
    if (!$('recorderPanel').hidden) renderRecorder();
    tickClock();
  }
  updateConnection();
}

function renderSurrenderBanner() {
  const vote = game?.surrenderVote;
  if (!game || !room || !me || !vote || game.phase !== 'playing') { $('surrenderBanner').hidden = true; return; }
  const isFarmer = me.seat !== game.landlordSeat;
  if (!isFarmer) { $('surrenderBanner').hidden = true; return; }
  const initiator = room.players[vote.initiator];
  const alreadyVoted = vote.votes.includes(me.seat);
  $('surrenderBanner').hidden = false;
  if (alreadyVoted) {
    $('surrenderBanner').innerHTML = `<span>已发起投降，等待队友确认…</span><button class="surrender-mini-btn" data-command="surrenderReject">取消</button>`;
  } else {
    $('surrenderBanner').innerHTML = `<span>队友 <b>${escapeHtml(initiator?.nickname || '农民')}</b> 请求投降</span><button class="surrender-mini-btn agree" data-command="surrenderAgree">同意投降</button><button class="surrender-mini-btn" data-command="surrenderReject">继续打</button>`;
  }
}

function renderWaiting() {
  const host = room!.hostId === me!.id;
  const seats = room!.players.map((player, seat) => {
    if (!player) return `<div class="seat-card empty-seat">${icon('user')}<b>给朋友留个座</b><small>分享房间码，等 TA 入座</small>${host ? `<button data-command="addBot" data-seat="${seat}">＋ 添加人机</button>` : ''}</div>`;
    const mine = player.id === me!.id;
    const ready = player.ready && player.connected;
    const status = !player.connected ? '暂时离线' : player.isBot ? `${DIFFICULTIES[player.level!].name}人机 · 已就位` : ready ? '✓ 准备好了' : '等待准备';
    return `<div class="seat-card ${mine ? 'is-me' : ''}"><span class="seat-tag">${mine ? '你' : player.id === room!.hostId ? '房主' : player.isBot ? 'AI' : '牌友'}</span><img src="assets/${player.avatar}.webp" alt=""><b title="${escapeHtml(player!.nickname)}">${escapeHtml(player!.nickname)}</b><div class="seat-status ${ready ? 'ready' : 'waiting'}">${status}</div>${player.isBot && host ? `<button class="seat-remove" data-command="removeBot" data-seat="${seat}">给朋友腾座</button>` : ''}</div>`;
  }).join('');
  const mine = room!.players[me!.seat];
  const blocked = room!.players.some(player => player && !player.isBot && (!player.ready || !player.connected));
  $('waitingPanel').innerHTML = `<h2>等待开始</h2><p class="waiting-subtitle">房间 <b>${room!.code}</b></p><div class="waiting-seats">${seats}</div><div class="room-settings"><div class="room-level-options"><span>玩法</span>${Object.entries(MODES).map(([m, value]) => `<button data-command="roomMode" data-mode="${m}" class="${room!.mode === m ? 'selected' : ''}" aria-pressed="${room!.mode === m}" ${!host ? 'disabled' : ''}>${value.name}</button>`).join('')}</div><div class="room-level-options"><span>人机难度</span>${Object.entries(DIFFICULTIES).map(([level, value]) => `<button data-command="roomLevel" data-level="${level}" class="${room!.difficulty === level ? 'selected' : ''}" aria-pressed="${room!.difficulty === level}" ${!host ? 'disabled' : ''}>${value.name}</button>`).join('')}</div><label class="auto-fill-label"><input type="checkbox" id="autoFill" ${room!.autoFill ? 'checked' : ''} ${!host ? 'disabled' : ''}>空位自动补人机</label></div><div class="waiting-actions"><button class="button button-outline" data-command="invite">${icon('copy')}复制邀请链接</button>${host ? `<button class="button button-gold" data-command="start" ${blocked || busy || !online ? 'disabled' : ''}>${icon('cards')}开始牌局</button>` : `<button class="button ${mine!.ready ? 'button-outline' : 'button-gold'}" data-command="ready" ${busy || !online ? 'disabled' : ''}>${mine!.ready ? '取消准备' : '准备好了'}</button>`}</div>`;
}

function relativeSeat(position: string) { return position === 'self' ? me!.seat : position === 'right' ? (me!.seat + 1) % 3 : (me!.seat + 2) % 3; }
function positionForSeat(seat: number) { return seat === me!.seat ? 'Self' : seat === (me!.seat + 1) % 3 ? 'Right' : 'Left'; }
function renderOpenHandStrip(cards: CardId[], side: string) {
  if (!cards.length) return '';
  const items = cards.map(id => {
    const info = cardInfo(id);
    if (!info) return '';
    const isLaizi = game?.laiziRank !== null && info.rank === game?.laiziRank;
    const cls = `${info.red ? 'red' : ''} ${info.rank >= 16 ? 'joker' : ''} ${isLaizi ? 'is-laizi' : ''}`;
    const symbol = info.suit === 'joker' ? '' : `<i>${info.symbol}</i>`;
    return `<span class="mini-card ${cls}" title="${info.suit === 'joker' ? info.label : info.symbol + info.label}">${symbol}<b>${info.label}</b></span>`;
  }).join('');
  return `<div class="open-hand-panel open-hand-${side}" aria-label="明牌手牌，共 ${cards.length} 张">${items}</div>`;
}
function renderPlayers() {
  if (!game || !room || !me) return;
  for (const [position, id] of [['left', 'opponentLeft'], ['right', 'opponentRight'], ['self', 'selfPlayer']]) {
    const seat = relativeSeat(position);
    const player = room!.players[seat];
    if (!player) continue;
    const landlord = game!.landlordSeat === seat;
    const isOpen = Boolean(game!.openSeats?.[seat]);
    const openCards = game!.openHands?.[seat] || null;
    const turn = game!.turn === seat && game!.phase !== 'ended';
    const status = !player.connected ? '离线 · 人机接管' : player.isBot ? `${DIFFICULTIES[player.level!].name}人机` : player.auto ? '正在托管' : seat === me!.seat ? '你的位置' : '在线';
    const reaction = reactions.get(seat);
    const bubble = reaction && reaction.expires > Date.now() ? `<div class="reaction-bubble">${escapeHtml(reaction.text)}</div>` : '';
    const avatar = `<div class="avatar-wrap ${turn ? 'is-turn' : ''}" data-clock-seat="${seat}"><img src="assets/${player.avatar}.webp" alt="">${landlord ? `<span class="avatar-crown">${icon('crown')}</span>` : ''}${turn ? '<span class="turn-time"></span>' : ''}</div>`;
    const openTag = isOpen ? '<span class="open-tag">明牌</span>' : '';
    const info = `<div class="player-info"><p class="player-name" title="${escapeHtml(player!.nickname)}">${escapeHtml(player!.nickname)}</p><span class="player-role ${landlord ? 'landlord' : ''}">${game!.phase === 'bidding' ? '等待叫分' : landlord ? '地主' : '农民'}${player.id === room!.hostId ? ' · 房主' : ''}</span>${openTag}<div class="player-state ${!player.connected ? 'offline' : ''}">${status}</div></div>`;
    const openStrip = position !== 'self' && openCards ? renderOpenHandStrip(openCards, position) : '';
    $(id).innerHTML = `${bubble}${avatar}${info}${position !== 'self' ? `<div class="cards-left ${game!.counts[seat] <= 2 ? 'danger' : ''}" aria-label="剩余 ${game!.counts[seat]} 张牌"><strong>${game!.counts[seat]}</strong></div>${openStrip}` : ''}`;
  }
}

function renderBottom(action: GameEvent | null) {
  const key = game!.bottom.length ? game!.bottom.join(',') : 'hidden';
  if ($('bottomCards').dataset.key !== key) {
    $('bottomCards').dataset.key = key;
    $('bottomCards').innerHTML = game!.bottom.length
      ? game!.bottom.map((id, index) => cardHtml(id, { index })).join('')
      : [0, 1, 2].map(index => cardHtml('' , { back: true, index })).join('');
    if (game!.bottom.length && action?.type === 'landlord') $('bottomCards').querySelectorAll<HTMLElement>('.card').forEach(card => card.classList.add('revealed'));
  }
  $('bottomCaption').textContent = game!.phase === 'bidding' ? '三张底牌，静候地主' : `${room!.players[game!.landlordSeat!]!.nickname}的底牌`;
}

function renderPlays(action: GameEvent | null) {
  for (const position of ['left', 'right', 'self']) {
    const seat = relativeSeat(position);
    const node = $(`play${position[0].toUpperCase() + position.slice(1)}`);
    const play = game!.tablePlays[seat];
    node.dataset.owner = room!.players[seat]!.nickname;
    let key;
    if (game!.phase === 'bidding') key = `bid:${game!.bids[seat]}`;
    else key = play?.cards ? play.cards.join(',') : play?.pass ? 'pass' : '';
    if (node.dataset.key === key) {
      node.querySelectorAll<HTMLElement>('.play-owner').forEach(owner => { owner.textContent = `${position === 'self' && play?.pass ? '你' : room!.players[seat]!.nickname} · `; });
      continue;
    }
    node.dataset.key = key;
    node.classList.remove('play-enter', 'long-play');
    if (game!.phase === 'bidding') {
      node.innerHTML = game!.bids[seat] >= 0 ? `<span class="bid-label">${game!.bids[seat] ? `${game!.bids[seat]} 分` : '不叫'}</span>` : '';
    } else if (play?.cards) {
      node.innerHTML = `<div class="play-label"><span class="play-owner">${escapeHtml(room!.players[seat]!.nickname)} · </span>${play.pattern.label}</div><div class="card-row">${play.cards.map((id, index) => cardHtml(id, { index })).join('')}</div>`;
      layoutPlayedRow(node, position);
      if (action?.type === 'play' && action.seat === seat) node.classList.add('play-enter');
    } else node.innerHTML = play?.pass ? `<span class="pass-label"><span class="play-owner">${position === 'self' ? '你' : escapeHtml(room!.players[seat]!.nickname)} · </span>不出</span>` : '';
  }
  updateLongPlayLayout();
}

function layoutPlayedRow(node: HTMLElement, position: string) {
  const cards = [...node.querySelectorAll<HTMLElement>('.card-row .card')];
  if (!cards.length) { node.classList.remove('long-play'); return; }
  const small = innerWidth <= 600 || innerHeight <= 630;
  const compact = innerWidth <= 600 && ['left', 'right'].some(side => (game!.tablePlays[relativeSeat(side)]?.cards?.length || 0) > 8);
  const split = !compact && position !== 'self' && cards.length > (small ? 8 : 12);
  const perRow = split ? 10 : cards.length;
  const batches = Array.from({ length: Math.ceil(cards.length / perRow) }, (_, index) => cards.slice(index * perRow, (index + 1) * perRow));
  let rows = [...node.querySelectorAll<HTMLElement>('.card-row')];
  if (rows.length !== batches.length || rows.some((row, index) => row.children.length !== batches[index].length)) {
    rows.forEach(row => row.remove());
    rows = batches.map(batch => {
      const row = document.createElement('div');
      row.className = 'card-row';
      batch.forEach(card => row.appendChild(card));
      node.appendChild(row);
      return row;
    });
  }
  node.classList.toggle('long-play', cards.length > (small ? 8 : 12));
  const available = $('tableSurface').clientWidth * (compact ? .9 : position === 'self' ? .82 : innerWidth <= 600 ? .38 : .27);
  const width = compact ? 28 : split ? small ? 30 : 42 : small ? 36 : 49;
  rows.forEach((row, index) => {
    const batch = batches[index];
    const step = batch.length > 1 ? Math.min(width * .58, (available - width) / (batch.length - 1)) : 0;
    row.style.width = `${width + (batch.length - 1) * step}px`;
    row.style.setProperty('--step', `${step}px`);
    row.style.setProperty('--card-w', `${width}px`);
    batch.forEach((card, cardIndex) => {
      card.style.setProperty('--index', String(cardIndex));
      card.style.setProperty('--card-w', `${width}px`);
    });
  });
}
function updateLongPlayLayout() {
  const left = $('playLeft').classList.contains('long-play');
  const right = $('playRight').classList.contains('long-play');
  $('tableSurface').classList.toggle('long-opponent', left || right);
  $('tableSurface').classList.toggle('long-left', left && !right);
  $('tableSurface').classList.toggle('both-opponents-long', left && right);
}

function arrangedHand() {
  const laiziRank = game!.laiziRank ?? null;
  if (sortMode === 'rank') return sortCards(game!.hand, laiziRank);
  let left = sortCards(game!.hand, laiziRank);
  const arranged: (string)[] = [];
  while (left.length) {
    const moves = legalPlays(left, null, laiziRank).sort((a, b) => b.cards.length - a.cards.length || b.pattern.rank - a.pattern.rank);
    const best = moves[0];
    if (!best) { arranged.push(...left); break; }
    arranged.push(...best.cards);
    left = left.filter(id => !best.cards.includes(id));
  }
  return arranged;
}
function canSelect() { return Boolean(online && game?.phase === 'playing' && !room!.players[me!.seat]!.auto); }
function renderHand({ dealing = false, drawn = [] }: {dealing?: boolean; drawn?: CardId[]} = {}) {
  const cards = arrangedHand();
  const key = `${room!.code}:${room!.round}:${game!.deal}:${sortMode}:${cards.join(',')}`;
  if (key !== handKey) {
    const focused = (document.activeElement as HTMLElement | null | undefined)?.dataset.card;
    handKey = key;
    $('hand').innerHTML = cards.map((id, index) => cardHtml(id, { interactive: true, index })).join('');
    $('hand').querySelectorAll<HTMLElement>('.card').forEach(card => {
      if (dealing) card.classList.add('dealing');
      else if (drawn.includes(card.dataset.card!!)) { card.classList.add('drawn'); card.style.setProperty('--draw-index', String(drawn.indexOf(card.dataset.card!!))); }
      card.addEventListener('animationend', () => card.classList.remove('dealing', 'drawn'), { once: true });
    });
    if (focused) $('hand').querySelector<HTMLElement>(`[data-card="${focused}"]`)?.focus({ preventScroll: true });
  }
  $('handLabel').textContent = `你的手牌 · ${game!.hand.length} 张`;
  $('sortLabel').textContent = String(sortMode === 'rank' ? '按牌型理牌' : '按点数理牌');
  layoutHand();
  updateSelection();
}
function layoutHand() {
  const cards = [...$('hand').querySelectorAll<HTMLElement>('.card')];
  if (!cards.length) { $('hand').style.width = '0px'; return; }
  const width = parseFloat(getComputedStyle($('hand')).getPropertyValue('--card-w')) || 82;
  const available = $('handWrap').clientWidth - 4;
  const step = cards.length > 1 ? Math.min(width * .66, (available - width) / (cards.length - 1)) : 0;
  const total = width + (cards.length - 1) * step;
  $('hand').style.width = `${total}px`;
  $('hand').style.setProperty('--step', `${step}px`);
  $('hand').classList.toggle('compact', cards.length >= 19);
  cards.forEach((card, index) => {
    card.style.setProperty('--card-w', `${width}px`);
    card.style.setProperty('--angle', `${(index - (cards.length - 1) / 2) * .22}deg`);
    card.style.setProperty('--deal-x', `${total / 2 - (index * step + width / 2)}px`);
  });
}
function currentLegalPlays() {
  if (!game) return [];
  const key = `${room!.code}:${room!.round}:${game!.deal}:${game!.seq}`;
  if (legalCacheKey !== key) { legalCacheKey = key; legalCache = legalPlays(game!.hand, game!.trick?.pattern, game!.laiziRank ?? null); }
  return legalCache;
}
function updateSelection() {
  if (!game || !me || !room) return;
  $('hand').classList.toggle('can-select', canSelect());
  $('hand').querySelectorAll<HTMLElement>('.card').forEach(card => {
    const chosen = selected.has(card.dataset.card!!);
    card.classList.toggle('selected', chosen);
    card.setAttribute('aria-pressed', String(chosen));
    card.setAttribute('aria-disabled', String(!canSelect()));
  });
  const value = classify([...selected], game!.laiziRank ?? null, game!.trick?.pattern);
  $('selectedLabel').textContent = selected.size ? value
    ? `${value.label} · ${selected.size} 张${game!.turn === me!.seat && !canBeat(value, game!.trick?.pattern) ? ' · 压不过上一手' : ''}`
    : `已选 ${selected.size} 张 · 还没组成牌型` : '';
  const playButton = $('actionBar').querySelector<HTMLElement>('[data-command="play"]');
  if (playButton) (playButton as HTMLButtonElement).disabled = !online || game!.turn !== me!.seat || !canBeat(value, game!.trick?.pattern);
}
function toggleCard(id: CardId, chosen = !selected.has(id)) {
  if (!canSelect()) return;
  if (chosen) selected.add(id); else selected.delete(id);
  updateSelection();
}

function renderPrompt() {
  const mine = game!.turn === me!.seat;
  const player = room!.players[game!.turn!];
  $('turnPrompt').classList.toggle('my-turn', mine);
  let html = '';
  if (game!.phase === 'bidding') html = mine ? '<span class="prompt-dot"></span>轮到你叫地主<small>3 分直接拿底牌</small>' : `${escapeHtml(player!.nickname)}正在叫分`;
  else if (game!.phase === 'ended') {
    const surrenderText = game!.surrenderBy !== null ? ` · ${escapeHtml(room!.players[game!.surrenderBy]?.nickname || '玩家')}投降` : '';
    html = `${game!.winnerSide === 'landlord' ? '地主' : '农民'}获胜${surrenderText}${game!.spring ? ' · 春天，倍率翻倍' : ''}`;
  }
  else if (room!.players[me!.seat]!.auto) html = '让人机替你想一会儿<small>随时可以收回托管</small>';
  else if (mine) html = game!.trick ? `<span class="prompt-dot"></span>轮到你了<small>接 ${game!.trick.pattern.label}，或不出</small>` : '<span class="prompt-dot"></span>轮到你领出<small>选好牌，出手吧</small>';
  else html = `等待${escapeHtml(player!.nickname)}出牌`;
  $('turnPrompt').innerHTML = html;
  $('liveAnnouncements').textContent = $('turnPrompt').textContent;
}

function renderActionBar() {
  if (!game || !room) return;
  const mine = game!.turn === me!.seat;
  const automated = room!.players[me!.seat]!.auto;
  if (game!.phase === 'ended') {
    $('actionBar').innerHTML = `<button class="button button-outline" data-command="result">查看结算</button><button class="button button-gold" data-command="rematch" ${room!.players[me!.seat]!.rematchReady || !online ? 'disabled' : ''}>${room!.players[me!.seat]!.rematchReady ? '等待牌友…' : '再来一局'}</button>`;
    return;
  }
  if (automated) {
    $('actionBar').innerHTML = `<button class="button auto-return" data-command="auto" ${!online ? 'disabled' : ''}>${icon('robot')}收回托管，自己来</button>`;
    return;
  }
  if (game!.phase === 'bidding') {
    $('actionBar').innerHTML = [0, 1, 2, 3].map(score => `<button class="button bid-button ${score === 3 ? 'button-gold' : 'button-outline'}" data-command="bid" data-score="${score}" ${!mine || !online || score > 0 && score <= game!.highestBid ? 'disabled' : ''}>${score ? `${score} 分` : '不叫'}</button>`).join('');
    return;
  }
  const noBeat = !currentLegalPlays().length;
  const value = classify([...selected], game!.laiziRank ?? null, game!.trick?.pattern);
  $('actionBar').innerHTML = `<button class="button button-outline" data-command="pass" ${!mine || !game!.trick || !online ? 'disabled' : ''}>不出</button><button class="button button-soft" data-command="hint" ${!mine || noBeat || !online ? 'disabled' : ''}>${noBeat && mine ? '无牌可压' : '提示'}</button><button class="button button-gold play-button" data-command="play" ${!mine || !online || !canBeat(value, game!.trick?.pattern) ? 'disabled' : ''}>出牌 ${icon('arrow')}</button>`;
}

function hint() {
  if (!game || game!.turn !== me!.seat) return;
  const key = `${room!.code}:${room!.round}:${game!.deal}:${game!.seq}`;
  if (hintKey !== key) { hintKey = key; hintMoves = suggestedPlays({ ...game, seat: me!.seat }, 130); hintIndex = 0; }
  if (!hintMoves.length) { toast('这一手没有能压过的牌，可以选择不出'); return; }
  const move = hintMoves[hintIndex % hintMoves.length];
  hintIndex++;
  selected = new Set(move.cards);
  updateSelection();
  sounds.play('select');
}
function playSelected() {
  if (!game || game!.phase !== 'playing' || game!.turn !== me!.seat) return;
  const value = classify([...selected], game!.laiziRank ?? null, game!.trick?.pattern);
  if (!canBeat(value, game!.trick?.pattern)) {
    toast(!selected.size ? '先选一手牌吧' : value ? '这手牌压不过上一手' : '这些牌还没有组成有效牌型');
    $('hand').classList.remove('shake');
    void $('hand').offsetWidth;
    $('hand').classList.add('shake');
    return;
  }
  send('action', { type: 'play', cards: [...selected] });
}

function tickClock() {
  if (!game?.deadline || game!.phase === 'ended') return;
  const remaining = Math.max(0, game!.deadline - Date.now() - serverOffset);
  const seconds = Math.ceil(remaining / 1000);
  const duration = game!.phase === 'bidding' ? 15000 : 30000;
  document.querySelectorAll<HTMLElement>('[data-clock-seat]').forEach(avatar => {
    if (Number(avatar.dataset.clockSeat) !== game!.turn) return;
    avatar.style.setProperty('--clock-angle', `${Math.min(360, remaining / duration * 360)}deg`);
    const clock = avatar.querySelector<HTMLElement>('.turn-time');
    if (clock && clock.textContent !== String(seconds)) { clock.textContent = String(seconds); clock.setAttribute('aria-label', `剩余 ${seconds} 秒`); }
  });
}

function renderRecorder() {
  if (!game) return;
  const seen = new Set([...game!.hand, ...game!.playedCards.flat()]);
  for (const open of game!.openHands || []) if (open) for (const id of open) seen.add(id);
  const counts = rankGroups(DECK.filter(id => !seen.has(id)));
  const hasOpen = (game!.openSeats || []).some((flag, seat) => flag && seat !== me?.seat);
  const title = hasOpen ? '未亮明余牌' : '场外余牌';
  $('recorderPanel').innerHTML = `<div class="recorder-head"><span>${title}</span><button data-command="recorder" aria-label="收起记牌器">×</button></div><div class="recorder-ranks">${Array.from({ length: 15 }, (_, index) => 17 - index).map(rank => `<span class="recorder-rank ${!counts.has(rank) ? 'exhausted' : ''} ${game!.laiziRank === rank ? 'is-laizi' : ''}"><b class="${rank >= 16 ? 'king-label' : ''}">${RANK_LABELS[rank] || rank}</b><small>${counts.get(rank)?.length || 0}</small></span>`).join('')}</div>`;
}

function renderResult() {
  if (game?.phase !== 'ended') return;
  const won = game!.scores![me!.seat] > 0;
  const detailsOpen = $('resultDialog').querySelector<HTMLDetailsElement>('details')?.open;
  const host = room!.hostId === me!.id;
  $('resultDialog').classList.toggle('lost', !won);
  const openCount = (game!.openSeats || []).filter(Boolean).length;
  const surrenderTag = game!.surrenderBy !== null ? `<span class="spring-tag">${escapeHtml(room!.players[game!.surrenderBy]?.nickname || '玩家')}投降</span>` : '';
  const openTag = openCount ? `<span class="spring-tag">明牌 ×${2 ** openCount}</span>` : '';
  const laiziTag = game!.laiziRank !== null ? `<span class="spring-tag">癞子 ${rankLabel(game!.laiziRank)}</span>` : '';
  const rows = room!.players.map((player, seat) => `<div class="result-player"><img src="assets/${player!.avatar}.webp" alt=""><span class="result-player-name"><b>${escapeHtml(player!.nickname)}${seat === me!.seat ? ' · 你' : ''}</b><small>${seat === game!.landlordSeat ? '地主' : '农民'}${game!.openSeats?.[seat] ? ' · 明牌' : ''}${game!.scores![seat] > 0 ? ' · 胜利' : ''}</small></span>${player!.rematchReady && !player!.isBot ? '<span class="result-ready">已准备</span>' : ''}<span class="result-score ${game!.scores![seat] > 0 ? 'won' : ''}">${game!.scores![seat] > 0 ? '+' : ''}${game!.scores![seat]}</span></div>`).join('');
  $('resultDialog').innerHTML = `<button class="modal-close" data-command="closeDialog" aria-label="收起结算">×</button><div class="result-seal">${icon(won ? 'crown' : 'cards')}</div><h2>${game!.winnerSide === 'landlord' ? '地主胜利' : '农民胜利'}</h2><p class="result-summary">底分 ${game!.highestBid} × 倍数 ${game!.multiplier}${laiziTag}${openTag}${game!.spring ? '<span class="spring-tag">春天 ×2</span>' : ''}${surrenderTag}</p><div class="result-players">${rows}</div><div class="result-actions"><button class="button button-gold" data-command="rematch" ${room!.players[me!.seat]!.rematchReady || !online ? 'disabled' : ''}>${room!.players[me!.seat]!.rematchReady ? '等牌友准备…' : '再来一局'}</button><button class="button button-outline" data-command="${host ? 'lobby' : 'leave'}">${host ? '回到房间' : '离开牌桌'}</button></div><details class="remaining-hands" ${detailsOpen ? 'open' : ''}><summary>剩余手牌</summary>${room!.players.map((player, seat) => `<p><b>${escapeHtml(player!.nickname)}</b>　${game!.revealedHands![seat].length ? game!.revealedHands![seat].map(id => { const card = cardInfo(id); return `${card!.suit === 'joker' ? '' : card!.symbol}${card!.label}`; }).join('　') : '已全部出完'}</p>`).join('')}</details><div class="result-footer"><span>第 ${room!.round} 局 · 房间 ${room!.code}</span><button data-command="rules">积分规则</button></div>`;
}

function captureOrigins(action: Extract<GameEvent, {type: "play"}>, incomingMe: {id: string; seat: number}) {
  const origins = new Map<string, DOMRect>();
  if (action.seat === incomingMe.seat) {
    for (const id of action.cards) { const node = $('hand').querySelector<HTMLElement>(`[data-card="${id}"]`); if (node) origins.set(id, node.getBoundingClientRect()); }
  } else {
    const node = action.seat === (incomingMe.seat + 1) % 3 ? $('opponentRight') : $('opponentLeft');
    const rect = node.querySelector<HTMLElement>('.cards-left')?.getBoundingClientRect() || node.getBoundingClientRect();
    for (const id of action.cards) origins.set(id, rect);
  }
  return origins;
}
function animatePlay(action: Extract<GameEvent, {type: "play"}>, origins: Map<string, DOMRect> | null) {
  if (motionReduced() || !origins) return;
  requestAnimationFrame(() => {
    const target = $(`play${positionForSeat(action.seat)}`);
    action.cards.forEach((id, index) => {
      const source = origins.get(id);
      const destination = target.querySelector<HTMLElement>(`[data-card="${id}"]`);
      if (!source || !destination) return;
      const end = destination.getBoundingClientRect();
      const wrapper = document.createElement('div');
      wrapper.innerHTML = cardHtml(id);
      const flying = wrapper.firstElementChild;
      flying!.classList.add('flying-card');
      flying!.setAttribute('aria-hidden', 'true');
      Object.assign((flying! as HTMLElement).style, { left: `${source.left}px`, top: `${source.top}px`, width: `${source.width}px`, height: `${source.height}px` });
      document.body.appendChild(flying!);
      destination.style.visibility = 'hidden';
      const animation = flying!.animate([
        { transform: 'translate(0, 0) rotate(-3deg) scale(1)', opacity: .95 },
        { transform: `translate(${end.left - source.left}px, ${end.top - source.top}px) rotate(0deg) scale(${end.width / source.width}, ${end.height / source.height})`, opacity: 1 }
      ], { duration: 420, delay: index * 12, easing: 'cubic-bezier(.2,.65,.2,1)', fill: 'forwards' });
      animation.finished.catch(() => {}).then(() => { flying!.remove(); destination.style.visibility = ''; });
    });
  });
}

const comboNames: Record<string, [string, string, string]> = {
  bomb: ['炸弹', 'DOUBLE THE STAKES', 'bomb'], rocket: ['王炸', 'THE ULTIMATE HAND', 'rocket'],
  straight: ['顺子', 'SMOOTH AS EVER', 'wind'], pairStraight: ['连对', 'ONE AFTER ANOTHER', 'cards'],
  airplane: ['飞机', 'CLEARED FOR TAKEOFF', 'plane'], airplaneSingle: ['飞机', 'CLEARED FOR TAKEOFF', 'plane'],
  airplanePair: ['飞机', 'CLEARED FOR TAKEOFF', 'plane'], spring: ['春天', 'A PERFECT HAND', 'flower']
};
function showCombo(type: string) {
  const values = comboNames[type];
  if (!values || motionReduced()) return;
  const large = ['bomb', 'rocket', 'spring'].includes(type);
  const node = document.createElement('div');
  node.className = `combo-effect ${large ? 'bomb-effect' : 'small-combo'}`;
  node.innerHTML = `${icon(values[2])}<strong>${values[0]}</strong><small>${values[1]}</small>`;
  $('effectLayer').appendChild(node);
  if (large) {
    $('tableSurface').classList.remove('impact');
    void $('tableSurface').offsetWidth;
    $('tableSurface').classList.add('impact');
    particleBurst(type === 'spring' ? 'victory' : 'impact');
  }
  setTimeout(() => node.remove(), 1700);
}

let particleFrame: number | null = null;
let particles: Particle[] = [];
function particleBurst(kind: string) {
  if (motionReduced()) return;
  const canvas = $('particlesCanvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== innerWidth * dpr || canvas.height !== innerHeight * dpr) { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; }
  const context = canvas.getContext('2d');
  context!.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rect = $('tableSurface').getBoundingClientRect();
  const start = performance.now();
  const victory = kind === 'victory';
  for (let i = 0; i < (victory ? 90 : 50); i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 6;
    particles.push({ x: innerWidth / 2, y: rect.top + rect.height * .4, vx: Math.cos(angle) * speed, vy: victory ? -3 - Math.random() * 6 : Math.sin(angle) * speed, born: start, life: victory ? 2600 + Math.random() * 800 : 800 + Math.random() * 400, angle, spin: (Math.random() - .5) * .14, width: victory ? 3 + Math.random() * 5 : 2 + Math.random() * 3, color: ['#edcd8c', '#c0d4a2', '#b74735', '#f6e6ba'][i % 4], gravity: victory ? .07 : .018 });
  }
  particles = particles.slice(-200);
  if (particleFrame) return;
  let previous = start;
  function frame(now: number) {
    const delta = Math.min((now - previous) / 16.67, 2);
    previous = now;
    context!.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter(particle => now - particle.born < particle.life);
    for (const particle of particles) {
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.vy += particle.gravity * delta;
      particle.angle += particle.spin * delta;
      context!.save();
      context!.translate(particle.x, particle.y);
      context!.rotate(particle.angle);
      context!.globalAlpha = Math.min(1, (particle.life - now + particle.born) / 500);
      context!.fillStyle = particle.color;
      context!.fillRect(-particle.width / 2, -particle.width, particle.width, particle.width * 1.65);
      context!.restore();
    }
    particleFrame = particles.length ? requestAnimationFrame(frame) : null;
  }
  particleFrame = requestAnimationFrame(frame);
}

const sounds = {
  context: null as AudioContext | null,
  unlock() {
    if (!soundOn) return;
    try {
      this.context ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch {}
  },
  tone(frequency: number, duration = .08, delay = 0, volume = .025, kind: OscillatorType = 'sine') {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind;
    oscillator.frequency.value = frequency;
    const start = context.currentTime + delay;
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + .02);
  },
  paper(delay = 0, length = .06) {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * length), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = 'highpass'; filter.frequency.value = 1900;
    gain.gain.value = .023;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(context.currentTime + delay);
  },
  play(type: string) {
    if (!soundOn) return;
    this.unlock();
    if (type === 'deal') for (let i = 0; i < 7; i++) this.paper(i * .09);
    else if (type === 'card') { this.paper(); this.tone(340, .06, .02, .015); }
    else if (type === 'select') this.tone(520, .045, 0, .01);
    else if (type === 'pass') this.tone(240, .06, 0, .008);
    else if (type === 'reveal') [440, 554, 659].forEach((note, i) => this.tone(note, .12, i * .07, .018));
    else if (type === 'bomb') { this.tone(78, .3, 0, .08, 'triangle'); this.paper(.03, .15); }
    else if (type === 'rocket') [330, 660, 990, 1320].forEach((note, i) => this.tone(note, .16, i * .08, .02, 'triangle'));
    else if (type === 'warning') { this.tone(660, .07, 0, .014); this.tone(660, .07, .14, .014); }
    else if (type === 'win') [262, 330, 392, 523, 659, 784].forEach((note, i) => this.tone(note, .28, i * .1, .026, 'triangle'));
    else if (type === 'lose') { this.tone(294, .3, 0, .015); this.tone(220, .4, .2, .015); }
  }
};
function renderSound() {
  $('soundButton').innerHTML = icon(soundOn ? 'sound' : 'muted');
  $('soundButton').setAttribute('aria-label', String(soundOn ? '关闭音效' : '开启音效'));
  $('soundButton').setAttribute('aria-pressed', String(soundOn));
}

async function copy(value: string, message: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea');
      input.value = value;
      Object.assign(input.style, { position: 'fixed', left: '-9999px', top: '0' });
      document.body.appendChild(input); input.select();
      const success = document.execCommand('copy'); input.remove();
      if (!success) throw new Error('Copy unavailable');
    }
    toast(message);
  } catch { toast(`复制暂时不可用，房间码是 ${room!.code}`); }
}
function inviteLink() { const url = new URL('./', location.href); url.searchParams.set('room', room!.code); return url.href; }
function openLeave() {
  if (!room) return;
  if ($('resultDialog').open) $('resultDialog').close();
  $('leaveExplanation').textContent = String(game && game!.phase !== 'ended' ? '离开后，这一局会由人机接着打。其他牌友的牌局会继续。' : '离开后，房间会保留给仍在座的牌友。');
  if (!$('leaveDialog').open) $('leaveDialog').showModal();
}
function openSurrender() {
  if (!room || !game || !me || game.phase !== 'playing') return;
  const isLandlord = me.seat === game.landlordSeat;
  const teammateSeat = !isLandlord ? [0, 1, 2].find(index => index !== game!.landlordSeat && index !== me!.seat) : undefined;
  const teammate = teammateSeat !== undefined ? room.players[teammateSeat] : null;
  const needTeammate = Boolean(!isLandlord && teammate && !teammate.isBot);
  $('surrenderExplanation').textContent = needTeammate
    ? `当前你和 ${teammate!.nickname} 都是真人农民，发起投降后需要队友同意才会结束本局。`
    : '投降后会立即判对方获胜，并按当前底分和倍数结算本局。';
  if (!$('surrenderDialog').open) $('surrenderDialog').showModal();
}

document.addEventListener('click', async event => {
  const button = (event.target! as Element).closest<HTMLButtonElement>('[data-command]');
  if (!button || button.disabled) return;
  const command = button.dataset.command;
  sounds.unlock();
  switch (command) {
    case 'solo': createRoom(true); break;
    case 'create': createRoom(false); break;
    case 'rules': if (!$('rulesDialog').open) $('rulesDialog').showModal(); break;
    case 'closeDialog': button.closest('dialog')?.close(); break;
    case 'sound': soundOn = !soundOn; save(localStorage, 'ddz_sound', String(soundOn)); renderSound(); if (soundOn) sounds.play('select'); break;
    case 'fullscreen': try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast('当前浏览器没有开放全屏，可以直接继续玩'); } break;
    case 'copyCode': if (room) copy(room!.code, '房间码已复制'); break;
    case 'invite': if (room) copy(inviteLink(), '邀请链接已复制，发给朋友就能入座'); break;
    case 'start': send('start'); break;
    case 'ready': send('ready', { ready: !room!.players[me!.seat]!.ready }); break;
    case 'roomLevel': send('settings', { difficulty: button.dataset.level as Difficulty }); break;
    case 'roomMode': send('settings', { mode: button.dataset.mode as GameMode }); break;
    case 'addBot': send('bot', { seat: Number(button.dataset.seat), enabled: true }); break;
    case 'removeBot': send('bot', { seat: Number(button.dataset.seat), enabled: false }); break;
    case 'bid': send('action', { type: 'bid', score: Number(button.dataset.score) }); break;
    case 'play': playSelected(); break;
    case 'pass': send('action', { type: 'pass' }); break;
    case 'openHand': if (room && game) send('openHand'); break;
    case 'surrender': openSurrender(); break;
    case 'confirmSurrender': if (send('surrender', { decision: 'request' })) $('surrenderDialog').close(); break;
    case 'surrenderAgree': send('surrender', { decision: 'agree' }); break;
    case 'surrenderReject': send('surrender', { decision: 'reject' }); break;
    case 'hint': hint(); break;
    case 'sort': if (game) { sortMode = sortMode === 'rank' ? 'groups' : 'rank'; renderHand(); sounds.play('paper'); } break;
    case 'auto': if (room && game) send('auto', { enabled: !room!.players[me!.seat]!.auto }); break;
    case 'recorder': $('recorderPanel').hidden = !$('recorderPanel').hidden; $('recorderButton').setAttribute('aria-expanded', String(!$('recorderPanel').hidden)); if (!$('recorderPanel').hidden) renderRecorder(); break;
    case 'chat': $('reactionMenu').hidden = !$('reactionMenu').hidden; $('chatButton').setAttribute('aria-expanded', String(!$('reactionMenu').hidden)); break;
    case 'reaction': send('reaction', { key: button.dataset.key as ReactionKey }); $('reactionMenu').hidden = true; $('chatButton').setAttribute('aria-expanded', 'false'); break;
    case 'result': renderResult(); if (!$('resultDialog').open) $('resultDialog').showModal(); break;
    case 'rematch': send('rematch'); break;
    case 'lobby': send('lobby'); if ($('resultDialog').open) $('resultDialog').close(); break;
    case 'leave': openLeave(); break;
    case 'confirmLeave': if (send('leave')) { $('leaveDialog').close(); setBusy(true); } break;
    case 'reconnect': superseded = false; ws?.close(); ws = null; reconnectAttempts = 0; connect(); break;
  }
});
$('modePicker').addEventListener('click', event => { const button = (event.target! as Element).closest<HTMLElement>('[data-mode]'); if (button) { setMode(button.dataset.mode as GameMode); sounds.play('select'); } });
$('modePicker').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  setMode(mode === 'classic' ? 'laizi' : 'classic');
  $('modePicker').querySelector<HTMLElement>(`[data-mode="${mode}"]`)!.focus();
});
$('difficultyPicker').addEventListener('click', event => { const button = (event.target! as Element).closest<HTMLElement>('[data-level]'); if (button) { setDifficulty(button.dataset.level as Difficulty); sounds.play('select'); } });
$('difficultyPicker').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const levels = Object.keys(DIFFICULTIES) as Difficulty[];
  const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
  setDifficulty(levels[(levels.indexOf(difficulty) + delta + 3) % 3]);
  $('difficultyPicker').querySelector<HTMLElement>(`[data-level="${difficulty}"]`)!.focus();
});
$('joinForm').addEventListener('submit', event => { event.preventDefault(); sounds.unlock(); joinRoom(); });
$('roomCodeInput').addEventListener('input', () => { $('roomCodeInput').value = $('roomCodeInput').value.replace(/\D/g, '').slice(0, 6); });
$('nickname').addEventListener('change', () => { save(localStorage, 'ddz_nickname', $('nickname').value); if (online) send('nickname', { nickname: $('nickname').value }); });
$('waitingPanel').addEventListener('change', event => { if ((event.target! as Element).id === 'autoFill') send('settings', { autoFill: (event.target! as HTMLInputElement).checked }); });

$('hand').addEventListener('pointerdown', event => {
  const card = (event.target! as Element).closest<HTMLElement>('[data-card]');
  if (!card || !canSelect() || event.button !== 0) return;
  event.preventDefault();
  sounds.unlock();
  drag = { pointerId: event.pointerId, chosen: !selected.has(card.dataset.card!), visited: new Set(), previous: Number(card.style.getPropertyValue('--index')) };
  $('hand').setPointerCapture(event.pointerId);
  drag!.visited.add(card.dataset.card!);
  toggleCard(card.dataset.card!, drag!.chosen);
  sounds.play('select');
  lastPointerSelection = Date.now();
});
$('hand').addEventListener('pointermove', event => {
  if (!drag || drag.pointerId !== event.pointerId || !canSelect()) return;
  const rect = $('hand').getBoundingClientRect();
  if (event.clientY < rect.top - 55 || event.clientY > rect.bottom + 30) return;
  const cards = [...$('hand').querySelectorAll<HTMLElement>('.card')];
  const step = parseFloat($('hand').style.getPropertyValue('--step')) || 1;
  const index = Math.max(0, Math.min(cards.length - 1, Math.floor((event.clientX - rect.left) / step)));
  for (let i = Math.min(index, drag.previous); i <= Math.max(index, drag.previous); i++) {
    const id = cards[i]?.dataset.card;
    if (id && !drag.visited.has(id)) { drag.visited.add(id); toggleCard(id, drag.chosen); }
  }
  drag.previous = index;
  lastPointerSelection = Date.now();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('hand').addEventListener(event, () => { drag = null; lastPointerSelection = Date.now(); });
$('hand').addEventListener('click', event => {
  const card = (event.target! as Element).closest<HTMLElement>('[data-card]');
  if (card && (!event.detail || Date.now() - lastPointerSelection > 300)) { toggleCard(card.dataset.card!); sounds.play('select'); }
});
$('hand').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const cards = [...$('hand').querySelectorAll<HTMLElement>('.card')];
  const current = cards.indexOf(document.activeElement! as HTMLElement);
  if (current < 0) return;
  event.preventDefault();
  const index = Math.max(0, Math.min(cards.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
  cards[index].focus({ preventScroll: true });
});
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || (event.target! as Element).closest('input, textarea, select, dialog')) return;
  if (!game || game!.phase !== 'playing' || !online || room!.players[me!.seat]!.auto) return;
  if (event.key === 'Escape') { selected.clear(); updateSelection(); return; }
  if ((event.target! as Element).closest('button, a, summary')) return;
  if (event.key.toLowerCase() === 'h' && game!.turn === me!.seat) { event.preventDefault(); hint(); }
  else if (event.key === 'Enter' && game!.turn === me!.seat) { event.preventDefault(); playSelected(); }
  else if (event.key === ' ' && game!.turn === me!.seat && game!.trick) { event.preventDefault(); send('action', { type: 'pass' }); }
});
document.addEventListener('pointerdown', event => {
  if (!(event.target! as Element).closest('#recorderPanel, #recorderButton')) { $('recorderPanel').hidden = true; $('recorderButton').setAttribute('aria-expanded', 'false'); }
  if (!(event.target! as Element).closest('#reactionMenu, #chatButton')) { $('reactionMenu').hidden = true; $('chatButton').setAttribute('aria-expanded', 'false'); }
});
document.querySelector<HTMLElement>('.brand')!.addEventListener('click', event => { if (room) { event.preventDefault(); openLeave(); } });
window.addEventListener('resize', () => { if (game) { layoutHand(); for (const position of ['Left', 'Right', 'Self']) layoutPlayedRow($(`play${position}`), position.toLowerCase()); updateLongPlayLayout(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (online) send('sync'); else connect(); } });
window.addEventListener('online', connect);
setInterval(tickClock, 200);
setInterval(() => { if (online && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);

const reactionEntries = [['hello', '👋', '牌友好呀'], ['nice', '✨', '这手漂亮'], ['thinking', '🤔', '让我想想'], ['wow', '🦊', '好家伙！'], ['hurry', '⏳', '轮到你啦'], ['gg', '🤝', '打得不错']];
$('reactionMenu').innerHTML = reactionEntries.map(([key, symbol, label]) => `<button data-command="reaction" data-key="${key}">${symbol} ${label}</button>`).join('');
window.accountUI?.onChange(user => {
  const previous = account;
  account = user;
  if (user) { $('nickname').value = user.nickname; $('nickname').readOnly = true; }
  else { $('nickname').readOnly = false; }
  if (user && user.id !== previous?.id) {
    // 重新握手读取新 Cookie，用当前标签页 token 接回同一张牌桌。
    const previousSocket = ws;
    ws = null;
    online = false;
    previousSocket?.close();
    superseded = false;
    connect();
  } else if (!user && previous && online) send('detachAccount');
});
setMode(mode);
setDifficulty(difficulty);
renderSound();
connect();
