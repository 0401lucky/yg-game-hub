import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK, cardInfo, rankOf, createGame, classify, canBeat, legalPlays, applyAction, applyOpenHand, applySurrender, publicState, seededRandom, sortCards, stateRules } from '../../games/doudizhu/engine.ts';
import { resolveRules, AFFIX_LIST } from '../../games/doudizhu/affixes.ts';
import { chooseAction, botView, samplePossibleHands, suggestedPlays, shouldBotOpenHand } from '../../games/doudizhu/bot.ts';

import type { AffixId, CardId, Difficulty, GameState, PatternType, Play } from '../../games/doudizhu/types.ts';
import { acceptedState, rejectionCode } from './helpers.ts';

const cards = (...ranks: number[]): CardId[] => {
  const used = new Map<number, number>();
  return ranks.map(rank => { const index = used.get(rank) || 0; used.set(rank, index + 1); return DECK.filter(id => rankOf(id) === rank)[index]; });
};
function playing(hands: CardId[][], { landlordSeat = 0, turn = landlordSeat, playCounts = [0, 0, 0], trick = null }: Partial<Pick<GameState, 'landlordSeat' | 'turn' | 'playCounts' | 'trick'>> = {}): GameState {
  return { ...createGame({ seed: 9 }), phase: 'playing', hands, landlordSeat, turn, highestBid: 2, playCounts, trick };
}
function playKey(move: Play) {
  const counts = Array(15).fill(0);
  for (const id of move.cards) counts[rankOf(id) - 3]++;
  return `${move.pattern.type}:${move.pattern.rank}:${counts.join('')}`;
}

test('54 张牌、确定性洗牌、17/17/17/3 发牌，快照不泄漏底牌与种子', () => {
  assert.equal(DECK.length, 54);
  assert.equal(new Set(DECK).size, 54);
  assert.equal(cardInfo('H14')?.suit, 'heart');
  const state = createGame({ seed: 42, firstBidder: 2 });
  assert.deepEqual(state, createGame({ seed: 42, firstBidder: 2 }));
  assert.deepEqual(state.hands.map(hand => hand.length), [17, 17, 17]);
  assert.equal(new Set([...state.hands.flat(), ...state.bottom]).size, 54);
  const snapshot = publicState(state, 0);
  assert.deepEqual(snapshot.hand, state.hands[0]);
  assert.deepEqual(snapshot.bottom, []);
  assert.equal(Reflect.get(snapshot, 'seed'), undefined);
  assert.equal(Reflect.get(snapshot, 'hands'), undefined);
  assert.equal(snapshot.revealedHands, undefined);
});

test('完整牌型识别，以及飞机翅膀与四带二约定', () => {
  const examples: [PatternType, number[]][] = [
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
  const type = (ranks: number[]) => classify(cards(...ranks));
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
  assert.equal(rejectionCode(applyAction(state, 1, { type: 'bid', score: 1 })), 'notYourTurn');
  let result = applyAction(state, 0, { type: 'bid', score: 1 });
  assert.equal(JSON.stringify(state), original, '原状态不可被修改');
  state = acceptedState(result);
  assert.equal(rejectionCode(applyAction(state, 1, { type: 'bid', score: 1 })), 'bidTooLow');
  state = acceptedState(applyAction(state, 1, { type: 'bid', score: 3 }));
  assert.equal(state.phase, 'playing');
  assert.equal(state.landlordSeat, 1);
  assert.deepEqual(state.hands.map(hand => hand.length), [17, 20, 17]);
  assert.deepEqual(publicState(state, 0).bottom, state.bottom);
  let noBid = createGame({ seed: 77, firstBidder: 0 });
  for (let seat = 0; seat < 3; seat++) noBid = acceptedState(applyAction(noBid, seat, { type: 'bid', score: 0 }));
  assert.equal(noBid.deal, 2);
  assert.equal(noBid.firstBidder, 1);
  assert.equal(noBid.turn, 1);
  assert.equal(noBid.seq, 3);
  assert.equal(noBid.lastAction.type, 'redeal');
  assert.notDeepEqual(noBid.hands, createGame({ seed: 77 }).hands);
});

test('服务端拒绝冒用手牌、重复牌、非法牌型与领出不出；两次不出归还出牌权', () => {
  let state = playing([['S3', 'S4'], ['H4', 'H5'], ['C5', 'C6']]);
  assert.equal(rejectionCode(applyAction(state, 0, { type: 'pass' })), 'mustLead');
  assert.equal(rejectionCode(applyAction(state, 0, { type: 'play', cards: ['H4'] })), 'notOwned');
  assert.equal(rejectionCode(applyAction(state, 0, { type: 'play', cards: ['S3', 'S3'] })), 'notOwned');
  assert.equal(rejectionCode(applyAction(state, 0, { type: 'play', cards: ['S3', 'S4'] })), 'invalidPattern');
  state = acceptedState(applyAction(state, 0, { type: 'play', cards: ['S3'] }));
  state = acceptedState(applyAction(state, 1, { type: 'pass' }));
  state = acceptedState(applyAction(state, 2, { type: 'pass' }));
  assert.equal(state.turn, 0);
  assert.equal(state.trick, null);
  assert.equal(state.passes, 0);
});

test('炸弹、王炸各翻倍；地主春天和农民反春天积分守恒', () => {
  let state = playing([['S3', 'H3', 'C3', 'D3', 'S4'], ['BJ', 'RJ', 'S9'], ['H9', 'H10']]);
  state = acceptedState(applyAction(state, 0, { type: 'play', cards: ['S3', 'H3', 'C3', 'D3'] }));
  assert.equal(state.multiplier, 2);
  state = acceptedState(applyAction(state, 1, { type: 'play', cards: ['BJ', 'RJ'] }));
  assert.equal(state.multiplier, 4);
  const landlordWin = acceptedState(applyAction(playing([['S3'], ['H4'], ['C5']]), 0, { type: 'play', cards: ['S3'] }));
  assert.equal(landlordWin.spring, true);
  assert.deepEqual(landlordWin.scores, [8, -4, -4]);
  const farmerWin = acceptedState(applyAction(playing([['S3'], ['H4'], ['C5']], { turn: 1, playCounts: [1, 0, 0] }), 1, { type: 'play', cards: ['H4'] }));
  assert.equal(farmerWin.winnerSide, 'farmers');
  assert.equal(farmerWin.spring, true);
  assert.deepEqual(farmerWin.scores, [-8, 4, 4]);
  assert(farmerWin.scores);
  assert.equal(farmerWin.scores.reduce((sum, score) => sum + score, 0), 0);
  assert.deepEqual(publicState(farmerWin, 2).revealedHands, farmerWin.hands);
});

test('困难与地狱让农民队友保持出牌权，能出完则直接获胜', () => {
  const state = playing([['S9', 'S10'], ['S3', 'S4'], ['H9', 'H10']], { turn: 2, trick: { seat: 1, cards: ['C3'], pattern: classify(['C3'])! }, playCounts: [2, 1, 0] });
  for (const level of ['hard', 'hell'] as const) assert.equal(chooseAction(botView(state, 2), level)?.type, 'pass');
  state.hands[2] = ['H9'];
  assert.equal(chooseAction(botView(state, 2), 'hell')?.type, 'play');
});

test('地狱抽样只使用公开信息，保持牌数、牌的唯一性和地主公开底牌', () => {
  let state = createGame({ seed: 134 });
  state = acceptedState(applyAction(state, state.turn, { type: 'bid', score: 3 }));
  const view = botView(state, 1);
  assert.equal(Reflect.get(view, 'hands'), undefined);
  assert.equal(Reflect.get(view, 'seed'), undefined);
  for (let i = 0; i < 8; i++) {
    const hands = samplePossibleHands(view, seededRandom(i));
    assert(hands);
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
      const level = seed <= 6 ? 'easy' : seed <= 12 ? 'hard' : seed <= 18 ? 'hell' : (['easy', 'hard', 'hell'] as Difficulty[])[state.turn!];
      assert.notEqual(state.turn, null);
      const action = chooseAction(botView(state, state.turn!), level, { random, thinkMs: 35 });
      const result = applyAction(state, state.turn, action);
      assert(result.ok, `${level} seed=${seed}: ${JSON.stringify({ action, result })}`);
      state = acceptedState(result);
      const allCards = [...state.hands.flat(), ...state.playedCards.flat(), ...(state.phase === 'bidding' ? state.bottom : [])];
      assert.equal(allCards.length, 54);
      assert.equal(new Set(allCards).size, 54);
      actions++;
    }
    assert.equal(state.phase, 'ended', `seed=${seed} 未结束`);
    assert(state.scores);
    assert.equal(state.scores.reduce((sum, score) => sum + score, 0), 0);
  }
});

test('癞子模式：软炸弹、硬炸弹、纯癞子炸弹与王炸优先级，以及顺子/三带/不可当王', () => {
  const laizi = 5;
  const softBomb = classify(cards(7, 7, 7, 5), laizi);
  const hardBomb = classify(cards(6, 6, 6, 6), laizi);
  const pureBomb = classify(cards(5, 5, 5, 5), laizi);
  const rocket = classify(cards(16, 17), laizi);
  assert.equal(softBomb?.type, 'bomb');
  assert.equal(softBomb?.bombKind, 'soft');
  assert.equal(hardBomb?.bombKind, 'hard');
  assert.equal(pureBomb?.bombKind, 'pure');
  // 软炸弹 < 硬炸弹 < 纯癞子炸弹 < 王炸
  assert(canBeat(hardBomb, softBomb));
  assert(!canBeat(softBomb, hardBomb));
  assert(canBeat(pureBomb, hardBomb));
  assert(!canBeat(hardBomb, pureBomb));
  assert(canBeat(rocket, pureBomb));
  assert(!canBeat(pureBomb, rocket));
  // 癞子不可当王
  assert.equal(classify(cards(17, 5), laizi), null);
  assert.equal(classify(cards(16, 5), laizi), null);
  // 癞子补齐顺子和连对
  assert.equal(classify(cards(3, 4, 5, 6, 7), laizi)?.type, 'straight');
  assert.equal(classify(cards(8, 9, 10, 12, 5), laizi)?.type, 'straight');
  assert.equal(classify(cards(6, 6, 7, 8, 8, 5), laizi)?.type, 'pairStraight');
  // 癞子牌在有目标牌型时优先匹配可压过目标的解释
  const pairTarget = classify(cards(10, 10), laizi);
  assert(canBeat(classify(cards(11, 5), laizi, pairTarget), pairTarget));
  // 癞子完整对局 12 局
  for (let seed = 1; seed <= 12; seed++) {
    let state = createGame({ seed: seed * 1013, firstBidder: seed % 3, mode: 'laizi' });
    assert(state.laiziRank !== null && state.laiziRank >= 3 && state.laiziRank <= 15);
    const random = seededRandom(seed + 100);
    let actions = 0;
    while (state.phase !== 'ended' && actions < 240) {
      const level = (['easy', 'hard', 'hell'] as Difficulty[])[state.turn!];
      const action = chooseAction(botView(state, state.turn!), level, { random, thinkMs: 35 });
      const result = applyAction(state, state.turn, action);
      assert(result.ok, `laizi seed=${seed}: ${JSON.stringify({ action, result })}`);
      state = acceptedState(result);
      actions++;
    }
    assert.equal(state.phase, 'ended', `laizi seed=${seed} 未结束`);
    assert.equal(state.scores!.reduce((sum, score) => sum + score, 0), 0);
  }
});

test('明牌：叫分与出牌阶段均可明牌、倍率翻倍、公开手牌透传且地狱抽样尊重明牌', () => {
  let state = createGame({ seed: 2026 });
  assert.deepEqual(publicState(state, 1).openHands, [null, null, null]);
  state = acceptedState(applyOpenHand(state, 0));
  assert.equal(state.multiplier, 2);
  assert.equal(rejectionCode(applyOpenHand(state, 0)), 'alreadyOpen');
  const view1 = botView(state, 1);
  assert.deepEqual(view1.openHands[0], state.hands[0]);
  assert.equal(view1.openHands[2], null);
  state = acceptedState(applyAction(state, 0, { type: 'bid', score: 3 }));
  // 进入出牌阶段后另一位玩家也可明牌
  state = acceptedState(applyOpenHand(state, 2));
  assert.equal(state.multiplier, 4);
  const sample = samplePossibleHands(botView(state, 1), seededRandom(7));
  assert(sample);
  assert.deepEqual(sample[0], state.hands[0]);
  assert.deepEqual(sample[2], state.hands[2]);
  // 极强手牌触发人机明牌判断，弱牌不触发
  const strongState = playing([cards(17, 16, 15, 15, 15, 15, 14, 14, 14, 14, 13, 13, 12, 12, 11, 11, 10), cards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 3, 4, 6, 7, 8), cards(3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13, 3, 4, 5, 6, 7)]);
  assert.equal(shouldBotOpenHand(botView(strongState, 0), 'hard', () => 0.1), true);
  assert.equal(shouldBotOpenHand(botView(strongState, 1), 'hard', () => 0.1), false);
});

test('投降：叫分阶段禁止投降，出牌阶段投降立即判对方胜且积分守恒', () => {
  const bidding = createGame({ seed: 18 });
  assert.equal(rejectionCode(applySurrender(bidding, 0)), 'notPlaying');
  const mid = playing([['S3', 'S4'], ['H4', 'H5'], ['C5', 'C6']], { landlordSeat: 0 });
  const landlordLose = acceptedState(applySurrender(mid, 0));
  assert.equal(landlordLose.phase, 'ended');
  assert.equal(landlordLose.winnerSide, 'farmers');
  assert.equal(landlordLose.surrenderBy, 0);
  assert.deepEqual(landlordLose.scores, [-4, 2, 2]);
  const farmerLose = acceptedState(applySurrender(mid, 1));
  assert.equal(farmerLose.winnerSide, 'landlord');
  assert.deepEqual(farmerLose.scores, [4, -2, -2]);
});

test('肉鸽词条：以下犯上（3 最大且不入顺）、残缺之美（4顺/2连对）、倍率狂飙', () => {
  const underdog = resolveRules(['underdog']);
  assert(canBeat(classify(cards(3), underdog), classify(cards(15), underdog), underdog));
  assert(!canBeat(classify(cards(15), underdog), classify(cards(3), underdog), underdog));
  assert(canBeat(classify(cards(16), underdog), classify(cards(3), underdog), underdog));
  assert(canBeat(classify(cards(3, 3, 3, 3), underdog), classify(cards(15, 15, 15, 15), underdog), underdog));
  // 3 不参与顺子、连对与飞机机身
  assert.equal(classify(cards(3, 4, 5, 6, 7), underdog), null);
  assert.equal(classify(cards(3, 3, 4, 4, 5, 5), underdog), null);
  assert.equal(classify(cards(4, 5, 6, 7, 8), underdog)?.type, 'straight');
  // 排序时 3 排在 2 前面、小王后面
  assert.deepEqual(sortCards(['S15', 'S3', 'BJ', 'S14'], underdog), ['BJ', 'S3', 'S15', 'S14']);

  const imperfect = resolveRules(['imperfect']);
  assert.equal(classify(cards(4, 5, 6, 7), imperfect)?.type, 'straight');
  assert.equal(classify(cards(8, 8, 9, 9), imperfect)?.type, 'pairStraight');
  assert.equal(classify(cards(4, 5, 6, 7)), null);
  assert.equal(classify(cards(8, 8, 9, 9)), null);
  const hand = cards(6, 7, 8, 9, 10, 10, 11, 11);
  const moves = legalPlays(hand, null, imperfect);
  assert(moves.some(m => m.pattern.type === 'straight' && m.cards.length === 4));
  assert(moves.some(m => m.pattern.type === 'pairStraight' && m.cards.length === 4));

  // 倍率狂飙：开局初始倍率 ×2，炸弹/王炸 ×3
  let surge = createGame({ seed: 303, mode: 'roguelike', affixes: ['multiplierSurge'] });
  assert.equal(surge.multiplier, 2);
  surge = { ...surge, phase: 'playing', landlordSeat: 0, turn: 0, highestBid: 1, hands: [cards(5, 5, 5, 5, 6), cards(16, 17, 7), cards(8, 9)] };
  surge = acceptedState(applyAction(surge, 0, { type: 'play', cards: surge.hands[0].slice(0, 4) }));
  assert.equal(surge.multiplier, 6);
  surge = acceptedState(applyAction(surge, 1, { type: 'play', cards: ['BJ', 'RJ'] }));
  assert.equal(surge.multiplier, 18);
});

test('肉鸽词条：明牌地主（6底牌强制明牌）、心灵感应（农民互看）、炸弹过敏（出炸弹弃1张）', () => {
  // 明牌地主：每人 16 张 + 6 张底牌，地主拿后 22 张且强制明牌不翻倍
  let openGame = createGame({ seed: 501, firstBidder: 0, mode: 'roguelike', affixes: ['openLandlord'] });
  assert.deepEqual(openGame.hands.map(h => h.length), [16, 16, 16]);
  assert.equal(openGame.bottom.length, 6);
  assert.equal(openGame.multiplier, 1);
  openGame = acceptedState(applyAction(openGame, 0, { type: 'bid', score: 3 }));
  assert.equal(openGame.hands[0].length, 22);
  assert.equal(openGame.forcedOpenSeats[0], true);
  assert.equal(openGame.openSeats[0], false);
  assert.equal(openGame.multiplier, 1);
  assert.deepEqual(publicState(openGame, 1).openHands[0], openGame.hands[0]);
  assert.equal(publicState(openGame, 1).openHands[2], null);

  // 心灵感应：确定地主后两位农民互相可见手牌，地主看不到
  let tele = createGame({ seed: 502, firstBidder: 0, mode: 'roguelike', affixes: ['telepathy'] });
  assert.deepEqual(publicState(tele, 1).openHands, [null, null, null]);
  tele = acceptedState(applyAction(tele, 0, { type: 'bid', score: 3 }));
  assert.deepEqual(publicState(tele, 1).openHands[2], tele.hands[2]);
  assert.deepEqual(publicState(tele, 2).openHands[1], tele.hands[1]);
  assert.equal(publicState(tele, 0).openHands[1], null);
  assert.equal(publicState(tele, 0).openHands[2], null);
  const farmerSample = samplePossibleHands(botView(tele, 1), seededRandom(11));
  assert(farmerSample);
  assert.deepEqual(farmerSample[2], tele.hands[2]);

  // 炸弹过敏：出炸弹随机弃掉 1 张并记入 playedCards；若只剩 1 张则直接胜出
  let allergy = createGame({ seed: 503, mode: 'roguelike', affixes: ['bombAllergy'] });
  allergy = { ...allergy, phase: 'playing', landlordSeat: 0, turn: 0, highestBid: 2, hands: [cards(8, 8, 8, 8, 9, 10), cards(4, 5), cards(6, 7)] };
  const afterBomb = acceptedState(applyAction(allergy, 0, { type: 'play', cards: allergy.hands[0].slice(0, 4) }));
  assert.equal(afterBomb.hands[0].length, 1);
  assert.equal(afterBomb.playedCards[0].length, 5);
  assert(afterBomb.lastAction.type === 'play' && Boolean(afterBomb.lastAction.discarded));
  // 4张炸弹 + 1张手牌 -> 触发炸弹过敏弃掉最后一张直接获胜
  const winByAllergy = acceptedState(applyAction(
    { ...allergy, hands: [cards(8, 8, 8, 8, 9), cards(4, 5), cards(6, 7)] },
    0,
    { type: 'play', cards: cards(8, 8, 8, 8) }
  ));
  assert.equal(winByAllergy.phase, 'ended');
  assert.equal(winByAllergy.winnerSeat, 0);
  assert.equal(winByAllergy.hands[0].length, 0);
});

test('肉鸽模式：每局随机 2 条词条、重发牌重新随机词条、全词条组合人机完赛且牌数积分守恒', () => {
  // 重发牌后词条重新随机（验证多次不叫重发能产生不同词条）
  let sawDiff = false;
  for (let seed = 1; seed <= 12; seed++) {
    let state = createGame({ seed: seed * 97, firstBidder: 0, mode: 'roguelike' });
    assert.equal(state.affixes.length, 2);
    assert.equal(new Set(state.affixes).size, 2);
    const beforeAffixes = [...state.affixes];
    for (let s = 0; s < 3; s++) state = acceptedState(applyAction(state, s, { type: 'bid', score: 0 }));
    assert.equal(state.deal, 2);
    assert.equal(state.affixes.length, 2);
    if (state.affixes.join(',') !== beforeAffixes.join(',')) sawDiff = true;
  }
  assert(sawDiff, '重发牌应重新随机词条');

  // 覆盖每条词条参与完整人机对局，并加测随机肉鸽局
  const forcedPairs: (AffixId[] | undefined)[] = [
    ['underdog', 'imperfect'],
    ['openLandlord', 'telepathy'],
    ['bombAllergy', 'wildDrop'],
    ['multiplierSurge', 'underdog'],
    ['wildDrop', 'imperfect'],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined
  ];
  assert.equal(AFFIX_LIST.length, 7);
  for (let i = 0; i < forcedPairs.length; i++) {
    let state = createGame({ seed: (i + 1) * 1307, firstBidder: i % 3, mode: 'roguelike', affixes: forcedPairs[i] });
    const rules = stateRules(state);
    if (state.affixes.includes('wildDrop')) assert(state.laiziRank !== null);
    else assert.equal(state.laiziRank, null);
    assert.equal(state.bottom.length, rules.bottomCount);
    const random = seededRandom(i + 500);
    let actions = 0;
    while (state.phase !== 'ended' && actions < 260) {
      const level = (['easy', 'hard', 'hell'] as Difficulty[])[state.turn!];
      const action = chooseAction(botView(state, state.turn!), level, { random, thinkMs: 35 });
      const result = applyAction(state, state.turn, action);
      assert(result.ok, `roguelike i=${i} affixes=${state.affixes.join(',')}: ${JSON.stringify({ action, result })}`);
      state = acceptedState(result);
      const allCards = [...state.hands.flat(), ...state.playedCards.flat(), ...(state.phase === 'bidding' ? state.bottom : [])];
      assert.equal(allCards.length, 54);
      assert.equal(new Set(allCards).size, 54);
      actions++;
    }
    assert.equal(state.phase, 'ended', `roguelike i=${i} 未结束`);
    assert.equal(state.scores!.reduce((sum, score) => sum + score, 0), 0);
  }
});


