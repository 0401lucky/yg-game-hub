import type { CardId, Play, GameState, Action, BotView, Difficulty } from './types.ts';
interface Template { code: number; size: number; entries: number[][] }
interface Planner { plays: Play[]; cost(cards: CardId[]): number }
interface RankedPlay extends Play { score: number }
import { DECK, rankOf, rankGroups, legalPlays, canBeat, applyAction, publicState, sortCards } from './engine.ts';

export const DIFFICULTIES = {
  easy: { name: '简单', title: '温柔陪练', description: '基础叫分和顺手出牌，适合熟悉节奏。' },
  hard: { name: '困难', title: '认真过招', description: '规划拆牌，保留大牌，懂得配合农民队友。' },
  hell: { name: '地狱', title: '步步紧逼', description: '记住已出牌，推演可能的对手手牌，争夺出牌权。' }
};

const powers = Array.from({ length: 15 }, (_, i) => 5 ** i);
function countsOf(cards: CardId[]) {
  const counts = Array(15).fill(0);
  for (const id of cards) counts[rankOf(id) - 3]++;
  return counts;
}
function encode(counts: number[]) { return counts.reduce((sum, count, index) => sum + count * powers[index], 0); }
function fits(template: Template, counts: number[]) { return template.entries.every(([rank, count]) => counts[rank] >= count); }

// 在点数计数上搜索拆牌，花色不影响斗地主牌型。节点预算限制服务端思考时间。
export function handPlanner(hand: CardId[], nodeBudget = 350, laiziRank: number | null = null): Planner {
  const plays = legalPlays(hand, null, laiziRank);
  const unique: Map<number, Template> = new Map();
  for (const move of plays) {
    const counts = countsOf(move.cards);
    const code = encode(counts);
    if (!unique.has(code)) unique.set(code, {
      code, size: move.cards.length,
      entries: counts.flatMap((count, rank) => count ? [[rank, count]] : [])
    });
  }
  const templates = [...unique.values()].sort((a, b) => b.size - a.size);
  const byRank = Array.from({ length: 15 }, (_, rank) => templates.filter(template => template.entries.some(([index]) => index === rank)));
  const memo = new Map([[0, 0]]);
  let nodes = 0;
  function greedy(counts: number[]) {
    const left = [...counts];
    let turns = 0;
    while (left.some(Boolean)) {
      const best = templates.find(template => fits(template, left));
      if (!best) return turns + left.reduce((sum, count) => sum + count, 0);
      for (const [rank, count] of best.entries) left[rank] -= count;
      turns++;
    }
    return turns;
  }
  function solve(counts: number[]): number {
    const code = encode(counts);
    if (memo.has(code)) return memo.get(code)!;
    const direct = unique.get(code);
    if (direct) { memo.set(code, 1); return 1; }
    let best = greedy(counts);
    if (++nodes > nodeBudget || best <= 2) return best;
    const anchor = counts.findIndex(Boolean);
    for (const template of byRank[anchor]) {
      if (!fits(template, counts)) continue;
      const remainder = [...counts];
      for (const [rank, count] of template.entries) remainder[rank] -= count;
      best = Math.min(best, 1 + solve(remainder));
      if (best === 2 || nodes > nodeBudget) break;
    }
    memo.set(code, best);
    return best;
  }
  return { plays, cost: cards => solve(countsOf(cards)) };
}

function sameSide(a: number | null, b: number | null, landlord: number | null) { return (a === landlord) === (b === landlord); }
function remaining(hand: CardId[], move: Play) { const used = new Set(move.cards); return hand.filter(id => !used.has(id)); }
function urgency(view: BotView) {
  return view.counts.some((count, seat) => !sameSide(seat, view.seat, view.landlordSeat) && count <= 2);
}

function handStrength(hand: CardId[], laiziRank: number | null, plannerBudget: number) {
  const groups = rankGroups(hand);
  let strength = 0;
  const wildCount = laiziRank !== null ? (groups.get(laiziRank)?.length || 0) : 0;
  if (wildCount) strength += wildCount * 2.6 + (wildCount >= 3 ? 2.5 : 0);
  if (groups.has(16) && groups.has(17)) strength += 2.2;
  for (const [rank, cards] of groups) {
    if (rank === laiziRank) continue;
    strength += cards.length * (rank === 17 ? 3.8 : rank === 16 ? 2.7 : rank === 15 ? 1.9 : rank === 14 ? 0.65 : 0);
    if (cards.length === 4) strength += 4.5;
    if (cards.length >= 3 && rank < 14) strength += 0.7;
  }
  if (plannerBudget > 0) {
    const planner = handPlanner(hand, plannerBudget, laiziRank);
    strength += Math.max(0, 7 - planner.cost(hand)) * 1.35;
  }
  return strength;
}

// 评估人机是否对自己的手牌过于自信，主动点击明牌。
export function shouldBotOpenHand(view: BotView, difficulty: Difficulty, random: () => number = Math.random): boolean {
  if (view.phase === 'ended' || view.openSeats?.[view.seat]) return false;
  // 叫分阶段只在刚开局未出牌时，或出牌阶段刚开始前几手时评估
  if (view.phase === 'playing' && (view.playCounts[view.seat] > 1 || view.hand.length < 10)) return false;
  const budget = difficulty === 'easy' ? 0 : difficulty === 'hell' ? 220 : 120;
  const strength = handStrength(view.hand, view.laiziRank ?? null, budget);
  const groups = rankGroups(view.hand);
  const hasRocket = groups.has(16) && groups.has(17);
  const wilds = view.laiziRank !== null ? (groups.get(view.laiziRank)?.length || 0) : 0;
  let bombs = 0;
  for (const [rank, cards] of groups) if (rank !== view.laiziRank && cards.length === 4) bombs++;
  if (wilds >= 4) bombs++;
  // 必须牌力极强（如王炸+大牌、多炸弹、或极少手数）才明牌
  const threshold = view.phase === 'bidding' ? 16.5 : 17.5;
  const superStrong = strength >= threshold || (hasRocket && (bombs >= 1 || wilds >= 2)) || bombs >= 2;
  if (!superStrong) return false;
  const chance = difficulty === 'easy' ? 0.45 : difficulty === 'hard' ? 0.68 : 0.8;
  return random() < chance;
}

function bid(view: BotView, difficulty: Difficulty, random: () => number): Action {
  const budget = difficulty === 'easy' ? 0 : difficulty === 'hell' ? 280 : 120;
  let strength = handStrength(view.hand, view.laiziRank ?? null, budget);
  if (difficulty === 'easy') strength += (random() - 0.5) * 2.5;
  const score = strength >= 13 ? 3 : strength >= 9 ? 2 : strength >= 5.5 ? 1 : 0;
  return { type: 'bid', score: score > view.highestBid ? score : 0 };
}

function scoreMove(view: BotView, move: Play, planner: Planner) {
  if (move.cards.length === view.hand.length) return -10000;
  const left = remaining(view.hand, move);
  const laiziRank = view.laiziRank ?? null;
  let score = planner.cost(left) * 12 - move.cards.length * 0.25;
  score += move.cards.reduce((sum, id) => {
    const r = rankOf(id);
    if (laiziRank !== null && r === laiziRank) return sum + 1.8;
    return sum + Math.max(0, r - 13) * 0.32;
  }, 0);
  if (['bomb', 'rocket'].includes(move.pattern.type)) {
    const bombPenalty = move.pattern.bombKind === 'pure' ? 11 : move.pattern.bombKind === 'soft' ? 6.5 : 8;
    score += urgency(view) ? 0 : bombPenalty;
  }
  const before = rankGroups(view.hand);
  const after = rankGroups(left);
  for (const [rank, cards] of before) {
    if (cards.length === 4 && after.has(rank) && after.get(rank)!.length < 4) score += 4.5;
  }
  if (!view.trick && view.counts.some((count, seat) => count === 1 && !sameSide(seat, view.seat, view.landlordSeat))) {
    if (move.pattern.type === 'single') score += (17 - move.pattern.rank) * 1.8;
    else score -= 3;
  }
  // 场外同点数的大牌越少，越适合用它取得出牌权。
  if (!view.trick && move.pattern.type === 'single' && move.pattern.rank >= 14) {
    const known = new Set([...view.hand, ...view.playedCards.flat()]);
    for (const open of view.openHands || []) if (open) for (const id of open) known.add(id);
    const opponentOpenBigger = (view.openHands || []).some((open, seat) =>
      open && !sameSide(seat, view.seat, view.landlordSeat) && open.some(id => rankOf(id) > move.pattern.rank)
    );
    if (!opponentOpenBigger && !DECK.some(id => !known.has(id) && rankOf(id) > move.pattern.rank)) score -= 2.5;
  }
  return score;
}

export function suggestedPlays(view: BotView, nodeBudget = 180) {
  const laiziRank = view.laiziRank ?? null;
  const planner = handPlanner(view.hand, nodeBudget, laiziRank);
  return planner.plays.filter(move => canBeat(move.pattern, view.trick?.pattern))
    .map(move => ({ ...move, score: scoreMove(view, move, planner) }))
    .sort((a, b) => a.score - b.score || a.pattern.rank - b.pattern.rank);
}

function chooseEasy(view: BotView, random: () => number): Action {
  const moves = legalPlays(view.hand, view.trick?.pattern, view.laiziRank ?? null);
  const finish = moves.find(move => move.cards.length === view.hand.length);
  if (finish) return { type: 'play', cards: finish.cards };
  if (!moves.length || (view.trick && !urgency(view) && random() < 0.12)) return { type: 'pass' };
  moves.sort((a, b) => {
    const cost = (move: Play) => (['bomb', 'rocket'].includes(move.pattern.type) ? 30 : 0) + move.pattern.rank - (!view.trick ? move.cards.length * 1.8 : 0);
    return cost(a) - cost(b);
  });
  const index = random() < 0.18 ? Math.min(moves.length - 1, 2) : 0;
  return { type: 'play', cards: moves[index].cards };
}

// 只能从公开信息抽样：自己的手牌、明牌玩家的公开手牌、公开底牌、牌数和已出的牌。
// 未明牌的对手真实手牌永远不作为 chooseAction 的入参。
export function samplePossibleHands(view: BotView, random: () => number = Math.random) {
  const laiziRank = view.laiziRank ?? null;
  const known = new Set([...view.hand, ...view.playedCards.flat()]);
  const hands: CardId[][] = [[], [], []];
  hands[view.seat] = [...view.hand];
  const openHands = view.openHands || [null, null, null];
  const fixedSeats = new Set<number>([view.seat]);
  for (let seat = 0; seat < 3; seat++) {
    if (seat !== view.seat && openHands[seat]) {
      hands[seat] = [...openHands[seat]!];
      fixedSeats.add(seat);
      for (const id of hands[seat]) known.add(id);
    }
  }
  const unknownSeats = [0, 1, 2].filter(seat => !fixedSeats.has(seat));
  const pool = DECK.filter(id => !known.has(id));
  if (pool.length !== unknownSeats.reduce((sum, seat) => sum + view.counts[seat], 0)) return null;
  const forced = new Set((view.bottom || []).filter(id => !known.has(id)));
  if (view.landlordSeat !== null && !fixedSeats.has(view.landlordSeat)) hands[view.landlordSeat] = [...forced];
  const loose = pool.filter(id => !forced.has(id));
  for (let i = loose.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [loose[i], loose[j]] = [loose[j], loose[i]];
  }
  for (const seat of unknownSeats) {
    const needed = view.counts[seat] - hands[seat].length;
    if (needed < 0) return null;
    hands[seat].push(...loose.splice(0, needed));
    hands[seat] = sortCards(hands[seat], laiziRank);
  }
  return loose.length ? null : hands;
}

function simulationState(view: BotView, hands: CardId[][]): GameState {
  return {
    ...view, hands, seed: 0, mode: view.mode || 'classic', laiziRank: view.laiziRank ?? null,
    seq: view.seq || 0, firstBidder: 0, deal: view.deal || 1,
    highestBidder: view.landlordSeat, openSeats: [...(view.openSeats || [false, false, false])],
    surrenderBy: null, passes: view.passes || 0, history: [],
    tablePlays: view.tablePlays || [null, null, null], bids: view.bids || [0, 0, 0],
    playedCards: view.playedCards.map(cards => [...cards]), playCounts: [...view.playCounts],
    winnerSide: null, winnerSeat: null, spring: false, scores: null
  };
}

function rolloutAction(state: GameState): Action {
  const seat = state.turn;
  const hand = state.hands[seat!];
  const moves = legalPlays(hand, state.trick?.pattern, state.laiziRank);
  const finish = moves.find(move => move.cards.length === hand.length);
  if (finish) return { type: 'play', cards: finish.cards };
  if (!moves.length || (state.trick && sameSide(seat, state.trick.seat, state.landlordSeat))) return { type: 'pass' };
  const danger = state.hands.some((cards, index) => cards.length <= 2 && !sameSide(seat, index, state.landlordSeat));
  moves.sort((a, b) => {
    const cost = (move: Play) => -move.cards.length * 2 + move.pattern.rank * 0.08
      + (['bomb', 'rocket'].includes(move.pattern.type) && !danger ? 12 : 0)
      + (move.pattern.type === 'single' && danger ? (17 - move.pattern.rank) * 0.55 : 0);
    return cost(a) - cost(b);
  });
  if (state.trick && ['bomb', 'rocket'].includes(moves[0].pattern.type) && !danger) return { type: 'pass' };
  return { type: 'play', cards: moves[0].cards };
}

function simulationValue(state: GameState, mySeat: number) {
  const mine = mySeat === state.landlordSeat ? 'landlord' : 'farmers';
  if (state.phase === 'ended') return state.winnerSide === mine ? 1 : -1;
  const landlordLeft = state.hands[state.landlordSeat!].length / 20;
  const farmersLeft = Math.min(...state.hands.filter((_, seat) => seat !== state.landlordSeat).map(cards => cards.length / 17));
  const edge = (farmersLeft - landlordLeft) * 0.8;
  return mine === 'landlord' ? edge : -edge;
}

function chooseHell(view: BotView, ranked: RankedPlay[], preferred: Action, random: () => number, deadline: number): Action {
  const candidates: { action: Action; prior: number; total: number; samples: number }[] = ranked.slice(0, 4).map(move => ({ action: { type: 'play', cards: move.cards }, prior: move.score, total: 0, samples: 0 }));
  if (view.trick) candidates.push({ action: { type: 'pass' }, prior: preferred.type === 'pass' ? ranked[0]?.score || 0 : (ranked[0]?.score || 0) + 6, total: 0, samples: 0 });
  for (let sample = 0; sample < 4; sample++) {
    const hands = samplePossibleHands(view, random);
    if (!hands) break;
    for (const candidate of candidates) {
      if (performance.now() >= deadline) break;
      let result = applyAction(simulationState(view, hands), view.seat, candidate.action);
      if (!result.ok) continue;
      let state = result.state;
      for (let step = 0; step < 36 && state.phase !== 'ended' && performance.now() < deadline; step++) {
        result = applyAction(state, state.turn, rolloutAction(state));
        if (!result.ok) break;
        state = result.state;
      }
      candidate.total += simulationValue(state, view.seat);
      candidate.samples++;
    }
    if (performance.now() >= deadline) break;
  }
  const evaluated = candidates.filter(candidate => candidate.samples);
  if (!evaluated.length) return preferred;
  evaluated.sort((a, b) => (b.total / b.samples - b.prior * 0.008) - (a.total / a.samples - a.prior * 0.008));
  return evaluated[0].action;
}

export function chooseAction(view: BotView, difficulty: string = 'hard', { random = Math.random, thinkMs = 85 }: { random?: () => number; thinkMs?: number } = {}): Action | null {
  const deadline = performance.now() + thinkMs;
  const level = DIFFICULTIES[difficulty as Difficulty] ? difficulty as Difficulty : 'hard';
  if (view.phase === 'bidding') return bid(view, level, random);
  if (view.phase !== 'playing') return null;
  if (level === 'easy') return chooseEasy(view, random);
  const ranked = suggestedPlays(view, level === 'hell' ? 650 : 300);
  const finish = ranked.find(move => move.cards.length === view.hand.length);
  if (finish) return { type: 'play', cards: finish.cards };
  if (!ranked.length) return { type: 'pass' };
  if (view.trick && sameSide(view.seat, view.trick.seat, view.landlordSeat)) return { type: 'pass' };
  let preferred: Action = { type: 'play', cards: ranked[0].cards };
  if (view.trick && !urgency(view)) {
    const current = handPlanner(view.hand, 80, view.laiziRank ?? null).cost(view.hand) * 12 + 4;
    if (ranked[0].score > current) preferred = { type: 'pass' };
  }
  return level === 'hell' ? chooseHell(view, ranked, preferred, random, deadline) : preferred;
}

export function botView(state: GameState, seat: number): BotView { return { ...publicState(state, seat), seat }; }
