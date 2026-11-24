export type CardId = string;
export type Difficulty = 'easy' | 'hard' | 'hell';
export type PatternType = 'single' | 'pair' | 'triple' | 'tripleSingle' | 'triplePair' | 'straight' | 'pairStraight' | 'airplane' | 'airplaneSingle' | 'airplanePair' | 'fourSingles' | 'fourPairs' | 'bomb' | 'rocket';
export interface Pattern { type: PatternType; label: string; rank: number; size: number; chain: number }
export interface Play { cards: CardId[]; pattern: Pattern }
export interface Trick extends Play { seat: number }
export interface CardInfo { id: CardId; rank: number; label: string; suit: string; symbol: string; red: boolean }
export type Action = { type: 'bid'; score: number } | { type: 'play'; cards: CardId[] } | { type: 'pass' };
export type ActionSource = 'human' | 'bot' | 'auto' | 'timeout' | 'fallback';
export type GameEvent = (
  | { type: 'deal' | 'redeal'; id?: number }
  | { type: 'bid'; seat: number; score: number; id?: number }
  | { type: 'landlord'; seat: number; landlordSeat: number; score: number; id?: number }
  | { type: 'pass'; seat: number; resetTrick?: boolean; id?: number }
  | { type: 'play'; seat: number; cards: CardId[]; pattern: Pattern; ended?: boolean; spring?: boolean; id?: number }
) & { source?: ActionSource; pattern?: Pattern };
export type TablePlay = (Play & {pass?: undefined}) | { pass: true; cards?: undefined; pattern?: undefined } | null;
export interface GameState {
  seed: number; firstBidder: number; deal: number; seq: number; phase: 'bidding' | 'playing' | 'ended';
  turn: number | null; hands: CardId[][]; bottom: CardId[]; bids: number[]; highestBid: number;
  highestBidder: number | null; landlordSeat: number | null; multiplier: number;
  trick: Trick | null; passes: number; tablePlays: TablePlay[]; playedCards: CardId[][];
  playCounts: number[]; history: GameEvent[]; lastAction: GameEvent;
  winnerSide: 'landlord' | 'farmers' | null; winnerSeat: number | null; spring: boolean; scores: number[] | null;
}
export interface PublicGame extends Omit<GameState, 'seed' | 'firstBidder' | 'hands' | 'highestBidder'> {
  hand: CardId[]; counts: number[]; revealedHands?: CardId[][]; deadline?: number | null;
}
export interface BotView extends PublicGame { seat: number }
export type ActionResult = { ok: true; state: GameState } | { ok: false; code: string; reason: string };
export interface PlayerInfo {
  id: string; nickname: string; seat: number; isBot: boolean; level?: Difficulty;
  ready: boolean; connected: boolean; auto: boolean; autoReason?: string | null;
  rematchReady: boolean; avatar: string;
}
export interface RoomInfo {
  code: string; hostId: string; difficulty: Difficulty; autoFill: boolean; round: number;
  players: (PlayerInfo | null)[];
}
export interface RoomSummary {
  code: string; phase: string; difficulty: Difficulty; playerCount: number; humans: number; openSeats: number;
}
