// Adapted from 兑换码分发/src/lib/minesweeper-engine.ts.
// Keep the original board sizes, first-click sanctuary, flood reveal and chord rules.
// This dependency-free module is shared by the authoritative server and other TS consumers.

import type { Difficulty, DifficultyConfig, GameState, GameView, GridAction, ActionResult, CellDisplay } from './types.ts';

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = Object.freeze({
  easy: Object.freeze({ id: 'easy', label: '简单', title: '林间小径', rows: 9, cols: 9, mines: 10, baseScore: 500, timeBonusSeconds: 180 }),
  normal: Object.freeze({ id: 'normal', label: '普通', title: '深林营地', rows: 12, cols: 12, mines: 24, baseScore: 1000, timeBonusSeconds: 300 }),
  hard: Object.freeze({ id: 'hard', label: '困难', title: '雾中山谷', rows: 16, cols: 16, mines: 40, baseScore: 1800, timeBonusSeconds: 480 }),
});

function randomFromSeed(seed: string): () => number {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return () => {
    hash = (hash + 0x6d2b79f5) | 0;
    let value = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function neighbors(state: Pick<GameState, 'rows' | 'cols'>, index: number): number[] {
  const row = Math.floor(index / state.cols);
  const col = index % state.cols;
  const result = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < state.rows && c >= 0 && c < state.cols) result.push(r * state.cols + c);
    }
  }
  return result;
}

export function createGame(seed: string, difficulty: Difficulty = 'easy'): GameState {
  if (!Object.hasOwn(DIFFICULTIES, difficulty)) throw new Error('请选择有效的难度');
  const config = DIFFICULTIES[difficulty];
  return {
    version: 1,
    seed: String(seed),
    difficulty,
    rows: config.rows,
    cols: config.cols,
    mines: config.mines,
    status: 'playing',
    firstRevealDone: false,
    firstIndex: null,
    revealedSafe: 0,
    flagsUsed: 0,
    moves: 0,
    exploded: null,
    cells: Array.from({ length: config.rows * config.cols }, () => ({ mine: false, adjacent: 0, revealed: false, flagged: false })),
  };
}

function layMines(state: GameState, firstIndex: number): void {
  const safe = new Set([firstIndex, ...neighbors(state, firstIndex)]);
  const candidates = state.cells.map((_, index) => index).filter(index => !safe.has(index));
  const rng = randomFromSeed(`${state.seed}:forest:${state.difficulty}:${firstIndex}`);
  for (let i = candidates.length - 1; i > 0; i--) {
    const other = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[other]] = [candidates[other], candidates[i]];
  }
  for (const index of candidates.slice(0, state.mines)) state.cells[index].mine = true;
  state.cells.forEach((cell, index) => {
    if (!cell.mine) cell.adjacent = neighbors(state, index).filter(next => state.cells[next].mine).length;
  });
  state.firstRevealDone = true;
  state.firstIndex = firstIndex;
}

function floodReveal(state: GameState, index: number): number {
  const queue = [index];
  const seen = new Set();
  let revealed = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (seen.has(current)) continue;
    seen.add(current);
    const cell = state.cells[current];
    if (cell.revealed || cell.flagged || cell.mine) continue;
    cell.revealed = true;
    state.revealedSafe++;
    revealed++;
    if (cell.adjacent === 0) queue.push(...neighbors(state, current));
  }
  return revealed;
}

function reveal(state: GameState, index: number): number {
  const cell = state.cells[index];
  if (cell.mine) {
    cell.revealed = true;
    state.exploded = index;
    state.status = 'lost';
    return 0;
  }
  return floodReveal(state, index);
}

function checkWin(state: GameState): void {
  if (state.status !== 'playing' || state.revealedSafe !== state.cells.length - state.mines) return;
  state.status = 'won';
  for (const cell of state.cells) if (cell.mine) cell.flagged = true;
  state.flagsUsed = state.cells.filter(cell => cell.flagged).length;
}

export function applyAction(state: GameState, action: GridAction): ActionResult {
  if (state.status !== 'playing') return { ok: false, message: '这次探险已经结束了' };
  if (!action || !['reveal', 'flag', 'chord'].includes(action.type)) return { ok: false, message: '未知操作' };
  const { index, type } = action;
  if (!Number.isInteger(index) || index < 0 || index >= state.cells.length) return { ok: false, message: '格子坐标无效' };
  const target = state.cells[index];
  if (type === 'flag' && target.revealed) return { ok: false, message: '已经探索过的格子不能插旗' };
  if (type === 'flag' && !target.flagged && state.flagsUsed >= state.mines) return { ok: false, message: '旗帜已用完，可以先移除一面' };
  if (type === 'reveal' && target.flagged) return { ok: false, message: '先收起旗帜，再探索这个格子' };
  if (type === 'reveal' && target.revealed) return { ok: false, message: '这个格子已经探索过了' };
  const surrounding = neighbors(state, index);
  if (type === 'chord') {
    if (!target.revealed || target.adjacent < 1) return { ok: false, message: '点已揭开的数字，才能快速展开' };
    if (surrounding.filter(next => state.cells[next].flagged).length !== target.adjacent) {
      return { ok: false, message: `周围需要 ${target.adjacent} 面旗帜，才可以快速展开` };
    }
    if (!surrounding.some(next => !state.cells[next].revealed && !state.cells[next].flagged)) {
      return { ok: false, message: '周围的格子已经探索完了' };
    }
  }

  const next = { ...state, cells: state.cells.map(cell => ({ ...cell })) };
  next.moves++;
  let revealedDelta = 0;
  let message: string | undefined;
  if (type === 'flag') {
    next.cells[index].flagged = !next.cells[index].flagged;
    next.flagsUsed += next.cells[index].flagged ? 1 : -1;
    message = next.cells[index].flagged ? '已插旗，标记一处可能的地雷' : '旗帜已收起';
  } else if (type === 'reveal') {
    if (!next.firstRevealDone) layMines(next, index);
    revealedDelta = reveal(next, index);
  } else {
    for (const neighbor of surrounding) {
      if (next.cells[neighbor].revealed || next.cells[neighbor].flagged) continue;
      revealedDelta += reveal(next, neighbor);
      if (next.status === 'lost') break;
    }
  }
  checkWin(next);
  if (next.status === 'won') message = '整片林地都安全了，探险成功！';
  else if (next.status === 'lost') message = '遇到地雷了，休息一下再出发';
  else if (!message) message = `探索了 ${revealedDelta} 个安全格`;
  return { ok: true, state: next, message: message ?? '进度已更新', revealedDelta };
}

export function buildView(state: GameState): GameView {
  const finished = state.status !== 'playing';
  return {
    difficulty: state.difficulty,
    rows: state.rows,
    cols: state.cols,
    mines: state.mines,
    status: state.status,
    firstRevealDone: state.firstRevealDone,
    revealedSafe: state.revealedSafe,
    flagsUsed: state.flagsUsed,
    moves: state.moves,
    exploded: state.exploded,
    cells: state.cells.map((cell, index) => {
      let display: CellDisplay = 'hidden';
      if (index === state.exploded) display = 'exploded';
      else if (finished && cell.flagged && !cell.mine) display = 'wrongflag';
      else if (cell.flagged) display = 'flagged';
      else if (cell.revealed) display = cell.mine ? 'mine' : 'revealed';
      else if (finished && cell.mine) display = 'mine';
      return { index, display, adjacent: cell.revealed || finished ? cell.adjacent : 0 };
    }),
  };
}

export function calculateScore(state: GameState, durationMs: number): number {
  const config = DIFFICULTIES[state.difficulty];
  const rate = state.difficulty === 'hard' ? 8 : state.difficulty === 'normal' ? 6 : 4;
  const safeCount = state.cells.length - state.mines;
  const won = state.status === 'won';
  const base = Math.round(config.baseScore * state.revealedSafe / safeCount);
  const flags = won ? state.mines * 6 : state.cells.filter(cell => cell.flagged && cell.mine).length * 3;
  const timeBonus = won ? Math.max(0, config.timeBonusSeconds - Math.ceil(Math.max(0, durationMs) / 1000)) * (rate / 2) : 0;
  return Math.max(0, Math.min(5000, base + state.revealedSafe * rate + flags + timeBonus + (won ? Math.round(config.baseScore * .35) : 0)));
}
