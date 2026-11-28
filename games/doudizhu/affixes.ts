import type { AffixId, AffixInfo, RuleConfig } from './types.ts';

export const AFFIX_LIST: readonly AffixInfo[] = Object.freeze([
  {
    id: 'underdog',
    name: '以下犯上',
    short: '3 最大',
    description: '本局 3 最大（仅次于大小王，压过 2），且 3 不参与顺子、连对与飞机机身。',
    conflicts: [],
  },
  {
    id: 'imperfect',
    name: '残缺之美',
    short: '4顺/2连对',
    description: '本局顺子 4 张即可连出，连对 2 对即可连出。',
    conflicts: [],
  },
  {
    id: 'openLandlord',
    name: '明牌地主',
    short: '6底牌·地主明牌',
    description: '底牌增至 6 张（每人发 16 张，地主共 22 张），确立地主后地主强制全程明牌（不额外翻倍）。',
    conflicts: [],
  },
  {
    id: 'bombAllergy',
    name: '炸弹过敏',
    short: '出炸弹弃1张',
    description: '每打出一个炸弹（不含王炸），出牌者立即随机弃掉手里 1 张牌并公开展示；若已出完则直接获胜。',
    conflicts: [],
  },
  {
    id: 'wildDrop',
    name: '天降癞子',
    short: '随机癞子',
    description: '本局随机指定一种点数为万能癞子（不可当王），可补牌型或组软炸弹／纯癞子炸弹。',
    conflicts: [],
  },
  {
    id: 'telepathy',
    name: '心灵感应',
    short: '农民互看手牌',
    description: '确定地主后，两位农民互相可见对方手牌（不额外翻倍），地主看不到。',
    conflicts: [],
  },
  {
    id: 'multiplierSurge',
    name: '倍率狂飙',
    short: '底倍×2·炸弹×3',
    description: '开局初始倍率直接 ×2，且每次炸弹或王炸改为 ×3。',
    conflicts: [],
  },
]);

export const AFFIX_MAP: ReadonlyMap<AffixId, AffixInfo> = new Map(AFFIX_LIST.map(item => [item.id, item]));

export function affixInfo(id: AffixId): AffixInfo | null {
  return AFFIX_MAP.get(id) ?? null;
}

export function resolveRules(affixes: readonly AffixId[] = [], laiziRank: number | null = null): RuleConfig {
  const has = (id: AffixId) => affixes.includes(id);
  return {
    laiziRank,
    threeIsHighest: has('underdog'),
    minStraight: has('imperfect') ? 4 : 5,
    minPairStraight: has('imperfect') ? 2 : 3,
    bottomCount: has('openLandlord') ? 6 : 3,
    landlordOpen: has('openLandlord'),
    farmerTelepathy: has('telepathy'),
    bombDiscard: has('bombAllergy'),
    initialMultiplier: has('multiplierSurge') ? 2 : 1,
    bombMultiplier: has('multiplierSurge') ? 3 : 2,
  };
}

export function rollAffixes(random: () => number, count = 2): AffixId[] {
  const pool = [...AFFIX_LIST];
  const picked: AffixId[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    const candidate = pool.splice(index, 1)[0];
    if (picked.some(id => candidate.conflicts.includes(id) || AFFIX_MAP.get(id)?.conflicts.includes(candidate.id))) {
      continue;
    }
    picked.push(candidate.id);
  }
  return picked;
}
