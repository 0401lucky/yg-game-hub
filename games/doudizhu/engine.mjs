// 斗地主规则在服务端与客户端提示中共用。对手手牌和洗牌种子不进入公开快照。
export const SUITS = [
  { id: 'S', name: 'spade', symbol: '♠', red: false },
  { id: 'H', name: 'heart', symbol: '♥', red: true },
  { id: 'C', name: 'club', symbol: '♣', red: false },
  { id: 'D', name: 'diamond', symbol: '♦', red: true }
];

export const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
export const DECK = Object.freeze([
  ...Array.from({ length: 13 }, (_, i) => SUITS.map(suit => `${suit.id}${i + 3}`)).flat(),
  'BJ', 'RJ'
]);
const cardsById = new Map(DECK.map(id => {
  if (id === 'BJ' || id === 'RJ') {
    const rank = id === 'BJ' ? 16 : 17;
    return [id, Object.freeze({ id, rank, label: RANK_LABELS[rank], suit: 'joker', symbol: '✦', red: rank === 17 })];
  }
  const suit = SUITS.find(item => item.id === id[0]);
  const rank = Number(id.slice(1));
  return [id, Object.freeze({ id, rank, label: RANK_LABELS[rank] || String(rank), suit: suit.name, symbol: suit.symbol, red: suit.red })];
}));

export function cardInfo(id) { return cardsById.get(id) || null; }
export function rankOf(id) { return cardInfo(id)?.rank ?? -1; }
export function sortCards(cards) {
  return [...cards].sort((a, b) => rankOf(b) - rankOf(a) || DECK.indexOf(a) - DECK.indexOf(b));
}
export function rankGroups(cards) {
  const groups = new Map();
  for (const id of sortCards(cards)) {
    const rank = rankOf(id);
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank).push(id);
  }
  return groups;
}

export function seededRandom(seed) {
  let value = Number(seed) >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(seed) {
  const deck = [...DECK];
  const random = seededRandom(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const labels = {
  single: '单张', pair: '对子', triple: '三张', tripleSingle: '三带一', triplePair: '三带二',
  straight: '顺子', pairStraight: '连对', airplane: '飞机', airplaneSingle: '飞机带单',
  airplanePair: '飞机带对', fourSingles: '四带二', fourPairs: '四带两对', bomb: '炸弹', rocket: '王炸'
};
function pattern(type, rank, size, chain = 1) { return { type, label: labels[type], rank, size, chain }; }
function consecutive(ranks) {
  return ranks.length > 0 && ranks.at(-1) <= 14 && ranks.every((rank, i) => !i || rank === ranks[i - 1] + 1);
}

export function classify(cards) {
  if (!Array.isArray(cards) || !cards.length || new Set(cards).size !== cards.length || cards.some(id => !cardInfo(id))) return null;
  const groups = rankGroups(cards);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const counts = ranks.map(rank => groups.get(rank).length);
  const n = cards.length;
  const main = amount => ranks.find(rank => groups.get(rank).length === amount);
  if (n === 2 && ranks[0] === 16 && ranks[1] === 17) return pattern('rocket', 17, n);
  if (ranks.length === 1) {
    return n <= 4 ? pattern(['', 'single', 'pair', 'triple', 'bomb'][n], ranks[0], n) : null;
  }
  if (n === 4 && main(3) !== undefined) return pattern('tripleSingle', main(3), n);
  if (n === 5 && main(3) !== undefined && main(2) !== undefined) return pattern('triplePair', main(3), n);
  if (n >= 5 && counts.every(count => count === 1) && consecutive(ranks)) return pattern('straight', ranks.at(-1), n, n);
  if (n >= 6 && counts.every(count => count === 2) && consecutive(ranks)) return pattern('pairStraight', ranks.at(-1), n, n / 2);
  if (n >= 6 && counts.every(count => count === 3) && consecutive(ranks)) return pattern('airplane', ranks.at(-1), n, n / 3);
  if (n === 6 && main(4) !== undefined) return pattern('fourSingles', main(4), n);
  if (n === 8 && main(4) !== undefined && counts.filter(count => count === 2).length === 2) return pattern('fourPairs', main(4), n);

  for (const [type, divisor] of [['airplaneSingle', 4], ['airplanePair', 5]]) {
    const length = n / divisor;
    if (!Number.isInteger(length) || length < 2) continue;
    for (let start = 3; start + length - 1 <= 14; start++) {
      const body = Array.from({ length }, (_, i) => start + i);
      if (!body.every(rank => groups.get(rank)?.length === 3)) continue;
      const wings = ranks.filter(rank => !body.includes(rank)).map(rank => groups.get(rank).length);
      // 单翅膀允许对子，但不把三张/炸弹当作翅膀，且不能混入机身点数。
      const valid = type === 'airplaneSingle'
        ? wings.every(count => count <= 2) && wings.reduce((sum, count) => sum + count, 0) === length
        : wings.length === length && wings.every(count => count === 2);
      if (valid) return pattern(type, body.at(-1), n, length);
    }
  }
  return null;
}

export function canBeat(play, target) {
  if (!play) return false;
  if (!target) return true;
  if (target.type === 'rocket') return false;
  if (play.type === 'rocket') return true;
  if (play.type === 'bomb' && target.type !== 'bomb') return true;
  return play.type === target.type && play.size === target.size && play.chain === target.chain && play.rank > target.rank;
}

function chooseRanks(items, amount, visit, start = 0, picked = []) {
  if (!amount) { visit(picked); return; }
  for (let i = start; i <= items.length - amount; i++) chooseRanks(items, amount - 1, visit, i + 1, [...picked, items[i]]);
}
function chooseSingles(groups, amount, visit) {
  const entries = [...groups.entries()];
  function walk(index, left, picked) {
    if (!left) { visit(picked); return; }
    if (index >= entries.length) return;
    const [, cards] = entries[index];
    for (let take = Math.min(2, cards.length, left); take >= 0; take--) {
      walk(index + 1, left - take, [...picked, ...cards.slice(0, take)]);
    }
  }
  walk(0, amount, []);
}

export function legalPlays(hand, target = null) {
  const groups = rankGroups(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const plays = [];
  const seen = new Set();
  function add(cards) {
    const value = classify(cards);
    if (!canBeat(value, target)) return;
    const sorted = sortCards(cards);
    const key = [...sorted].sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    plays.push({ cards: sorted, pattern: value });
  }
  for (const rank of ranks) {
    const group = groups.get(rank);
    for (let count = 1; count <= Math.min(4, group.length); count++) add(group.slice(0, count));
    if (group.length >= 3) {
      for (const other of ranks.filter(item => item !== rank)) {
        add([...group.slice(0, 3), groups.get(other)[0]]);
        if (groups.get(other).length >= 2) add([...group.slice(0, 3), ...groups.get(other).slice(0, 2)]);
      }
    }
    if (group.length === 4) {
      const rest = new Map([...groups].filter(([item]) => item !== rank));
      chooseSingles(rest, 2, wings => add([...group, ...wings]));
      chooseRanks([...rest.keys()].filter(item => rest.get(item).length >= 2), 2, wingRanks => {
        add([...group, ...wingRanks.flatMap(item => rest.get(item).slice(0, 2))]);
      });
    }
  }
  if (groups.has(16) && groups.has(17)) add([groups.get(16)[0], groups.get(17)[0]]);

  for (const [copies, minimum] of [[1, 5], [2, 3], [3, 2]]) {
    for (let start = 3; start <= 14; start++) {
      const body = [];
      for (let end = start; end <= 14 && (groups.get(end)?.length || 0) >= copies; end++) {
        body.push(end);
        if (body.length < minimum) continue;
        const core = body.flatMap(rank => groups.get(rank).slice(0, copies));
        add(core);
        if (copies !== 3) continue;
        const rest = new Map([...groups].filter(([rank]) => !body.includes(rank)));
        if (core.length + body.length <= hand.length) chooseSingles(rest, body.length, wings => add([...core, ...wings]));
        if (core.length + body.length * 2 <= hand.length) {
          chooseRanks([...rest.keys()].filter(rank => rest.get(rank).length >= 2), body.length, wingRanks => {
            add([...core, ...wingRanks.flatMap(rank => rest.get(rank).slice(0, 2))]);
          });
        }
      }
    }
  }
  return plays;
}

export function createGame({ seed = Date.now(), firstBidder = 0, deal = 1, seq = 0 } = {}) {
  const deck = shuffled(seed);
  return {
    seed: Number(seed) >>> 0, firstBidder, deal, seq, phase: 'bidding', turn: firstBidder,
    hands: [0, 1, 2].map(seat => sortCards(deck.slice(seat * 17, seat * 17 + 17))), bottom: deck.slice(51),
    bids: [-1, -1, -1], highestBid: 0, highestBidder: null, landlordSeat: null,
    multiplier: 1, trick: null, passes: 0, tablePlays: [null, null, null],
    playedCards: [[], [], []], playCounts: [0, 0, 0], history: [], lastAction: { type: 'deal', id: seq },
    winnerSide: null, winnerSeat: null, spring: false, scores: null
  };
}

function fail(code, reason) { return { ok: false, code, reason }; }
export function applyAction(state, seat, action) {
  if (!state || state.phase === 'ended') return fail('ended', '这局已经结束了');
  if (!Number.isInteger(seat) || seat !== state.turn) return fail('notYourTurn', '还没有轮到你');
  if (!action || typeof action.type !== 'string') return fail('invalidAction', '无效的操作');
  const next = {
    ...state, seq: state.seq + 1, hands: state.hands.map(hand => [...hand]), bids: [...state.bids],
    tablePlays: [...state.tablePlays], playedCards: state.playedCards.map(cards => [...cards]),
    playCounts: [...state.playCounts], history: [...state.history]
  };
  let event;
  if (state.phase === 'bidding') {
    const score = action.score;
    if (action.type !== 'bid' || !Number.isInteger(score) || score < 0 || score > 3) return fail('invalidBid', '请选择不叫、1 分、2 分或 3 分');
    if (score && score <= state.highestBid) return fail('bidTooLow', '叫分需要高于当前分数');
    next.bids[seat] = score;
    if (score) { next.highestBid = score; next.highestBidder = seat; }
    event = { type: 'bid', seat, score };
    if (score === 3 || next.bids.every(value => value >= 0)) {
      if (!next.highestBid) {
        const redealt = createGame({ seed: (state.seed + 0x9E3779B9) >>> 0, firstBidder: (state.firstBidder + 1) % 3, deal: state.deal + 1, seq: next.seq });
        redealt.lastAction = { type: 'redeal', id: next.seq };
        return { ok: true, state: redealt };
      }
      next.landlordSeat = next.highestBidder;
      next.hands[next.landlordSeat] = sortCards([...next.hands[next.landlordSeat], ...next.bottom]);
      next.phase = 'playing';
      next.turn = next.landlordSeat;
      event = { ...event, type: 'landlord', landlordSeat: next.landlordSeat, score: next.highestBid };
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
    if (!Array.isArray(selected) || !selected.length || selected.length > 20 || new Set(selected).size !== selected.length || selected.some(id => !state.hands[seat].includes(id))) return fail('notOwned', '请选择自己手里的牌');
    const value = classify(selected);
    if (!value) return fail('invalidPattern', '这些牌不能组成一种有效牌型');
    if (!canBeat(value, state.trick?.pattern)) return fail('tooSmall', '需要相同牌型且更大的点数，或使用炸弹 / 王炸');
    const cards = sortCards(selected);
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
        : next.playCounts[next.landlordSeat] === 1;
      if (next.spring) next.multiplier *= 2;
      const base = next.highestBid * next.multiplier;
      next.scores = [0, 1, 2].map(index => {
        const landlord = index === next.landlordSeat;
        const won = landlord === (next.winnerSide === 'landlord');
        return (landlord ? 2 : 1) * base * (won ? 1 : -1);
      });
      event.ended = true;
      event.spring = next.spring;
    }
  } else return fail('invalidAction', '当前阶段不能执行这个操作');
  event.id = next.seq;
  next.lastAction = event;
  next.history.push(event);
  return { ok: true, state: next };
}

export function publicState(state, seat) {
  return {
    seq: state.seq, deal: state.deal, phase: state.phase, turn: state.turn,
    hand: Number.isInteger(seat) ? [...state.hands[seat]] : [], counts: state.hands.map(hand => hand.length),
    bottom: state.phase === 'bidding' ? [] : [...state.bottom], bids: [...state.bids],
    highestBid: state.highestBid, landlordSeat: state.landlordSeat, multiplier: state.multiplier,
    trick: state.trick, passes: state.passes, tablePlays: state.tablePlays, playedCards: state.playedCards,
    playCounts: state.playCounts, history: state.history, lastAction: state.lastAction,
    winnerSide: state.winnerSide, winnerSeat: state.winnerSeat, spring: state.spring, scores: state.scores,
    ...(state.phase === 'ended' ? { revealedHands: state.hands.map(hand => [...hand]) } : {})
  };
}
