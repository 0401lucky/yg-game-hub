import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK, cardInfo, rankOf, createGame, classify, canBeat, legalPlays, applyAction, publicState, seededRandom } from '../games/doudizhu/engine.mjs';
import { chooseAction, botView, samplePossibleHands, suggestedPlays } from '../games/doudizhu/bot.mjs';

const cards = (...ranks) => {
  const used = new Map();
  return ranks.map(rank => { const index = used.get(rank) || 0; used.set(rank, index + 1); return DECK.filter(id => rankOf(id) === rank)[index]; });
};
function playing(hands, { landlordSeat = 0, turn = landlordSeat, playCounts = [0, 0, 0], trick = null } = {}) {
  return { ...createGame({ seed: 9 }), phase: 'playing', hands, landlordSeat, turn, highestBid: 2, playCounts, trick };
}
function playKey(move) {
  const counts = Array(15).fill(0);
  for (const id of move.cards) counts[rankOf(id) - 3]++;
  return `${move.pattern.type}:${move.pattern.rank}:${counts.join('')}`;
}

test('54 张牌、确定性洗牌、17/17/17/3 发牌，快照不泄漏底牌与种子', () => {
  assert.equal(DECK.length, 54);
  assert.equal(new Set(DECK).size, 54);
  assert.equal(cardInfo('H14').suit, 'heart');
  const state = createGame({ seed: 42, firstBidder: 2 });
  assert.deepEqual(state, createGame({ seed: 42, firstBidder: 2 }));
  assert.deepEqual(state.hands.map(hand => hand.length), [17, 17, 17]);
  assert.equal(new Set([...state.hands.flat(), ...state.bottom]).size, 54);
  const snapshot = publicState(state, 0);
  assert.deepEqual(snapshot.hand, state.hands[0]);
  assert.deepEqual(snapshot.bottom, []);
  assert.equal(snapshot.seed, undefined);
  assert.equal(snapshot.hands, undefined);
  assert.equal(snapshot.revealedHands, undefined);
});

test('完整牌型识别，以及飞机翅膀与四带二约定', () => {
  const examples = [
    ['single', [3]], ['pair', [3, 3]], ['triple', [3, 3, 3]],
    ['tripleSingle', [3, 3, 3, 4]], ['triplePair', [3, 3, 3, 4, 4]],
    ['straight', [3, 4, 5, 6, 7]], ['pairStraight', [3, 3, 4, 4, 5, 5]],
    ['airplane', [3, 3, 3, 4, 4, 4]], ['airplaneSingle', [3, 3, 3, 4, 4, 4, 5, 5]],
    ['airplanePair', [3, 3, 3, 4, 4, 4, 5, 5, 6, 6]],
    ['fourSingles', [3, 3, 3, 3, 4, 4]], ['fourPairs', [3, 3, 3, 3, 4, 4, 5, 5]],
    ['bomb', [3, 3, 3, 3]], ['rocket', [16, 17]]
  ];
  for (const [type, ranks] of examples) assert.equal(classify(cards(...ranks))?.type, type, type);
  for (const invalid of [
    [], ['S3', 'S3'], ['S99'], cards(11, 12, 13, 14, 15), cards(3, 3, 4, 4),
    cards(3, 3, 3, 3, 4, 4, 4, 5),
    cards(3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8)
  ]) assert.equal(classify(invalid), null, JSON.stringify(invalid));
});

test('同型同长度比较、炸弹和王炸的优先级', () => {
  const type = ranks => classify(cards(...ranks));
  assert(canBeat(type([5, 5]), type([4, 4])));
  assert(!canBeat(type([4, 4]), type([4, 4])));
  assert(!canBeat(type([15]), type([4, 4])));
  assert(!canBeat(type([4, 5, 6, 7, 8, 9]), type([3, 4, 5, 6, 7])));
  assert(canBeat(type([3, 3, 3, 3]), type([15, 15])));
  assert(canBeat(type([16, 17]), type([14, 14, 14, 14])));
  assert(!canBeat(type([14, 14, 14, 14]), type([16, 17])));
});

test('出牌枚举覆盖小手牌所有可用牌型，提示不会漏掉合法解', () => {
  const hands = [cards(3, 3, 3, 3, 4, 4, 4, 5, 5, 16, 17), cards(3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10)];
  for (let seed = 1; seed <= 8; seed++) hands.push(createGame({ seed }).hands[seed % 3].slice(0, 12));
  for (const hand of hands) {
    const generated = new Set(legalPlays(hand).map(playKey));
    for (let mask = 1; mask < 2 ** hand.length; mask++) {
      const selected = hand.filter((_, index) => mask & 2 ** index);
      const pattern = classify(selected);
      if (pattern) assert(generated.has(playKey({ cards: selected, pattern })), `漏牌型 ${JSON.stringify(selected)}`);
    }
  }
});

test('叫分只能抬高，3 分立即拿底牌；全部不叫轮换首叫并重发', () => {
  let state = createGame({ seed: 42 });
  const original = JSON.stringify(state);
  assert.equal(applyAction(state, 1, { type: 'bid', score: 1 }).code, 'notYourTurn');
  let result = applyAction(state, 0, { type: 'bid', score: 1 });
  assert.equal(JSON.stringify(state), original, '原状态不可被修改');
  state = result.state;
  assert.equal(applyAction(state, 1, { type: 'bid', score: 1 }).code, 'bidTooLow');
  state = applyAction(state, 1, { type: 'bid', score: 3 }).state;
  assert.equal(state.phase, 'playing');
  assert.equal(state.landlordSeat, 1);
  assert.deepEqual(state.hands.map(hand => hand.length), [17, 20, 17]);
  assert.deepEqual(publicState(state, 0).bottom, state.bottom);
  let noBid = createGame({ seed: 77, firstBidder: 0 });
  for (let seat = 0; seat < 3; seat++) noBid = applyAction(noBid, seat, { type: 'bid', score: 0 }).state;
  assert.equal(noBid.deal, 2);
  assert.equal(noBid.firstBidder, 1);
  assert.equal(noBid.turn, 1);
  assert.equal(noBid.seq, 3);
  assert.equal(noBid.lastAction.type, 'redeal');
  assert.notDeepEqual(noBid.hands, createGame({ seed: 77 }).hands);
});

test('服务端拒绝冒用手牌、重复牌、非法牌型与领出不出；两次不出归还出牌权', () => {
  let state = playing([['S3', 'S4'], ['H4', 'H5'], ['C5', 'C6']]);
  assert.equal(applyAction(state, 0, { type: 'pass' }).code, 'mustLead');
  assert.equal(applyAction(state, 0, { type: 'play', cards: ['H4'] }).code, 'notOwned');
  assert.equal(applyAction(state, 0, { type: 'play', cards: ['S3', 'S3'] }).code, 'notOwned');
  assert.equal(applyAction(state, 0, { type: 'play', cards: ['S3', 'S4'] }).code, 'invalidPattern');
  state = applyAction(state, 0, { type: 'play', cards: ['S3'] }).state;
  state = applyAction(state, 1, { type: 'pass' }).state;
  state = applyAction(state, 2, { type: 'pass' }).state;
  assert.equal(state.turn, 0);
  assert.equal(state.trick, null);
  assert.equal(state.passes, 0);
});

test('炸弹、王炸各翻倍；地主春天和农民反春天积分守恒', () => {
  let state = playing([['S3', 'H3', 'C3', 'D3', 'S4'], ['BJ', 'RJ', 'S9'], ['H9', 'H10']]);
  state = applyAction(state, 0, { type: 'play', cards: ['S3', 'H3', 'C3', 'D3'] }).state;
  assert.equal(state.multiplier, 2);
  state = applyAction(state, 1, { type: 'play', cards: ['BJ', 'RJ'] }).state;
  assert.equal(state.multiplier, 4);
  const landlordWin = applyAction(playing([['S3'], ['H4'], ['C5']]), 0, { type: 'play', cards: ['S3'] }).state;
  assert.equal(landlordWin.spring, true);
  assert.deepEqual(landlordWin.scores, [8, -4, -4]);
  const farmerWin = applyAction(playing([['S3'], ['H4'], ['C5']], { turn: 1, playCounts: [1, 0, 0] }), 1, { type: 'play', cards: ['H4'] }).state;
  assert.equal(farmerWin.winnerSide, 'farmers');
  assert.equal(farmerWin.spring, true);
  assert.deepEqual(farmerWin.scores, [-8, 4, 4]);
  assert.equal(farmerWin.scores.reduce((sum, score) => sum + score, 0), 0);
  assert.deepEqual(publicState(farmerWin, 2).revealedHands, farmerWin.hands);
});

test('困难与地狱让农民队友保持出牌权，能出完则直接获胜', () => {
  const state = playing([['S9', 'S10'], ['S3', 'S4'], ['H9', 'H10']], { turn: 2, trick: { seat: 1, cards: ['C3'], pattern: classify(['C3']) }, playCounts: [2, 1, 0] });
  for (const level of ['hard', 'hell']) assert.equal(chooseAction(botView(state, 2), level).type, 'pass');
  state.hands[2] = ['H9'];
  assert.equal(chooseAction(botView(state, 2), 'hell').type, 'play');
});

test('地狱抽样只使用公开信息，保持牌数、牌的唯一性和地主公开底牌', () => {
  let state = createGame({ seed: 134 });
  state = applyAction(state, state.turn, { type: 'bid', score: 3 }).state;
  const view = botView(state, 1);
  assert.equal(view.hands, undefined);
  assert.equal(view.seed, undefined);
  for (let i = 0; i < 8; i++) {
    const hands = samplePossibleHands(view, seededRandom(i));
    assert.deepEqual(hands.map(hand => hand.length), view.counts);
    assert.deepEqual(hands[1], view.hand);
    assert.equal(new Set(hands.flat()).size, 54);
    assert(state.bottom.every(id => hands[0].includes(id)));
  }
  const hints = suggestedPlays(view);
  assert(hints.every(move => move.cards.every(id => view.hand.includes(id)) && canBeat(move.pattern, view.trick?.pattern)));
});

test('三档人机与混合难度完成 24 局；每手合法，牌数与结算守恒', () => {
  for (let seed = 1; seed <= 24; seed++) {
    let state = createGame({ seed: seed * 719, firstBidder: seed % 3 });
    const random = seededRandom(seed);
    let actions = 0;
    while (state.phase !== 'ended' && actions < 240) {
      const level = seed <= 6 ? 'easy' : seed <= 12 ? 'hard' : seed <= 18 ? 'hell' : ['easy', 'hard', 'hell'][state.turn];
      const action = chooseAction(botView(state, state.turn), level, { random, thinkMs: 35 });
      const result = applyAction(state, state.turn, action);
      assert(result.ok, `${level} seed=${seed}: ${JSON.stringify({ action, result })}`);
      state = result.state;
      const allCards = [...state.hands.flat(), ...state.playedCards.flat(), ...(state.phase === 'bidding' ? state.bottom : [])];
      assert.equal(allCards.length, 54);
      assert.equal(new Set(allCards).size, 54);
      actions++;
    }
    assert.equal(state.phase, 'ended', `seed=${seed} 未结束`);
    assert.equal(state.scores.reduce((sum, score) => sum + score, 0), 0);
  }
});
