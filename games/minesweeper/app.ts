import { DIFFICULTIES, neighbors } from './engine.ts';
import type { AccountUser, CellView, Difficulty, GameAction, GameMode, GameResult, GameStats, SessionResponse, SessionView, StartInput, StatusResponse, StepInput, ToolMode } from './types.ts';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing game element: ${id}`);
  return node as T;
}

const icons: Record<string, string> = {
  back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  leaf: '<path d="M20 4c-8-2-16 2-16 9a7 7 0 0 0 7 7c7 0 11-8 9-16Z"/><path d="m4 21 12-12M9 16v-5m4 1h5"/>',
  trees: '<path d="m8 3-5 7h3l-4 6h12l-4-6h3L8 3Zm0 13v5m8-15-3 5h2l-3 6h9l-3-6h2l-4-5Zm0 11v4"/>',
  mountain: '<path d="m2 20 8-15 5 9 3-5 5 11H2Zm5-9 3 2 2-2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/><circle cx="12" cy="12" r="1"/>',
  flag: '<path d="M5 21V3m0 1h13l-3 4 3 4H5M2 21h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  footprints: '<ellipse cx="7" cy="7" rx="3" ry="5" transform="rotate(-20 7 7)"/><ellipse cx="16" cy="15" rx="3" ry="5" transform="rotate(20 16 15)"/><path d="m6 15 2 1m7-12 2-1"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  restart: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6"/>',
  expand: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  pointer: '<path d="m5 3 14 10-7 1-3 7L5 3Zm7 11 4 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-5 8-8 10-3-2-8-5-8-10V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  notebook: '<path d="M6 3h13v18H6V3Zm-3 3h5M3 10h5m-5 4h5m-5 4h5m4-11h4m-4 4h4"/>',
  trophy: '<path d="M7 3h10v6a5 5 0 0 1-10 0V3Zm0 2H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4M12 14v5m-4 2h8"/>',
  book: '<path d="M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sound: '<path d="m3 9 4 0 5-5v16l-5-5H3V9Zm13-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/>',
  soundOff: '<path d="m3 9 4 0 5-5v16l-5-5H3V9Zm13 0 6 6m-6 0 6-6"/>',
  mine: '<circle cx="12" cy="12" r="5"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2m10-10 2-2"/>',
  wrongflag: '<path d="M5 21V3m0 1h13l-3 4 3 4H5m8 4 7 7m0-7-7 7"/>',
};
function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.leaf}</svg>`;
}
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon || 'leaf'); });

const params = new URLSearchParams(location.search);
const initialDifficulty = params.get('difficulty');
const state = {
  difficulty: (initialDifficulty && Object.hasOwn(DIFFICULTIES, initialDifficulty) ? initialDifficulty : 'easy') as Difficulty,
  mode: (params.get('mode') === 'daily' ? 'daily' : 'classic') as GameMode,
  tool: 'reveal' as ToolMode,
  session: null as SessionView | null,
  stats: null as GameStats | null,
  user: (window.accountUI?.getUser() ?? null) as AccountUser | null,
  date: '', connected: false, loading: true, busy: false,
};
const board = element('board');
const boardScroll = element('boardScroll');
let cells: HTMLButtonElement[] = [];
let renderedSession = '';
let focusIndex = 0;
let epoch = 0;
let syncing = false;
let draining = false;
let clockBase = 0;
let clockAnchor = performance.now();
let toastTimer = 0;
let pendingStart: { difficulty: Difficulty; mode: GameMode } | null = null;
let announcedResult = '';
let storageAvailable = true;
let audio: AudioContext | null = null;
let soundEnabled = false;
try { soundEnabled = localStorage.getItem('yg-mine-sound') === 'on'; } catch { /* Sound remains opt-in. */ }

interface PendingAction { action: GameAction; sessionId: string; epoch: number; input?: StepInput; }
const queue: PendingAction[] = [];
let retryAction: PendingAction | null = null;
interface LocalBook extends GameStats { seen: string[]; }

function emptyBook(): LocalBook { return { games: 0, wins: 0, bestTimes: { classic: {}, daily: {} }, seen: [] }; }
function bookKey(accountId: number | null): string { return `yg-minesweeper-book-v1:${accountId ?? 'guest'}`; }
function readBook(accountId: number | null): LocalBook {
  const book = emptyBook();
  try {
    const saved = JSON.parse(localStorage.getItem(bookKey(accountId)) || 'null') as Partial<LocalBook> | null;
    if (!saved || typeof saved !== 'object') return book;
    book.games = Number.isFinite(saved.games) ? Math.max(0, Math.floor(saved.games!)) : 0;
    book.wins = Number.isFinite(saved.wins) ? Math.min(book.games, Math.max(0, Math.floor(saved.wins!))) : 0;
    book.seen = Array.isArray(saved.seen) ? saved.seen.filter((id): id is string => typeof id === 'string').slice(-100) : [];
    for (const mode of ['classic', 'daily'] as const) {
      for (const difficulty of ['easy', 'normal', 'hard'] as const) {
        const best = saved.bestTimes?.[mode]?.[difficulty];
        if (typeof best === 'number' && Number.isFinite(best) && best >= 0) book.bestTimes[mode][difficulty] = best;
      }
    }
  } catch { storageAvailable = false; }
  return book;
}
function recordLocal(result: GameResult): boolean {
  const book = readBook(result.accountId);
  const best = book.bestTimes[result.mode][result.difficulty];
  const personalBest = result.won && (best === undefined || result.durationMs < best);
  if (!book.seen.includes(result.id)) {
    book.games++;
    if (result.won) {
      book.wins++;
      book.bestTimes[result.mode][result.difficulty] = Math.min(best ?? Infinity, result.durationMs);
    }
    book.seen.push(result.id);
    book.seen = book.seen.slice(-100);
    try { localStorage.setItem(bookKey(result.accountId), JSON.stringify(book)); }
    catch { storageAvailable = false; }
  }
  return personalBest;
}

function text(id: string, value: string | number): void { element(id).textContent = String(value); }
function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function displayDate(date: string): string {
  if (!date) return '每日 00:00 换新';
  return new Date(`${date}T12:00:00+08:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
}
function toast(message: string): void {
  text('toast', message);
  element('toast').classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element('toast').classList.remove('show'), 2600);
}
function announce(message: string): void { text('liveAnnouncements', message); }
function connectionError(message = '暂时联系不上营地，已显示最近一次进度。'): void {
  state.connected = false;
  text('connectionText', message);
  element('connectionBanner').hidden = false;
  renderControls();
}
function connected(): void { state.connected = true; element('connectionBanner').hidden = true; }

class ApiError extends Error {
  readonly status: number;
  readonly session: SessionView | null;
  constructor(status: number, message: string, session: SessionView | null = null) {
    super(message);
    this.status = status;
    this.session = session;
  }
}
async function request<T>(path: string, body?: StartInput | StepInput): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`../../api/minesweeper/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    const data = await response.json().catch(() => null) as (T & { error?: string; session?: SessionView | null }) | null;
    if (!response.ok || !data) throw new ApiError(response.status, data?.error || '营地暂时没有回应，请重试', data?.session ?? null);
    return data;
  } finally { window.clearTimeout(timeout); }
}

function updateClock(): void {
  const elapsed = clockBase + (state.session?.running ? performance.now() - clockAnchor : 0);
  text('elapsedTime', formatTime(elapsed));
}
function renderSound(): void {
  const button = element<HTMLButtonElement>('soundButton');
  button.innerHTML = icon(soundEnabled ? 'sound' : 'soundOff');
  button.setAttribute('aria-label', String(soundEnabled ? '关闭音效' : '开启音效'));
  button.setAttribute('aria-pressed', String(soundEnabled));
  button.title = soundEnabled ? '关闭音效' : '开启音效';
}
function playSound(kind: 'reveal' | 'flag' | 'won' | 'lost'): void {
  if (!soundEnabled) return;
  const Constructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return;
  try {
    audio ??= new Constructor();
    void audio.resume();
    const tones = kind === 'won' ? [523, 659, 784] : kind === 'lost' ? [220, 164] : kind === 'flag' ? [440] : [620];
    tones.forEach((frequency, index) => {
      const oscillator = audio!.createOscillator();
      const gain = audio!.createGain();
      const start = audio!.currentTime + index * .11;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.035, start + .01); gain.gain.exponentialRampToValueAtTime(.001, start + .15);
      oscillator.connect(gain); gain.connect(audio!.destination); oscillator.start(start); oscillator.stop(start + .17);
    });
  } catch { /* Audio must never interrupt a move. */ }
}

function renderRecords(): void {
  const book = readBook(state.user?.id ?? null);
  const stats = state.user && state.stats ? state.stats : book;
  text('totalGames', stats.games); text('totalWins', stats.wins);
  text('winRate', stats.games ? `${Math.round(stats.wins / stats.games * 100)}%` : '—');
  text('recordSource', state.user && state.stats ? '账号同步' : storageAvailable ? '本机记录' : '当前页面');
  text('bestCaption', '最佳用时');
  for (const [difficulty, id] of [['easy', 'bestEasy'], ['normal', 'bestNormal'], ['hard', 'bestHard']] as const) {
    const best = Math.min(stats.bestTimes[state.mode][difficulty] ?? Infinity, book.bestTimes[state.mode][difficulty] ?? Infinity);
    text(id, Number.isFinite(best) ? formatTime(best) : '—');
  }
  element('recordLogin').hidden = Boolean(state.user);
  element('recordAccountNote').hidden = !state.user;
}

function updateLayout(): void {
  const config = DIFFICULTIES[state.difficulty];
  const style = getComputedStyle(boardScroll);
  const gap = matchMedia('(max-width: 600px)').matches ? 3 : 4;
  const available = boardScroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 6;
  const maximum = state.difficulty === 'hard' ? 29 : state.difficulty === 'normal' ? 33 : 37;
  const minimum = state.difficulty === 'easy' ? 22 : 26;
  const size = Math.max(minimum, Math.min(maximum, Math.floor((available - gap * (config.cols - 1)) / config.cols)));
  board.style.setProperty('--cols', String(config.cols));
  board.style.setProperty('--cell', `${size}px`);
  board.style.setProperty('--gap', `${gap}px`);
  board.classList.toggle('wide-board', available < size * config.cols + gap * (config.cols - 1));
}

function cellLabel(cell: CellView, cols: number): string {
  const position = `第 ${Math.floor(cell.index / cols) + 1} 行第 ${cell.index % cols + 1} 列`;
  const labels = { hidden: '未探索', flagged: '已插旗', mine: '地雷', exploded: '触雷位置', wrongflag: '误标旗帜，这里是安全格', revealed: cell.adjacent ? `数字 ${cell.adjacent}` : '安全空白格' };
  return `${position}，${labels[cell.display]}`;
}

function renderBoard(): void {
  const session = state.session;
  const config = DIFFICULTIES[state.difficulty];
  const renderKey = session?.id || `idle:${state.difficulty}`;
  if (renderedSession !== renderKey || cells.length !== config.rows * config.cols) {
    renderedSession = renderKey;
    focusIndex = Math.min(focusIndex, config.rows * config.cols - 1);
    board.replaceChildren();
    cells = Array.from({ length: config.rows * config.cols }, (_, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'mine-cell'; button.dataset.cell = String(index);
      button.tabIndex = index === focusIndex ? 0 : -1;
      board.appendChild(button);
      return button;
    });
  }
  board.classList.toggle('idle', !session);
  board.classList.toggle('paused', Boolean(session?.paused));
  board.setAttribute('aria-hidden', String(!session || session.paused));
  board.setAttribute('aria-label', `${config.rows} 行 ${config.cols} 列的${config.title}棋盘，共 ${config.mines} 颗地雷`);
  const disabled = !session || session.paused || session.state.status !== 'playing' || state.busy || !state.connected;
  cells.forEach((button, index) => {
    const cell = session?.state.cells[index] ?? { index, display: 'hidden', adjacent: 0 };
    const key = `${cell.display}:${cell.adjacent}`;
    const freshlyRevealed = button.dataset.display === 'hidden:0' && cell.display === 'revealed' && Boolean(session);
    button.disabled = disabled;
    if (button.dataset.display !== key) {
      button.className = `mine-cell ${cell.display}${freshlyRevealed ? ' fresh' : ''}`;
      button.dataset.display = key;
      button.dataset.number = cell.display === 'revealed' ? String(cell.adjacent) : '';
      button.setAttribute('aria-label', cellLabel(cell, config.cols));
      if (cell.display === 'revealed') button.textContent = cell.adjacent ? String(cell.adjacent) : '';
      else if (cell.display === 'flagged') button.innerHTML = icon('flag');
      else if (cell.display === 'wrongflag') button.innerHTML = icon('wrongflag');
      else if (cell.display === 'mine' || cell.display === 'exploded') button.innerHTML = icon('mine');
      else button.textContent = '';
      if (freshlyRevealed) window.setTimeout(() => button.classList.remove('fresh'), 250);
    }
  });
  updateLayout();
}

function renderControls(): void {
  const session = state.session;
  const blocked = state.loading || state.busy || draining || retryAction !== null || !state.connected;
  document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach(button => {
    const selected = button.dataset.difficulty === state.difficulty;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = blocked;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
    const selected = button.dataset.mode === state.mode;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = blocked;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
    const selected = button.dataset.tool === state.tool;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    button.disabled = !session || session.paused || session.state.status !== 'playing';
  });
  const start = element<HTMLButtonElement>('startButton');
  start.disabled = blocked;
  start.innerHTML = state.loading ? '正在连接营地…' : state.busy ? '正在出发…' : `${state.mode === 'daily' ? '挑战今日雷区' : '开始探险'} ${icon('arrow')}`;
  const pause = element<HTMLButtonElement>('pauseButton');
  pause.disabled = blocked || !session || session.state.status !== 'playing';
  pause.innerHTML = icon(session?.paused ? 'play' : 'pause');
  pause.title = session?.paused ? '继续探险' : '暂停探险'; pause.setAttribute('aria-label', pause.title);
  element<HTMLButtonElement>('restartButton').disabled = blocked || !session;
  document.querySelectorAll<HTMLButtonElement>('[data-command="daily"], [data-command="resume"], [data-command="confirmStart"], [data-command="again"]').forEach(button => { button.disabled = blocked; });
  element('readyOverlay').hidden = Boolean(session);
  element('pauseOverlay').hidden = !session?.paused;
  element('resultButton').hidden = !session?.result;
}

function render(): void {
  const session = state.session;
  const config = DIFFICULTIES[state.difficulty];
  document.title = `扫雷 · ${config.label}${state.mode === 'daily' ? ' · 每日挑战' : ''}`;
  text('flagsRemaining', config.mines - (session?.state.flagsUsed ?? 0));
  text('moveCount', session?.state.moves ?? 0);
  const safeCount = config.rows * config.cols - config.mines;
  const revealed = session?.state.revealedSafe ?? 0;
  const progress = Math.round(revealed / safeCount * 100);
  text('progressCount', revealed); text('safeCount', ` / ${safeCount}`); text('progressPercent', `${progress}%`);
  element('progressFill').style.width = `${progress}%`; element('progressTrack').setAttribute('aria-valuenow', String(progress));
  element('dailyStrip').hidden = state.mode !== 'daily';
  text('dailyStripText', `${displayDate(session?.date ?? state.date)} · 固定中心起点`);
  text('dailyDate', `${displayDate(state.date)} · 每日换新`);
  renderControls(); renderBoard(); renderRecords(); updateClock();
}

function openDialog(id: string): void {
  const dialog = element<HTMLDialogElement>(id);
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(open => { if (open !== dialog) open.close(); });
  if (!dialog.open) dialog.showModal();
}

const bestResults = new Set<string>();
function openResult(): void {
  const result = state.session?.result;
  if (!result) return;
  const config = DIFFICULTIES[result.difficulty];
  element('resultDialog').classList.toggle('lost', !result.won);
  element('resultEmblem').innerHTML = icon(result.won ? 'leaf' : 'compass');
  text('resultTitle', result.won ? '成功' : '触雷');
  text('resultCopy', `${config.label}${result.mode === 'daily' ? ` · ${displayDate(result.date || state.date)}` : ''}`);
  text('resultTime', formatTime(result.durationMs)); text('resultMoves', result.moves);
  text('resultProgress', `${Math.round(result.revealedSafe / result.safeCells * 100)}%`);
  element('resultScore').innerHTML = `${result.score}<small>分</small>`;
  element('personalBest').hidden = !bestResults.has(result.id) && !result.personalBest;
  text('resultSaved', result.recorded ? '这次探险已记入你的账号手记。' : result.accountId !== null ? '本局已在本机留存，账号战绩暂未保存。' : storageAvailable ? '本机手记已收好，登录后可同步之后的探险。' : '这次手记可以在当前页面查看。');
  element('playAgainButton').innerHTML = `${result.mode === 'daily' ? '再试今日雷区' : '再探一片'} ${icon('arrow')}`;
  openDialog('resultDialog');
}

function applySession(session: SessionView | null, options: { message?: string; showResult?: boolean } = {}): void {
  state.session = session;
  if (session) { state.difficulty = session.state.difficulty; state.mode = session.mode; }
  clockBase = session?.elapsedMs ?? 0; clockAnchor = performance.now();
  if (session?.result && recordLocal(session.result)) bestResults.add(session.result.id);
  render();
  const message = options.message ?? (!session ? '' : session.paused ? '已暂停' : session.state.status === 'won' ? '成功！' : session.state.status === 'lost' ? '触雷' : '');
  text('statusText', message);
  if (options.message) announce(options.message);
  if (session?.result && options.showResult && announcedResult !== session.id) {
    announcedResult = session.id;
    playSound(session.result.won ? 'won' : 'lost');
    openResult();
    void window.accountUI?.refresh();
    window.setTimeout(() => { void refreshStatus(); }, 0);
  }
}

let hiddenSessionId: string | null = null;
let warnedExpiredLink = false;
async function refreshStatus(options: { announceRestored?: boolean } = {}): Promise<void> {
  if (syncing || state.busy || draining || retryAction) return;
  syncing = true;
  const requestEpoch = epoch;
  try {
    const data = await request<StatusResponse>('status');
    if (requestEpoch !== epoch || state.busy || draining || retryAction) return;
    connected(); state.loading = false; state.stats = data.stats; state.date = data.date;
    if (data.session?.id !== hiddenSessionId) {
      if (!state.session || data.session?.id !== state.session.id || data.session.revision >= state.session.revision) {
        applySession(data.session, { message: options.announceRestored && data.session?.state.status === 'playing' ? '上次的林地已恢复，可以接着探索。' : undefined });
      }
    } else render();
    if (!warnedExpiredLink && params.get('date') && params.get('date') !== data.date) {
      warnedExpiredLink = true;
      toast('这张邀请来自之前的雷区，今日挑战已换新。');
    }
  } catch (error) {
    if (requestEpoch !== epoch) return;
    state.loading = false;
    connectionError(error instanceof ApiError ? error.message : undefined);
    renderBoard();
  } finally {
    syncing = false; renderControls();
    if (requestEpoch !== epoch) window.setTimeout(() => { void refreshStatus(); }, 0);
  }
}

async function startGame(spec = { difficulty: state.difficulty, mode: state.mode }): Promise<void> {
  if (state.busy || draining || retryAction || !state.connected) return;
  const requestEpoch = epoch;
  const replaceSessionId = state.session?.id ?? hiddenSessionId ?? undefined;
  state.busy = true; renderControls(); renderBoard();
  const input: StartInput = { ...spec, replaceSessionId };
  try {
    const data = await request<SessionResponse>('start', input);
    if (requestEpoch !== epoch) return;
    connected(); hiddenSessionId = null; state.tool = 'reveal'; announcedResult = '';
    applySession(data.session, { message: data.session.mode === 'daily' ? '今日林地已打开，挑战从现在开始。' : '准备好了。点任意一格，开始这次探险。', showResult: true });
  } catch (error) {
    if (requestEpoch !== epoch) return;
    if (error instanceof ApiError && error.session) { hiddenSessionId = null; applySession(error.session); toast(error.message); }
    else connectionError(error instanceof ApiError ? error.message : '出发请求暂未收到回应，重新连接可找回已创建的林地。');
  } finally {
    state.busy = false; renderControls(); renderBoard();
    if (requestEpoch !== epoch) void refreshStatus();
  }
}

function chooseSpec(difficulty: Difficulty, mode: GameMode, startImmediately = false): void {
  if (state.busy || draining || retryAction || state.loading) return;
  const current = state.session;
  if (current?.state.status === 'playing' && current.state.firstRevealDone) {
    if (!startImmediately && current.state.difficulty === difficulty && current.mode === mode) return;
    pendingStart = { difficulty, mode };
    text('confirmTitle', mode === 'daily' ? '去今天的林地？' : '换一片林地？');
    text('confirmCopy', `当前探险还在进行中。重新出发会清空这一局，前往${DIFFICULTIES[difficulty].title}${mode === 'daily' ? '的每日挑战' : '自由探索'}。`);
    openDialog('confirmDialog');
    return;
  }
  state.difficulty = difficulty; state.mode = mode;
  hiddenSessionId = current?.id ?? hiddenSessionId;
  state.session = null; clockBase = 0; queue.length = 0;
  render(); text('statusText', '');
  if (startImmediately) void startGame({ difficulty, mode });
}

function enqueue(action: GameAction): void {
  const session = state.session;
  if (!session || session.state.status !== 'playing' || state.busy || !state.connected || retryAction) return;
  if (session.paused && action.type !== 'resume') return;
  if (queue.length >= 24) { toast('正在探索，等上一小步完成吧。'); return; }
  queue.push({ action, sessionId: session.id, epoch });
  void drainQueue();
}

function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}

async function drainQueue(): Promise<void> {
  if (draining || state.busy) return;
  draining = true; renderControls();
  try {
    while (queue.length) {
      const item = queue.shift()!;
      const session = state.session;
      if (!session || item.epoch !== epoch || item.sessionId !== session.id) continue;
      if (!item.input && (session.state.status !== 'playing' || (session.paused && item.action.type !== 'resume'))) continue;
      if (!item.input && 'index' in item.action) {
        const cell = session.state.cells[item.action.index];
        if (item.action.type === 'reveal' && cell?.display !== 'hidden') continue;
        if (item.action.type === 'flag' && !['hidden', 'flagged'].includes(cell?.display)) continue;
      }
      const input = item.input ?? { action: item.action, sessionId: session.id, revision: session.revision, requestId: operationId() };
      try {
        const data = await request<SessionResponse>('action', input);
        if (item.epoch !== epoch) continue;
        connected();
        if (!data.session.result && (item.action.type === 'flag' || item.action.type === 'reveal' || item.action.type === 'chord')) playSound(item.action.type === 'flag' ? 'flag' : 'reveal');
        applySession(data.session, { message: data.message, showResult: true });
      } catch (error) {
        if (item.epoch !== epoch) continue;
        if (error instanceof ApiError && error.status === 400) { toast(error.message); continue; }
        queue.length = 0;
        if (error instanceof ApiError && error.session) {
          hiddenSessionId = null; applySession(error.session, { message: error.message, showResult: true }); toast(error.message);
        } else if (error instanceof ApiError && error.status === 404) {
          applySession(null); hiddenSessionId = null; toast(error.message);
          window.setTimeout(() => { void refreshStatus(); }, 0);
        } else {
          retryAction = { ...item, input };
          connectionError('这一步暂未确认。重新连接后会继续同步，进度不会重复执行。');
          renderBoard();
        }
        break;
      }
    }
  } finally { draining = false; renderControls(); if (state.loading && !state.busy) void refreshStatus(); }
}

function retryConnection(): void {
  if (draining || state.busy) return;
  if (retryAction && retryAction.epoch === epoch && retryAction.sessionId === state.session?.id) {
    queue.unshift(retryAction); retryAction = null;
    void drainQueue();
  } else { retryAction = null; void refreshStatus(); }
}

function setTool(tool: ToolMode): void {
  state.tool = tool; renderControls();
  announce(tool === 'flag' ? '插旗工具，轻点未探索的格子可标记或收旗' : '探索工具，轻点格子可探索');
}

function activateCell(index: number, forceFlag = false): void {
  const cell = state.session?.state.cells[index];
  if (!cell) return;
  if (forceFlag || state.tool === 'flag') {
    if (cell.display === 'hidden' || cell.display === 'flagged') enqueue({ type: 'flag', index });
  } else if (cell.display === 'revealed' && cell.adjacent > 0) enqueue({ type: 'chord', index });
  else if (cell.display === 'hidden') enqueue({ type: 'reveal', index });
  else if (cell.display === 'flagged') toast('先切到插旗工具收旗，再探索这里。');
}

async function copyText(value: string, message: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const previous = document.activeElement as HTMLElement | null;
      const input = document.createElement('textarea');
      input.value = value; input.readOnly = true;
      input.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:16px;';
      document.body.appendChild(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); previous?.focus();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    toast(message);
  } catch { toast('暂时无法复制，可从地址栏分享这个页面。'); }
}

function challengeUrl(): string {
  const url = new URL('./', location.href);
  url.searchParams.set('mode', 'daily'); url.searchParams.set('difficulty', state.difficulty);
  const date = state.session?.mode === 'daily' ? state.session.date : state.date;
  if (date) url.searchParams.set('date', date);
  return url.href;
}

async function command(name: string, target?: Element): Promise<void> {
  switch (name) {
    case 'start': await startGame(); break;
    case 'restart': chooseSpec(state.difficulty, state.mode, true); break;
    case 'daily': chooseSpec(state.difficulty, 'daily', true); break;
    case 'pause': enqueue({ type: state.session?.paused ? 'resume' : 'pause' }); break;
    case 'resume': enqueue({ type: 'resume' }); break;
    case 'retry': retryConnection(); break;
    case 'rules': openDialog('rulesDialog'); break;
    case 'result': openResult(); break;
    case 'closeDialog': target?.closest<HTMLDialogElement>('dialog')?.close(); break;
    case 'confirmStart': {
      const spec = pendingStart;
      pendingStart = null; element<HTMLDialogElement>('confirmDialog').close();
      if (spec) await startGame(spec);
      break;
    }
    case 'again':
      element<HTMLDialogElement>('resultDialog').close();
      chooseSpec(state.difficulty, state.mode, true);
      break;
    case 'share': await copyText(challengeUrl(), '每日挑战链接已复制，叫朋友来探同一片林。'); break;
    case 'shareResult': {
      const result = state.session?.result;
      if (!result) break;
      const url = result.mode === 'daily' ? challengeUrl() : new URL('./', location.href).href;
      await copyText(`扫雷 · 林间探险\n${DIFFICULTIES[result.difficulty].title}${result.mode === 'daily' ? ' · 每日挑战' : ''}\n${result.won ? '探险成功' : '这次探索了 ' + Math.round(result.revealedSafe / result.safeCells * 100) + '%'} · ${formatTime(result.durationMs)} · ${result.score} 分\n${url}`, '探险手记已复制。');
      break;
    }
    case 'login': window.accountUI?.openLogin(); break;
    case 'sound':
      soundEnabled = !soundEnabled;
      try { localStorage.setItem('yg-mine-sound', soundEnabled ? 'on' : 'off'); } catch { /* Preference is still valid for this page. */ }
      renderSound(); if (soundEnabled) playSound('flag');
      toast(soundEnabled ? '轻轻的探索音效已开启。' : '音效已关闭。');
      break;
    case 'fullscreen':
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.body.requestFullscreen(); }
      catch { toast('这个浏览器暂不支持全屏，可以继续正常探索。'); }
      break;
  }
}

document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const target = event.target;
  const difficulty = target.closest<HTMLButtonElement>('[data-difficulty]');
  if (difficulty && !difficulty.disabled) {
    const id = difficulty.dataset.difficulty;
    if (id && Object.hasOwn(DIFFICULTIES, id)) chooseSpec(id as Difficulty, state.mode);
    return;
  }
  const mode = target.closest<HTMLButtonElement>('[data-mode]');
  if (mode && !mode.disabled) {
    const value = mode.dataset.mode;
    if (value === 'classic' || value === 'daily') chooseSpec(state.difficulty, value);
    return;
  }
  const tool = target.closest<HTMLButtonElement>('[data-tool]');
  if (tool && !tool.disabled) { setTool(tool.dataset.tool === 'flag' ? 'flag' : 'reveal'); return; }
  const button = target.closest<HTMLButtonElement>('[data-command]');
  if (button && !button.disabled) void command(button.dataset.command || '', button);
});

interface PressGesture { pointerId: number; index: number; x: number; y: number; fired: boolean; timer: number; }
let gesture: PressGesture | null = null;
let suppressedClick: { index: number; until: number } | null = null;
function buttonAt(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element ? target.closest<HTMLButtonElement>('[data-cell]') : null;
}
function clearGesture(): void { if (gesture) window.clearTimeout(gesture.timer); gesture = null; }
board.addEventListener('pointerdown', event => {
  const button = buttonAt(event.target);
  if (!button || button.disabled || event.pointerType === 'mouse' || event.button !== 0) return;
  const index = Number(button.dataset.cell);
  const cell = state.session?.state.cells[index];
  if (!cell || !['hidden', 'flagged'].includes(cell.display)) return;
  clearGesture();
  const press: PressGesture = { pointerId: event.pointerId, index, x: event.clientX, y: event.clientY, fired: false, timer: 0 };
  press.timer = window.setTimeout(() => {
    if (gesture !== press) return;
    press.fired = true; suppressedClick = { index, until: Date.now() + 1200 };
    activateCell(index, true);
    if (typeof navigator.vibrate === 'function') navigator.vibrate(12);
  }, 450);
  gesture = press;
}, { passive: true });
window.addEventListener('pointermove', event => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
    suppressedClick = { index: gesture.index, until: Date.now() + 700 }; clearGesture();
  }
}, { passive: true });
window.addEventListener('pointerup', event => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  if (gesture.fired) suppressedClick = { index: gesture.index, until: Date.now() + 700 };
  clearGesture();
}, { passive: true });
window.addEventListener('pointercancel', clearGesture, { passive: true });
board.addEventListener('click', event => {
  const button = buttonAt(event.target);
  if (!button || button.disabled) return;
  const index = Number(button.dataset.cell);
  if (suppressedClick?.index === index && suppressedClick.until > Date.now()) {
    event.preventDefault(); suppressedClick = null; return;
  }
  activateCell(index);
});
board.addEventListener('contextmenu', event => {
  event.preventDefault();
  const button = buttonAt(event.target);
  if (!button || button.disabled) return;
  const index = Number(button.dataset.cell);
  if (gesture?.fired || (suppressedClick?.index === index && suppressedClick.until > Date.now())) return;
  activateCell(index, true);
});

function clearHighlights(): void { cells.forEach(cell => cell.classList.remove('neighbor-highlight')); }
board.addEventListener('pointerover', event => {
  if (event.pointerType !== 'mouse') return;
  clearHighlights();
  const button = buttonAt(event.target);
  const session = state.session;
  if (!button || !session || session.paused || session.state.status !== 'playing') return;
  const index = Number(button.dataset.cell);
  const cell = session.state.cells[index];
  if (cell.display === 'revealed' && cell.adjacent > 0) {
    for (const neighbor of neighbors(session.state, index)) {
      if (session.state.cells[neighbor].display === 'hidden') cells[neighbor]?.classList.add('neighbor-highlight');
    }
  }
});
board.addEventListener('pointerleave', clearHighlights);
board.addEventListener('focusin', event => {
  const button = buttonAt(event.target);
  if (!button) return;
  focusIndex = Number(button.dataset.cell);
  cells.forEach((cell, index) => { cell.tabIndex = index === focusIndex ? 0 : -1; });
});
document.addEventListener('keydown', event => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"], .ac-root, .ac-modal-mask') || document.querySelector('dialog[open]')) return;
  if (event.key.toLowerCase() === 'f' && !event.repeat) { event.preventDefault(); setTool(state.tool === 'flag' ? 'reveal' : 'flag'); return; }
  if (event.code === 'Space' && state.session?.state.status === 'playing' && !event.repeat && (!target?.closest('button') || buttonAt(target))) {
    event.preventDefault(); enqueue({ type: state.session.paused ? 'resume' : 'pause' }); return;
  }
  const button = buttonAt(target);
  const session = state.session;
  if (!button || !session || session.paused || session.state.status !== 'playing') return;
  const index = Number(button.dataset.cell);
  const row = Math.floor(index / session.state.cols); const col = index % session.state.cols;
  let next = index;
  if (event.key === 'ArrowLeft' && col > 0) next--;
  else if (event.key === 'ArrowRight' && col < session.state.cols - 1) next++;
  else if (event.key === 'ArrowUp' && row > 0) next -= session.state.cols;
  else if (event.key === 'ArrowDown' && row < session.state.rows - 1) next += session.state.cols;
  else if (!event.key.startsWith('Arrow')) return;
  event.preventDefault(); cells[next]?.focus();
});

element<HTMLDialogElement>('confirmDialog').addEventListener('close', () => { pendingStart = null; });
document.addEventListener('fullscreenchange', () => {
  document.querySelectorAll<HTMLButtonElement>('[data-command="fullscreen"]').forEach(button => {
    button.setAttribute('aria-label', String(document.fullscreenElement ? '退出全屏探索' : '全屏探索'));
    button.title = document.fullscreenElement ? '退出全屏探索' : '全屏探索';
  });
  updateLayout();
});
window.addEventListener('resize', updateLayout);
if (typeof ResizeObserver === 'function') new ResizeObserver(updateLayout).observe(boardScroll);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateClock(); void refreshStatus(); } });
window.addEventListener('online', retryConnection);
window.addEventListener('offline', () => { connectionError('网络暂时断开了，连上后可以继续探索。'); renderBoard(); });
window.addEventListener('storage', event => { if (event.key === bookKey(state.user?.id ?? null)) renderRecords(); });
window.accountUI?.onChange((user: AccountUser | null) => {
  const previous = state.user?.id ?? null;
  state.user = user;
  if ((user?.id ?? null) === previous) { renderRecords(); return; }
  epoch++; queue.length = 0; retryAction = null; hiddenSessionId = null;
  state.session = null; state.stats = null; state.loading = true; clockBase = 0;
  clearGesture(); render();
  void refreshStatus();
});
renderSound(); render();
void refreshStatus({ announceRestored: true });
window.setInterval(updateClock, 250);
window.setInterval(() => { if (!document.hidden) void refreshStatus(); }, 20000);
