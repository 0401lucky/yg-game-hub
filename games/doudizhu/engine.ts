import type { CardId, CardInfo, Pattern, PatternType, Play, GameState, GameEvent, Action, ActionResult, PublicGame, GameMode, BombKind } from './types.ts';
// 斗地主规则在服务端与客户端提示中共用。对手手牌（未明牌）和洗牌种子不进入公开快照。
export const SUITS = [
  { id: 'S', name: 'spade', symbol: '♠', red: false },
  { id: 'H', name: 'heart', symbol: '♥', red: true },
  { id: 'C', name: 'club', symbol: '♣', red: false },
  { id: 'D', name: 'diamond', symbol: '♦', red: true }
];

export const RANK_LABELS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
export const DECK = Object.freeze([
  ...Array.from({ length: 13 }, (_, i) => SUITS.map(suit => `${suit.id}${i + 3}`)).flat(),
  'BJ', 'RJ'
]);
const cardsById: Map<CardId, CardInfo> = new Map(DECK.map(id => {
  if (id === 'BJ' || id === 'RJ') {
    const rank = id === 'BJ' ? 16 : 17;
    return [id, Object.freeze({ id, rank, label: RANK_LABELS[rank], suit: 'joker', symbol: '✦', red: rank === 17 })];
  }
  const suit = SUITS.find(item => item.id === id[0])!;
  const rank = Number(id.slice(1));
  return [id, Object.freeze({ id, rank, label: RANK_LABELS[rank] || String(rank), suit: suit.name, symbol: suit.symbol, red: suit.red })];
}));

export function cardInfo(id: CardId) { return cardsById.get(id) || null; }
export function rankOf(id: CardId) { return cardInfo(id)?.rank ?? -1; }
export function rankLabel(rank: number) { return RANK_LABELS[rank] || String(rank); }
export function sortCards(cards: readonly CardId[], laiziRank: number | null = null) {
  return [...cards].sort((a, b) => {
    const aWild = laiziRank !== null && rankOf(a) === laiziRank ? 1 : 0;
    const bWild = laiziRank !== null && rankOf(b) === laiziRank ? 1 : 0;
    return bWild - aWild || rankOf(b) - rankOf(a) || DECK.indexOf(a) - DECK.indexOf(b);
  });
}
export function rankGroups(cards: readonly CardId[]) {
  const groups: Map<number, CardId[]> = new Map();
  for (const id of sortCards(cards)) {
    const rank = rankOf(id);
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank)!.push(id);
  }
  return groups;
}

export function seededRandom(seed: number) {
  let value = Number(seed) >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(seed: number) {
  const deck = [...DECK];
  const random = seededRandom(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function pickLaiziRank(seed: number, deal: number) {
  const random = seededRandom((seed ^ Math.imul(deal + 1, 0x9E3779B1)) >>> 0);
  return 3 + Math.floor(random() * 13);
}

const labels: Record<PatternType, string> = {
  single: '单张', pair: '对子', triple: '三张', tripleSingle: '三带一', triplePair: '三带二',
  straight: '顺子', pairStraight: '连对', airplane: '飞机', airplaneSingle: '飞机带单',
  airplanePair: '飞机带对', fourSingles: '四带二', fourPairs: '四带两对', bomb: '炸弹', rocket: '王炸'
};
const bombLabels: Record<BombKind, string> = { soft: '软炸弹', hard: '炸弹', pure: '纯癞子炸弹' };
const bombPower: Record<BombKind, number> = { soft: 1, hard: 2, pure: 3 };
const patternPriority: Record<PatternType, number> = {
  rocket: 14, bomb: 13, airplanePair: 12, airplaneSingle: 11, airplane: 10,
  pairStraight: 9, straight: 8, fourPairs: 7, fourSingles: 6, triplePair: 5,
  tripleSingle: 4, triple: 3, pair: 2, single: 1
};

function makePattern(type: PatternType, rank: number, size: number, chain = 1, bombKind?: BombKind): Pattern {
  const label = type === 'bomb' && bombKind ? bombLabels[bombKind] : labels[type];
  return bombKind ? { type, label, rank, size, chain, bombKind } : { type, label, rank, size, chain };
}
function consecutive(ranks: number[]) {
  return ranks.length > 0 && ranks.at(-1)! <= 14 && ranks.every((rank, i) => !i || rank === ranks[i - 1] + 1);
}

function classifyClassic(cards: CardId[]): Pattern | null {
  const groups: Map<number, CardId[]> = rankGroups(cards);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const counts = ranks.map(rank => groups.get(rank)!.length);
  const n = cards.length;
  const main = (amount: number) => ranks.find(rank => groups.get(rank)!.length === amount);
  if (n === 2 && ranks[0] === 16 && ranks[1] === 17) return makePattern('rocket', 17, n);
  if (ranks.length === 1) {
    if (n === 4) return makePattern('bomb', ranks[0], n, 1, 'hard');
    return n <= 3 ? makePattern((['', 'single', 'pair', 'triple'][n] as PatternType), ranks[0], n) : null;
  }
  if (n === 4 && main(3) !== undefined) return makePattern('tripleSingle', main(3)!, n);
  if (n === 5 && main(3) !== undefined && main(2) !== undefined) return makePattern('triplePair', main(3)!, n);
  if (n >= 5 && counts.every(count => count === 1) && consecutive(ranks)) return makePattern('straight', ranks.at(-1)!, n, n);
  if (n >= 6 && counts.every(count => count === 2) && consecutive(ranks)) return makePattern('pairStraight', ranks.at(-1)!, n, n / 2);
  if (n >= 6 && counts.every(count => count === 3) && consecutive(ranks)) return makePattern('airplane', ranks.at(-1)!, n, n / 3);
  if (n === 6 && main(4) !== undefined) return makePattern('fourSingles', main(4)!, n);
  if (n === 8 && main(4) !== undefined && counts.filter(count => count === 2).length === 2) return makePattern('fourPairs', main(4)!, n);

  for (const [type, divisor] of ([['airplaneSingle', 4], ['airplanePair', 5]] as const)) {
    const length = n / divisor;
    if (!Number.isInteger(length) || length < 2) continue;
    for (let start = 3; start + length - 1 <= 14; start++) {
      const body = Array.from({ length }, (_, i) => start + i);
      if (!body.every(rank => groups.get(rank)?.length === 3)) continue;
      const wings = ranks.filter(rank => !body.includes(rank)).map(rank => groups.get(rank)!.length);
      // 单翅膀允许对子，但不把三张/炸弹当作翅膀，且不能混入机身点数。
      const valid = type === 'airplaneSingle'
        ? wings.every(count => count <= 2) && wings.reduce((sum, count) => sum + count, 0) === length
        : wings.length === length && wings.every(count => count === 2);
      if (valid) return makePattern(type, body.at(-1)!, n, length);
    }
  }
  return null;
}

function comparePatterns(a: Pattern, b: Pattern) {
  if (a.type !== b.type) return patternPriority[b.type] - patternPriority[a.type];
  if (a.type === 'bomb' && b.type === 'bomb') {
    const diff = bombPower[b.bombKind || 'hard'] - bombPower[a.bombKind || 'hard'];
    if (diff) return diff;
  }
  return b.rank - a.rank;
}

// 给定一组牌与癞子点数，返回所有可合法解释成的牌型（已按强弱去重排序）。
export function classifyAll(cards: CardId[], laiziRank: number | null = null): Pattern[] {
  if (!Array.isArray(cards) || !cards.length || new Set(cards).size !== cards.length || cards.some(id => !cardInfo(id))) return [];
  if (laiziRank === null) {
    const one = classifyClassic(cards);
    return one ? [one] : [];
  }
  const n = cards.length;
  const fixedCounts = Array(18).fill(0);
  let wilds = 0;
  for (const id of cards) {
    const r = rankOf(id);
    if (r === laiziRank) wilds++;
    else fixedCounts[r]++;
  }
  if (!wilds) {
    const one = classifyClassic(cards);
    return one ? [one] : [];
  }
  const hasJoker = fixedCounts[16] > 0 || fixedCounts[17] > 0;
  const fixedRanks: number[] = [];
  for (let r = 3; r <= 17; r++) if (fixedCounts[r] > 0) fixedRanks.push(r);

  const found = new Map<string, Pattern>();
  const add = (p: Pattern) => {
    const key = `${p.type}:${p.rank}:${p.size}:${p.chain}:${p.bombKind || ''}`;
    if (!found.has(key)) found.set(key, p);
  };

  // 单张（全为癞子时即本点数）
  if (n === 1) {
    add(makePattern('single', laiziRank, 1));
    return [...found.values()];
  }
  // 对子、三张、炸弹（癞子不可当王）
  if (n >= 2 && n <= 4 && !hasJoker) {
    if (fixedRanks.length === 0) {
      if (n === 2) add(makePattern('pair', laiziRank, 2));
      else if (n === 3) add(makePattern('triple', laiziRank, 3));
      else if (n === 4) add(makePattern('bomb', laiziRank, 4, 1, 'pure'));
    } else if (fixedRanks.length === 1) {
      const r = fixedRanks[0];
      if (n === 2) add(makePattern('pair', r, 2));
      else if (n === 3) add(makePattern('triple', r, 3));
      else if (n === 4) add(makePattern('bomb', r, 4, 1, 'soft'));
    }
  }
  // 三带一
  if (n === 4) {
    for (let mainRank = 3; mainRank <= 15; mainRank++) {
      const needMain = 3 - fixedCounts[mainRank];
      if (needMain < 0 || needMain > wilds) continue;
      const leftWild = wilds - needMain;
      const otherSum = n - wilds - fixedCounts[mainRank];
      if (otherSum + leftWild === 1) {
        // 避免全 4 张凑成相同点数（那应为炸弹，但三带一翅膀不同点数）
        if (otherSum === 0 && leftWild === 1) {
          // 剩 1 癞子可当任意不同单牌
          add(makePattern('tripleSingle', mainRank, 4));
        } else if (otherSum === 1 && leftWild === 0) {
          add(makePattern('tripleSingle', mainRank, 4));
        }
      }
    }
  }
  // 三带一对
  if (n === 5 && !hasJoker) {
    for (let mainRank = 3; mainRank <= 15; mainRank++) {
      const needMain = 3 - fixedCounts[mainRank];
      if (needMain < 0 || needMain > wilds) continue;
      const leftWild = wilds - needMain;
      const otherRanks = fixedRanks.filter(r => r !== mainRank);
      if (otherRanks.length === 0 && leftWild === 2) add(makePattern('triplePair', mainRank, 5));
      else if (otherRanks.length === 1 && fixedCounts[otherRanks[0]] + leftWild === 2) add(makePattern('triplePair', mainRank, 5));
    }
  }
  // 顺子、连对、飞机机身
  if (!hasJoker && fixedCounts[15] === 0) {
    const seqSpecs: [PatternType, number, number][] = [['straight', 1, 5], ['pairStraight', 2, 3], ['airplane', 3, 2]];
    for (const [type, copies, minLen] of seqSpecs) {
      if (n % copies !== 0) continue;
      const len = n / copies;
      if (len < minLen || len > 12) continue;
      for (let start = 3; start + len - 1 <= 14; start++) {
        const end = start + len - 1;
        let ok = true;
        for (const r of fixedRanks) if (r < start || r > end || fixedCounts[r] > copies) { ok = false; break; }
        if (!ok) continue;
        let need = 0;
        for (let r = start; r <= end; r++) need += copies - fixedCounts[r];
        if (need === wilds) add(makePattern(type, end, n, len));
      }
    }
  }
  // 四带二单
  if (n === 6) {
    for (let mainRank = 3; mainRank <= 15; mainRank++) {
      const needMain = 4 - fixedCounts[mainRank];
      if (needMain < 0 || needMain > wilds) continue;
      const leftWild = wilds - needMain;
      const otherSum = n - wilds - fixedCounts[mainRank];
      if (otherSum + leftWild === 2) add(makePattern('fourSingles', mainRank, 6));
    }
  }
  // 四带两对
  if (n === 8 && !hasJoker) {
    for (let mainRank = 3; mainRank <= 15; mainRank++) {
      const needMain = 4 - fixedCounts[mainRank];
      if (needMain < 0 || needMain > wilds) continue;
      const leftWild = wilds - needMain;
      const otherRanks = fixedRanks.filter(r => r !== mainRank);
      if (otherRanks.length > 2 || otherRanks.some(r => fixedCounts[r] > 2)) continue;
      const oddNeed = otherRanks.reduce((sum, r) => sum + (2 - fixedCounts[r]), 0);
      const extraPairs = 2 - otherRanks.length;
      if (oddNeed + extraPairs * 2 === leftWild) add(makePattern('fourPairs', mainRank, 8));
    }
  }
  // 飞机带单 / 飞机带对
  for (const [type, divisor] of ([['airplaneSingle', 4], ['airplanePair', 5]] as const)) {
    const len = n / divisor;
    if (!Number.isInteger(len) || len < 2 || len > 6) continue;
    if (type === 'airplanePair' && hasJoker) continue;
    for (let start = 3; start + len - 1 <= 14; start++) {
      const end = start + len - 1;
      let needBody = 0;
      let bodyOk = true;
      for (let r = start; r <= end; r++) {
        if (fixedCounts[r] > 3) { bodyOk = false; break; }
        needBody += 3 - fixedCounts[r];
      }
      if (!bodyOk || needBody > wilds) continue;
      const leftWild = wilds - needBody;
      const wingRanks = fixedRanks.filter(r => r < start || r > end);
      if (type === 'airplaneSingle') {
        if (wingRanks.some(r => fixedCounts[r] > 2)) continue;
        const wingCards = wingRanks.reduce((sum, r) => sum + fixedCounts[r], 0);
        if (wingCards + leftWild === len) add(makePattern(type, end, n, len));
      } else {
        if (wingRanks.length > len || wingRanks.some(r => fixedCounts[r] > 2)) continue;
        const needToPair = wingRanks.reduce((sum, r) => sum + (2 - fixedCounts[r]), 0);
        const missingPairs = len - wingRanks.length;
        if (needToPair + missingPairs * 2 === leftWild) add(makePattern(type, end, n, len));
      }
    }
  }

  return [...found.values()].sort(comparePatterns);
}

export function classify(cards: CardId[], laiziRank: number | null = null, target: Pattern | null | undefined = null): Pattern | null {
  const candidates = classifyAll(cards, laiziRank);
  if (!candidates.length) return null;
  if (target) {
    const beating = candidates.filter(candidate => canBeat(candidate, target));
    if (beating.length) return beating[0];
  }
  return candidates[0];
}

export function canBeat(play: Pattern | null, target: Pattern | null | undefined) {
  if (!play) return false;
  if (!target) return true;
  if (target.type === 'rocket') return false;
  if (play.type === 'rocket') return true;
  if (play.type === 'bomb') {
    if (target.type !== 'bomb') return true;
    const playPower = bombPower[play.bombKind || 'hard'];
    const targetPower = bombPower[target.bombKind || 'hard'];
    if (playPower !== targetPower) return playPower > targetPower;
    return play.rank > target.rank;
  }
  return play.type === target.type && play.size === target.size && play.chain === target.chain && play.rank > target.rank;
}

function chooseRanks(items: number[], amount: number, visit: (items: number[]) => void, start = 0, picked: number[] = []) {
  if (!amount) { visit(picked); return; }
  for (let i = start; i <= items.length - amount; i++) chooseRanks(items, amount - 1, visit, i + 1, [...picked, items[i]]);
}
function chooseSingles(groups: Map<number, CardId[]>, amount: number, visit: (items: CardId[]) => void) {
  const entries = [...groups.entries()];
  function walk(index: number, left: number, picked: CardId[]) {
    if (!left) { visit(picked); return; }
    if (index >= entries.length) return;
    const [, cards] = entries[index];
    for (let take = Math.min(2, cards.length, left); take >= 0; take--) {
      walk(index + 1, left - take, [...picked, ...cards.slice(0, take)]);
    }
  }
  walk(0, amount, []);
}

export function legalPlays(hand: CardId[], target: Pattern | null | undefined = null, laiziRank: number | null = null) {
  const groups: Map<number, CardId[]> = rankGroups(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const plays: Play[] = [];
  const seen = new Set<string>();
  function add(cards: CardId[]) {
    const value = classify(cards, laiziRank, target);
    if (!canBeat(value, target)) return;
    const sorted = sortCards(cards, laiziRank);
    const key = [...sorted].sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    plays.push({ cards: sorted, pattern: value! });
  }
  for (const rank of ranks) {
    const group = groups.get(rank)!;
    for (let count = 1; count <= Math.min(4, group.length); count++) add(group.slice(0, count));
    if (group.length >= 3) {
      for (const other of ranks.filter(item => item !== rank)) {
        add([...group.slice(0, 3), groups.get(other)![0]]);
        if (groups.get(other)!.length >= 2) add([...group.slice(0, 3), ...groups.get(other)!.slice(0, 2)]);
      }
    }
    if (group.length === 4) {
      const rest = new Map([...groups].filter(([item]) => item !== rank));
      chooseSingles(rest, 2, wings => add([...group, ...wings]));
      chooseRanks([...rest.keys()].filter(item => rest.get(item)!.length >= 2), 2, wingRanks => {
        add([...group, ...wingRanks.flatMap(item => rest.get(item)!.slice(0, 2))]);
      });
    }
  }
  if (groups.has(16) && groups.has(17)) add([groups.get(16)![0], groups.get(17)![0]]);

  for (const [copies, minimum] of [[1, 5], [2, 3], [3, 2]]) {
    for (let start = 3; start <= 14; start++) {
      const body: number[] = [];
      for (let end = start; end <= 14 && (groups.get(end)?.length || 0) >= copies; end++) {
        body.push(end);
        if (body.length < minimum) continue;
        const core = body.flatMap(rank => groups.get(rank)!.slice(0, copies));
        add(core);
        if (copies !== 3) continue;
        const rest = new Map([...groups].filter(([rank]) => !body.includes(rank)));
        if (core.length + body.length <= hand.length) chooseSingles(rest, body.length, wings => add([...core, ...wings]));
        if (core.length + body.length * 2 <= hand.length) {
          chooseRanks([...rest.keys()].filter(rank => rest.get(rank)!.length >= 2), body.length, wingRanks => {
            add([...core, ...wingRanks.flatMap(rank => rest.get(rank)!.slice(0, 2))]);
          });
        }
      }
    }
  }

  // 癞子补充枚举：用手里 1~4 张癞子配出软炸弹、补齐对/三张/三带/顺子/连对/飞机。
  const wildCards = laiziRank !== null ? (groups.get(laiziRank) || []) : [];
  if (wildCards.length > 0 && laiziRank !== null) {
    const nonWildRanks = ranks.filter(r => r !== laiziRank);
    const nonWildNonJoker = nonWildRanks.filter(r => r <= 15);
    const nonWildGroups = new Map([...groups].filter(([r]) => r !== laiziRank));
    const singlePickers = nonWildRanks.map(r => groups.get(r)![0]);
    const pairPickers = nonWildNonJoker.filter(r => groups.get(r)!.length >= 2).map(r => groups.get(r)!.slice(0, 2));

    // 对子、三张、软炸弹、三带一、三带二、四带二
    for (const r of nonWildNonJoker) {
      const g = groups.get(r)!;
      for (let w = 1; w <= wildCards.length; w++) {
        const wSlice = wildCards.slice(0, w);
        const maxTake = Math.min(g.length, 4 - w);
        for (let take = 1; take <= maxTake; take++) {
          const total = take + w;
          const base = [...g.slice(0, take), ...wSlice];
          if (total >= 2 && total <= 4) add(base);
          if (total === 3) {
            for (const single of singlePickers) if (rankOf(single) !== r) add([...base, single]);
            for (const pair of pairPickers) if (rankOf(pair[0]) !== r) add([...base, ...pair]);
            // 用多余癞子配对作三带二翅膀
            if (w + 1 <= wildCards.length) {
              for (const single of nonWildNonJoker) {
                if (single !== r) add([...base, groups.get(single)![0], wildCards[w]]);
              }
            }
          }
          if (total === 4 && (!target || target.type === 'fourSingles' || target.type === 'fourPairs')) {
            const rest = new Map([...nonWildGroups].filter(([item]) => item !== r));
            chooseSingles(rest, 2, wings => add([...base, ...wings]));
            chooseRanks([...rest.keys()].filter(item => rest.get(item)!.length >= 2), 2, wingRanks => {
              add([...base, ...wingRanks.flatMap(item => rest.get(item)!.slice(0, 2))]);
            });
          }
        }
      }
    }
    // 纯癞子做三张时带非癞子牌
    if (wildCards.length >= 3) {
      const pureTriple = wildCards.slice(0, 3);
      for (const single of singlePickers) add([...pureTriple, single]);
      for (const pair of pairPickers) add([...pureTriple, ...pair]);
    }
    // 顺子 / 连对 / 飞机补缺
    for (const [copies, minimum] of [[1, 5], [2, 3], [3, 2]]) {
      const maxLen = Math.min(12, Math.floor(hand.length / copies));
      for (let start = 3; start <= 14; start++) {
        let missing = 0;
        const pickedFixed: CardId[] = [];
        for (let end = start; end <= 14; end++) {
          const len = end - start + 1;
          if (len > maxLen) break;
          const g = end === laiziRank ? [] : (groups.get(end) || []);
          const take = Math.min(g.length, copies);
          missing += copies - take;
          if (missing > wildCards.length) break;
          pickedFixed.push(...g.slice(0, take));
          if (len < minimum || missing === 0) continue;
          const core = [...pickedFixed, ...wildCards.slice(0, missing)];
          add(core);
          if (copies !== 3) continue;
          const bodySet = new Set(Array.from({ length: len }, (_, i) => start + i));
          const rest = new Map([...nonWildGroups].filter(([r]) => !bodySet.has(r)));
          const restWilds = wildCards.slice(missing);
          if (core.length + len <= hand.length) {
            chooseSingles(rest, len, wings => add([...core, ...wings]));
            if (restWilds.length > 0 && len > 1) {
              for (let extraW = 1; extraW <= Math.min(restWilds.length, len); extraW++) {
                chooseSingles(rest, len - extraW, wings => add([...core, ...wings, ...restWilds.slice(0, extraW)]));
              }
            }
          }
          if (core.length + len * 2 <= hand.length) {
            chooseRanks([...rest.keys()].filter(r => r <= 15 && rest.get(r)!.length >= 2), len, wingRanks => {
              add([...core, ...wingRanks.flatMap(r => rest.get(r)!.slice(0, 2))]);
            });
          }
        }
      }
    }
  }
  return plays;
}

export function createGame({ seed = Date.now(), firstBidder = 0, deal = 1, seq = 0, mode = 'classic' }: { seed?: number; firstBidder?: number; deal?: number; seq?: number; mode?: GameMode } = {}): GameState {
  const deck = shuffled(seed);
  const laiziRank = mode === 'laizi' ? pickLaiziRank(seed, deal) : null;
  return {
    seed: Number(seed) >>> 0, mode, laiziRank, firstBidder, deal, seq, phase: 'bidding', turn: firstBidder,
    hands: [0, 1, 2].map(seat => sortCards(deck.slice(seat * 17, seat * 17 + 17), laiziRank)), bottom: deck.slice(51),
    bids: [-1, -1, -1], highestBid: 0, highestBidder: null, landlordSeat: null,
    multiplier: 1, openSeats: [false, false, false], surrenderBy: null,
    trick: null, passes: 0, tablePlays: [null, null, null],
    playedCards: [[], [], []], playCounts: [0, 0, 0], history: [], lastAction: { type: 'deal', id: seq },
    winnerSide: null, winnerSeat: null, spring: false, scores: null
  };
}

function fail(code: string, reason: string): Extract<ActionResult, { ok: false }> { return { ok: false, code, reason }; }

function finalizeScores(state: GameState) {
  const base = Math.max(1, state.highestBid) * state.multiplier;
  state.scores = [0, 1, 2].map(index => {
    const landlord = index === state.landlordSeat;
    const won = landlord === (state.winnerSide === 'landlord');
    return (landlord ? 2 : 1) * base * (won ? 1 : -1);
  });
}

export function applyOpenHand(state: GameState, seat: number | null): ActionResult {
  if (!state || state.phase === 'ended') return fail('ended', '这局已经结束了');
  if (seat === null || !Number.isInteger(seat) || seat < 0 || seat > 2) return fail('invalidSeat', '无效的座位');
  if (state.openSeats[seat]) return fail('alreadyOpen', '已经明牌了');
  const next: GameState = {
    ...state, seq: state.seq + 1, openSeats: [...state.openSeats],
    multiplier: state.multiplier * 2, history: [...state.history]
  };
  next.openSeats[seat] = true;
  const event: GameEvent = { type: 'openHand', seat, id: next.seq };
  next.lastAction = event;
  next.history.push(event);
  return { ok: true, state: next };
}

export function applySurrender(state: GameState, seat: number | null): ActionResult {
  if (!state || state.phase === 'ended') return fail('ended', '这局已经结束了');
  if (state.phase !== 'playing' || state.landlordSeat === null) return fail('notPlaying', '叫分阶段不能投降，等确定地主后再决定');
  if (seat === null || !Number.isInteger(seat) || seat < 0 || seat > 2) return fail('invalidSeat', '无效的座位');
  const next: GameState = {
    ...state, seq: state.seq + 1, phase: 'ended', turn: null,
    surrenderBy: seat, spring: false, history: [...state.history]
  };
  const side: 'landlord' | 'farmers' = seat === state.landlordSeat ? 'landlord' : 'farmers';
  next.winnerSide = side === 'landlord' ? 'farmers' : 'landlord';
  next.winnerSeat = next.winnerSide === 'landlord' ? state.landlordSeat : [0, 1, 2].find(index => index !== state.landlordSeat)!;
  finalizeScores(next);
  const event: GameEvent = { type: 'surrender', seat, side, id: next.seq };
  next.lastAction = event;
  next.history.push(event);
  return { ok: true, state: next };
}

export function applyAction(state: GameState, seat: number | null, action: Action | null): ActionResult {
  if (!state || state.phase === 'ended') return fail('ended', '这局已经结束了');
  if (seat === null || !Number.isInteger(seat) || seat !== state.turn) return fail('notYourTurn', '还没有轮到你');
  if (!action || typeof action.type !== 'string') return fail('invalidAction', '无效的操作');
  const next: GameState = {
    ...state, seq: state.seq + 1, hands: state.hands.map(hand => [...hand]), bids: [...state.bids],
    openSeats: [...state.openSeats], tablePlays: [...state.tablePlays],
    playedCards: state.playedCards.map(cards => [...cards]),
    playCounts: [...state.playCounts], history: [...state.history]
  };
  let event: GameEvent;
  if (state.phase === 'bidding') {
    if (action.type !== 'bid') return fail('invalidBid', '请选择不叫、1 分、2 分或 3 分');
    const score = action.score;
    if (!Number.isInteger(score) || score < 0 || score > 3) return fail('invalidBid', '请选择不叫、1 分、2 分或 3 分');
    if (score && score <= state.highestBid) return fail('bidTooLow', '叫分需要高于当前分数');
    next.bids[seat] = score;
    if (score) { next.highestBid = score; next.highestBidder = seat; }
    event = { type: 'bid', seat, score };
    if (score === 3 || next.bids.every(value => value >= 0)) {
      if (!next.highestBid) {
        const redealt = createGame({ seed: (state.seed + 0x9E3779B9) >>> 0, firstBidder: (state.firstBidder + 1) % 3, deal: state.deal + 1, seq: next.seq, mode: state.mode });
        redealt.lastAction = { type: 'redeal', id: next.seq };
        return { ok: true, state: redealt };
      }
      next.landlordSeat = next.highestBidder;
      next.hands[next.landlordSeat!] = sortCards([...next.hands[next.landlordSeat!], ...next.bottom], next.laiziRank);
      next.phase = 'playing';
      next.turn = next.landlordSeat!;
      event = { ...event, type: 'landlord', landlordSeat: next.landlordSeat!, score: next.highestBid };
    } else next.turn = (seat + 1) % 3;
  } else if (action.type === 'pass') {
    if (!state.trick) return fail('mustLead', '这一轮由你领出，不能不出');
    next.passes++;
    next.tablePlays[seat] = { pass: true };
    event = { type: 'pass', seat };
    next.turn = (seat + 1) % 3;
    if (next.passes === 2) {
      next.turn = state.trick.seat;
      next.trick = null;
      next.passes = 0;
      event.resetTrick = true;
    }
  } else if (action.type === 'play') {
    const selected = action.cards;
    if (!Array.isArray(selected) || !selected.length || selected.length > 20 || new Set(selected).size !== selected.length || selected.some(id => !state.hands[seat!].includes(id))) return fail('notOwned', '请选择自己手里的牌');
    const value = classify(selected, state.laiziRank, state.trick?.pattern);
    if (!value) return fail('invalidPattern', '这些牌不能组成一种有效牌型');
    if (!canBeat(value, state.trick?.pattern)) return fail('tooSmall', '需要相同牌型且更大的点数，或使用炸弹 / 王炸');
    const cards = sortCards(selected, state.laiziRank);
    if (!state.trick) next.tablePlays = [null, null, null];
    next.hands[seat] = next.hands[seat].filter(id => !selected.includes(id));
    next.playedCards[seat].push(...cards);
    next.playCounts[seat]++;
    next.trick = { seat, cards, pattern: value };
    next.tablePlays[seat] = { cards, pattern: value };
    next.passes = 0;
    next.turn = (seat + 1) % 3;
    if (value.type === 'bomb' || value.type === 'rocket') next.multiplier *= 2;
    event = { type: 'play', seat, cards, pattern: value };
    if (!next.hands[seat].length) {
      next.phase = 'ended';
      next.turn = null;
      next.winnerSeat = seat;
      next.winnerSide = seat === next.landlordSeat ? 'landlord' : 'farmers';
      next.spring = next.winnerSide === 'landlord'
        ? next.playCounts.every((count, index) => index === next.landlordSeat || count === 0)
        : next.playCounts[next.landlordSeat!] === 1;
      if (next.spring) next.multiplier *= 2;
      finalizeScores(next);
      event.ended = true;
      event.spring = next.spring;
    }
  } else return fail('invalidAction', '当前阶段不能执行这个操作');
  event.id = next.seq;
  next.lastAction = event;
  next.history.push(event);
  return { ok: true, state: next };
}

export function publicState(state: GameState, seat: number): PublicGame {
  return {
    seq: state.seq, mode: state.mode, laiziRank: state.laiziRank, deal: state.deal, phase: state.phase, turn: state.turn,
    hand: Number.isInteger(seat) ? [...state.hands[seat!]] : [], counts: state.hands.map(hand => hand.length),
    openSeats: [...state.openSeats],
    openHands: state.hands.map((hand, index) => state.openSeats[index] ? [...hand] : null),
    surrenderBy: state.surrenderBy,
    bottom: state.phase === 'bidding' ? [] : [...state.bottom], bids: [...state.bids],
    highestBid: state.highestBid, landlordSeat: state.landlordSeat, multiplier: state.multiplier,
    trick: state.trick, passes: state.passes, tablePlays: state.tablePlays, playedCards: state.playedCards,
    playCounts: state.playCounts, history: state.history, lastAction: state.lastAction,
    winnerSide: state.winnerSide, winnerSeat: state.winnerSeat, spring: state.spring, scores: state.scores,
    ...(state.phase === 'ended' ? { revealedHands: state.hands.map(hand => [...hand]) } : {})
  };
}
