import { LEVELS, TICK_RATE, validSnapshot } from './engine.ts';
import { FRUITS, fruitName } from './fruits.ts';
import { WatermelonRuntime } from './runtime.ts';
import { ApiError, ChallengeSession, clearRecovery, readRecovery, readStored, removeStored, request, validResult, validSession, writeStored } from './session.ts';
import type { AccountUser, WatermelonActiveSession, WatermelonResult, WatermelonSessionResponse, WatermelonStart, WatermelonStats, WatermelonStatus, WatermelonSnapshot } from './protocol.ts';
import type { WatermelonProgress } from './types.ts';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing game element: ${id}`);
  return node as T;
}
const icons: Record<string, string> = {
  back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  restart: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6"/>',
  undo: '<path d="M9 5 3 11l6 6M3 11h11a6 6 0 0 1 6 6v2"/>',
  book: '<path d="M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sound: '<path d="m3 9 4 0 5-5v16l-5-5H3V9Zm13-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/>',
  soundOff: '<path d="m3 9 4 0 5-5v16l-5-5H3V9Zm13 0 6 6m-6 0 6-6"/>',
};
const icon = (name: string) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon || ''); });
element('fruitChain').innerHTML = FRUITS.map(fruit => `<li data-level="${fruit.level}" title="${fruit.name}" aria-label="${fruit.name}"><img src="${fruit.image}" alt="" width="39" height="39"></li>`).join('');

type Mode = 'practice' | 'challenge';
const PRACTICE_KEY = 'yg.watermelon.practice.v1';
const MODE_KEY = 'yg.watermelon.mode.v1';
const mode = readStored<{ mode?: string }>(MODE_KEY)?.mode === 'challenge' ? 'challenge' : 'practice';
const state = {
  mode: mode as Mode, user: (window.accountUI?.getUser() ?? null) as AccountUser | null,
  stats: null as WatermelonStats | null, remote: null as WatermelonActiveSession | null,
  challenge: null as ChallengeSession | null, result: null as WatermelonResult | null,
  busy: false, restoring: false, failed: false, epoch: 0,
  pendingStart: null as WatermelonStart | null, settlementPending: false,
};
let runtime: WatermelonRuntime | null = null;
let accountReady = false, endedScheduled = false, resumeOnClose = false;
let confirmation: (() => Promise<void>) | null = null;
let toastTimer = 0, lastPracticeTick = 0, lastPracticeMoves = -1, lastPracticePhase = '';
const ownerKey = () => state.user ? `account:${state.user.id}` : 'guest';
const recordsKey = () => `yg.watermelon.records.v1:${state.mode === 'practice' ? 'practice' : ownerKey()}`;
const text = (id: string, value: string | number) => { element(id).textContent = String(value); };
function toast(message: string): void {
  const node = element('toast'); node.textContent = message; node.classList.add('show');
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => node.classList.remove('show'), 2300);
}
function announce(message: string): void { text('announcements', message); }
function clock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function localRecords(): WatermelonResult[] {
  const records = readStored<unknown[]>(recordsKey());
  return Array.isArray(records) ? records.filter(validResult).slice(0, 20) : [];
}
function localSummary(): Omit<WatermelonStats, 'recent'> {
  const stored = readStored<Omit<WatermelonStats, 'recent'>>(recordsKey() + ':summary');
  if (stored && Number.isSafeInteger(stored.games) && stored.games >= 0 && Number.isSafeInteger(stored.wins) && stored.wins >= 0
    && Number.isSafeInteger(stored.bestScore) && stored.bestScore >= 0 && Number.isSafeInteger(stored.highest) && stored.highest >= -1 && stored.highest <= 8) return stored;
  const recent = localRecords();
  return { games: recent.length, wins: recent.filter(result => result.won).length,
    bestScore: Math.max(0, ...recent.map(result => result.score)), highest: Math.max(-1, ...recent.map(result => result.highest)) };
}
function remember(result: WatermelonResult): void {
  const recent = localRecords();
  if (!recent.some(record => record.id === result.id)) {
    const summary = localSummary();
    writeStored(recordsKey() + ':summary', { games: summary.games + 1, wins: summary.wins + Number(result.won),
      bestScore: Math.max(summary.bestScore, result.score), highest: Math.max(summary.highest, result.highest) });
  }
  writeStored(recordsKey(), [result, ...recent.filter(record => record.id !== result.id)].slice(0, 20));
}
function renderRecords(): void {
  const local = localRecords();
  const stats = state.mode === 'challenge' && state.user && state.stats ? state.stats : { ...localSummary(), recent: local };
  text('recordSource', state.mode === 'challenge' && state.user && state.stats ? '账号战绩' : '本机记录');
  text('recordBest', stats.bestScore); text('recordGames', stats.games); text('recordWins', stats.wins);
  text('highestName', stats.highest >= 0 ? fruitName(stats.highest) : '等你收获');
  const highest = element<HTMLImageElement>('highestImage');
  highest.src = FRUITS[Math.max(0, stats.highest >= 0 ? stats.highest : 8)].image;
  highest.style.opacity = stats.highest >= 0 ? '1' : '.5';
  const list = element('recentRecords'); list.replaceChildren();
  for (const record of stats.recent.slice(0, 3)) {
    const row = document.createElement('li'), name = document.createElement('span'), score = document.createElement('b'), time = document.createElement('time');
    name.textContent = fruitName(record.highest); score.textContent = `${record.score} 分`;
    const date = new Date(record.endedAt); time.dateTime = date.toISOString(); time.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
    row.append(name, score, time); list.append(row);
  }
  element('recordLogin').hidden = state.mode !== 'challenge' || Boolean(state.user);
}
function renderProgress(progress: WatermelonProgress): void {
  text('score', progress.score); text('bestScore', progress.best); text('moveCount', progress.moves);
  const next = element<HTMLImageElement>('nextFruit');
  if (next.dataset.level !== String(progress.next)) {
    next.dataset.level = String(progress.next); next.src = FRUITS[progress.next].image; next.alt = fruitName(progress.next);
    text('nextName', fruitName(progress.next));
  }
  element('readyOverlay').hidden = progress.phase !== 'ready';
  element('pauseOverlay').hidden = progress.phase !== 'paused' || progress.locked;
  element('overOverlay').hidden = progress.phase !== 'over' && !state.result;
  const pause = element<HTMLButtonElement>('pauseButton');
  pause.disabled = state.busy || progress.locked || !['playing', 'paused'].includes(progress.phase);
  pause.innerHTML = icon(progress.phase === 'paused' ? 'play' : 'pause');
  pause.setAttribute('aria-label', progress.phase === 'paused' ? '继续' : '暂停'); pause.title = pause.getAttribute('aria-label') || '';
  element<HTMLButtonElement>('restartButton').disabled = state.busy;
  const undo = element<HTMLButtonElement>('undoButton'); undo.hidden = state.mode !== 'practice'; undo.disabled = state.busy || !progress.canUndo;
  element<HTMLButtonElement>('finishButton').disabled = state.busy || (!state.result && (progress.moves === 0 || progress.locked));
  text('finishButton', state.result ? '本局收获 ↗' : '收下本局 ↗');
  element<HTMLButtonElement>('resultButton').disabled = state.busy;
  text('resultButton', state.busy ? '正在记录…' : '查看收获 ↗');
  const start = element<HTMLButtonElement>('startButton'); start.disabled = state.busy || !runtime;
  start.innerHTML = state.busy ? '正在准备…' : `${state.mode === 'practice' ? '开始合成' : '开始挑战'} ${icon('arrow')}`;
  const sound = element<HTMLButtonElement>('soundButton');
  sound.innerHTML = icon(progress.sound ? 'sound' : 'soundOff');
  sound.setAttribute('aria-label', progress.sound ? '关闭音效' : '开启音效'); sound.title = sound.getAttribute('aria-label') || '';
  const combo = element('combo'); combo.hidden = progress.combo < 2; combo.textContent = `${progress.combo} 连锁`;
  document.querySelectorAll<HTMLElement>('#fruitChain li').forEach(node => {
    const level = Number(node.dataset.level), highest = Math.max(0, progress.highest);
    node.classList.toggle('collected', level <= highest); node.classList.toggle('current', level === highest);
  });
  document.querySelectorAll<HTMLButtonElement>('.mode-picker [data-mode]').forEach(button => {
    const selected = button.dataset.mode === state.mode; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = state.busy;
  });
  text('syncStatus', state.busy ? (state.settlementPending ? '正在记录' : '正在准备') : state.mode === 'practice' ? '本机游戏' : state.failed ? '等待重连' : state.result ? '本局完成' : '进度已保留');
}
function savePractice(force = false): void {
  if (!runtime || state.mode !== 'practice' || state.restoring || state.result || runtime.progress.moves === 0) return;
  const progress = runtime.progress;
  if (progress.phase === 'over') return;
  if (force || progress.tick - lastPracticeTick >= 240 || progress.moves !== lastPracticeMoves || progress.phase !== lastPracticePhase) {
    writeStored(PRACTICE_KEY, runtime.checkpoint);
    lastPracticeTick = progress.tick; lastPracticeMoves = progress.moves; lastPracticePhase = progress.phase;
  }
}
function progressChanged(progress: WatermelonProgress): void {
  renderProgress(progress);
  if (state.restoring || !runtime) return;
  if (state.mode === 'challenge' && state.challenge && !state.result && !state.failed) {
    try { state.challenge.observe(progress.tick, progress.phase !== 'playing'); } catch (error) { fail(error); }
  } else savePractice();
  if (progress.phase === 'over' && !state.result && !state.busy && !endedScheduled) {
    endedScheduled = true;
    queueMicrotask(() => { endedScheduled = false; void settle().catch(fail); });
  }
}
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : '暂时无法完成，请重试';
  if (state.mode === 'challenge') {
    state.failed = true; element('connectionBanner').hidden = false; text('connectionText', message);
    if (runtime?.progress.phase === 'playing') void runtime.capture().catch(() => {});
  } else toast(message);
  if (runtime) renderProgress(runtime.progress);
}
function connected(): void { state.failed = false; element('connectionBanner').hidden = true; }
function closeDialogs(resume = true): void {
  if (!resume) resumeOnClose = false;
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
}
async function openDialog(id: string, resume = false): Promise<void> {
  resumeOnClose = resume && runtime?.progress.phase === 'playing';
  await runtime?.capture();
  const dialog = element<HTMLDialogElement>(id);
  if (!dialog.open) dialog.showModal();
}
function showResult(): void {
  const result = state.result;
  if (!result) return;
  text('resultTitle', result.won ? '收获大西瓜！' : '本局收获');
  text('resultScore', result.score); text('resultHighest', fruitName(result.highest)); text('resultMoves', `${result.moves} 颗`); text('resultTime', clock(result.durationMs));
  element<HTMLImageElement>('resultFruit').src = FRUITS[result.highest >= 0 ? result.highest : 0].image;
  element('personalBest').hidden = !result.personalBest;
  text('resultSaved', result.recorded ? '已保存到你的账号' : state.mode === 'practice' ? '练习成绩已保存在本机' : result.accountId ? '账号暂时未保存，成绩已留在本机' : '成绩已保存在本机');
  resumeOnClose = false;
  const dialog = element<HTMLDialogElement>('resultDialog'); if (!dialog.open) dialog.showModal();
}
async function settle(): Promise<void> {
  if (!runtime || state.busy) return;
  if (state.result) { showResult(); return; }
  if (runtime.progress.moves === 0) return;
  state.busy = true; state.settlementPending = true;
  const current = state.challenge;
  try {
    const progress = await runtime.capture(true);
    if (state.mode === 'challenge') {
      if (!current) throw new ApiError(0, '请先重新连接这局');
      current.observe(progress.tick, true);
      const response = await current.finish();
      if (current !== state.challenge) return;
      if (!validResult(response.session.result)) throw new ApiError(0, '收获尚未确认，请重试');
      state.remote = response.session; state.stats = response.stats ?? state.stats; state.result = response.session.result;
    } else {
      const best = localSummary().bestScore;
      state.result = {
        id: crypto.randomUUID(), score: progress.score, highest: progress.highest, moves: progress.moves,
        durationMs: Math.round(progress.tick / TICK_RATE * 1000), won: progress.highest === LEVELS.length - 1,
        gameOver: progress.phase === 'over', recorded: false, accountId: null,
        personalBest: progress.score > best, endedAt: Date.now(),
      };
      removeStored(PRACTICE_KEY);
    }
    remember(state.result); state.settlementPending = false; connected();
    await runtime.complete(); renderRecords(); showResult();
    if (state.result.recorded) void window.accountUI?.refresh();
  } finally { state.busy = false; renderProgress(runtime.progress); }
}
async function restoreChallenge(active: WatermelonActiveSession, previousOwner?: string): Promise<void> {
  if (!runtime) return;
  const owner = ownerKey();
  const ownSaved = readRecovery(owner), previous = previousOwner ? readRecovery(previousOwner) : null;
  const saved = ownSaved?.session.session_id === active.session_id ? ownSaved : previous?.session.session_id === active.session_id ? previous : null;
  state.restoring = true;
  try {
    state.challenge = new ChallengeSession(active, owner, saved); state.result = active.result;
    await runtime.initialize(state.challenge.init);
    if (saved === previous && previousOwner === 'guest' && owner !== previousOwner) clearRecovery(previousOwner);
    if (state.result) { await runtime.complete(); remember(state.result); showResult(); }
  } finally { state.restoring = false; }
}
async function loadStatus(restore = state.mode === 'challenge', previousOwner?: string): Promise<void> {
  const epoch = ++state.epoch;
  const payload = await request<WatermelonStatus>('status');
  if (epoch !== state.epoch) return;
  if (payload.active_session !== null && !validSession(payload.active_session)) throw new ApiError(0, '本局进度无效，请重试');
  state.stats = payload.stats; state.remote = payload.active_session;
  connected();
  if (restore && runtime) {
    if (state.remote) await restoreChallenge(state.remote, previousOwner);
    else {
      const saved = readRecovery(ownerKey());
      const recorded = saved && state.stats?.recent.find(result => result.id === saved.session.session_id);
      state.challenge = null; state.result = recorded || null;
      state.restoring = true;
      try {
        if (recorded && saved) {
          await runtime.initialize({ mode: 'practice', session_id: null, seed: saved.session.seed, state: saved.session.state, locked: true });
          clearRecovery(ownerKey()); await runtime.complete(); showResult();
        } else await runtime.initialize({ mode: 'practice', session_id: null, ready: true, locked: true });
      } finally { state.restoring = false; }
    }
  }
  renderRecords(); if (runtime) renderProgress(runtime.progress);
}
async function startChallenge(): Promise<void> {
  if (!runtime || state.busy) return;
  state.busy = true; state.restoring = true; renderProgress(runtime.progress);
  state.pendingStart ??= { request_id: crypto.randomUUID(), ...(state.remote ? { replace_session_id: state.remote.session_id } : {}) };
  try {
    const response = await request<WatermelonSessionResponse>('start', state.pendingStart);
    if (!validSession(response.session)) throw new ApiError(0, '开局进度无效，请重试');
    state.remote = response.session; state.challenge = new ChallengeSession(response.session, ownerKey(), null);
    state.result = null; state.settlementPending = false; state.pendingStart = null; connected();
    await runtime.initialize({ ...state.challenge.init, paused: false });
    state.challenge.observe(runtime.progress.tick, false);
  } catch (error) {
    if (error instanceof ApiError && error.session && error.status === 409) {
      state.pendingStart = null; state.remote = error.session; await restoreChallenge(error.session); connected();
    } else throw error;
  } finally { state.busy = false; state.restoring = false; renderProgress(runtime.progress); }
}
async function newRound(): Promise<void> {
  if (!runtime) return;
  closeDialogs(false);
  if (state.mode === 'challenge') { await startChallenge(); return; }
  state.result = null; state.settlementPending = false; removeStored(PRACTICE_KEY);
  state.restoring = true;
  try { await runtime.initialize({ mode: 'practice', session_id: null }); }
  finally { state.restoring = false; }
  lastPracticeTick = 0; lastPracticeMoves = -1; renderRecords(); renderProgress(runtime.progress);
}
async function selectMode(next: Mode): Promise<void> {
  if (!runtime || !['practice', 'challenge'].includes(next) || next === state.mode || state.busy) return;
  state.busy = true;
  try {
    await runtime.capture(); savePractice(true);
    if (state.mode === 'challenge' && state.challenge && !state.result && !state.failed) {
      try { await state.challenge.sync(); state.remote = state.challenge.active; } catch (error) { fail(error); }
    }
    state.mode = next; state.result = null; state.settlementPending = false;
    writeStored(MODE_KEY, { mode: next }); state.restoring = true;
    if (next === 'challenge') await loadStatus(true);
    else {
      state.challenge = null; connected();
      const saved = readStored<{ seed: string; state: WatermelonSnapshot }>(PRACTICE_KEY);
      await runtime.initialize(saved && validSnapshot(saved.state) ? { mode: 'practice', session_id: null, ...saved } : { mode: 'practice', session_id: null, ready: true });
    }
  } finally { state.busy = false; state.restoring = false; renderRecords(); renderProgress(runtime.progress); }
}
async function retry(): Promise<void> {
  if (!runtime || state.busy) return;
  if (state.settlementPending) { await settle(); return; }
  if (state.pendingStart) { await startChallenge(); return; }
  state.busy = true; renderProgress(runtime.progress);
  try {
    if (state.challenge) {
      try { state.challenge.observe(runtime.progress.tick, true); await state.challenge.sync(); connected(); }
      catch (error) {
        if (error instanceof ApiError && [404, 409, 412].includes(error.status)) await loadStatus(true);
        else throw error;
      }
    } else await loadStatus(state.mode === 'challenge');
  } finally { state.busy = false; renderProgress(runtime.progress); }
}
async function confirm(title: string, copy: string, label: string, action: () => Promise<void>): Promise<void> {
  confirmation = action; text('confirmTitle', title); text('confirmCopy', copy); text('confirmButton', label);
  await openDialog('confirmDialog', true);
}
async function command(name: string): Promise<void> {
  if (!runtime) return;
  if (name === 'closeDialog') { closeDialogs(); return; }
  if (name === 'sound') { await runtime.toggleSound(); return; }
  if (name === 'rules') { await openDialog('rulesDialog', true); return; }
  if (name === 'login') { await runtime.capture(); window.accountUI?.openLogin(); return; }
  if (name === 'retry') { await retry(); return; }
  if (state.busy) return;
  if (name === 'start') { if (state.mode === 'practice') await runtime.begin(); else await startChallenge(); }
  if (name === 'pause') await runtime.togglePause();
  if (name === 'resume') { if (state.failed) await retry(); if (!state.failed) await runtime.resume(); }
  if (name === 'undo') { await runtime.undo(); savePractice(true); }
  if (name === 'again') await newRound();
  if (name === 'result') await settle();
  if (name === 'restart') {
    if (runtime.progress.moves > 0 && !state.result) await confirm('重新开始？', '当前进度会被清空。', '重新开始', newRound);
    else await newRound();
  }
  if (name === 'finish') {
    if (state.result) showResult();
    else await confirm('收下本局？', '结束当前这局，保存这次收获。', '收下本局', settle);
  }
  if (name === 'confirm' && confirmation) { const action = confirmation; confirmation = null; closeDialogs(false); await action(); }
}
document.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-command], .mode-picker [data-mode]') : null;
  if (!button || button.disabled) return;
  const action = button.dataset.mode ? selectMode(button.dataset.mode as Mode) : command(button.dataset.command || '');
  void action.catch(fail);
});
document.querySelectorAll<HTMLDialogElement>('dialog').forEach(dialog => dialog.addEventListener('close', () => {
  if (resumeOnClose && !state.busy && !state.result) { resumeOnClose = false; void runtime?.resume().catch(fail); }
}));

try {
  runtime = new WatermelonRuntime(element<HTMLCanvasElement>('gameCanvas'), {
    progress: progressChanged,
    drop: (drop, moves) => {
      if (state.mode === 'challenge' && state.challenge) { try { state.challenge.drop(drop, moves); } catch (error) { fail(error); } }
      else savePractice(true);
    },
    claim: () => { void settle().catch(fail); }, practice: () => { void newRound().catch(fail); },
    announce,
  });
  renderProgress(runtime.progress);
} catch (error) { text('startButton', '画面加载失败'); element<HTMLButtonElement>('startButton').disabled = true; fail(error); }

window.accountUI?.onChange(user => {
  const previousOwner = ownerKey(), changed = (state.user?.id ?? null) !== (user?.id ?? null);
  state.user = user; renderRecords();
  if (!accountReady || !changed || !runtime) return;
  const current = runtime;
  void (async () => {
    state.busy = true; await current.capture();
    try { await loadStatus(state.mode === 'challenge', previousOwner); }
    finally { state.busy = false; renderProgress(current.progress); }
  })().catch(fail);
});
async function initialize(): Promise<void> {
  if (!runtime) return;
  state.busy = state.mode === 'challenge'; state.restoring = true;
  try {
    if (state.mode === 'practice') {
      const saved = readStored<{ seed: string; state: WatermelonSnapshot }>(PRACTICE_KEY);
      if (saved && validSnapshot(saved.state)) await runtime.initialize({ mode: 'practice', session_id: null, ...saved });
    } else await runtime.initialize({ mode: 'practice', session_id: null, ready: true, locked: true });
    state.restoring = false;
    await window.accountUI?.refresh(); state.user = window.accountUI?.getUser() ?? null; accountReady = true;
    await loadStatus(state.mode === 'challenge');
  } finally { state.busy = false; state.restoring = false; renderRecords(); renderProgress(runtime.progress); }
}
void initialize().catch(fail);
window.setInterval(() => {
  savePractice();
  const current = state.challenge;
  if (state.mode !== 'challenge' || !current || state.busy || state.failed || state.restoring || state.result) return;
  void current.sync().then(active => { if (current === state.challenge) state.remote = active; }).catch(error => { if (current === state.challenge) fail(error); });
}, 1800);
window.addEventListener('pagehide', () => savePractice(true));
