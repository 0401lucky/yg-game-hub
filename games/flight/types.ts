import type { PlayerId } from '../shared/protocol.ts';

export type Color = number;
export type FlightPhase = 'rolling' | 'selecting' | 'ended';
export type UIPhase = FlightPhase | 'waiting' | 'moving' | 'finished' | 'paused';
export type Item = 'remote-dice' | 'polyhedral-dice' | 'teleport' | 'mysteryBox';
export type Random = (() => number) & { current?: () => number };
export type NumberMap = Record<number, number>;
export type DefeatMatrix = Record<number, NumberMap>;
export interface ProgressSample { round: number; players: NumberMap }
export interface FlightTitleStats {
  consecutiveOnes: NumberMap; sixStreak: NumberMap; runwayKills: NumberMap; blockCount: NumberMap;
  consecutiveNoTakeoff: NumberMap; maxConsecutiveOnes: NumberMap; maxConsecutiveNoTakeoff: NumberMap;
  maxConsecutiveSixes: NumberMap; firstFinishedPlayer: number | null; firstBeaterPlayer: number | null;
  maxBeatsInMove: NumberMap; maxCollideInMove: NumberMap; bounceSteps: NumberMap;
  maxTeleportDistance: NumberMap; maxMoveDistance: NumberMap; mysteryBoxMax: NumberMap;
  mysteryBoxMin: NumberMap; polyhedralMax: NumberMap; polyhedralMin: NumberMap; skillUseCount: NumberMap;
  airportSteps: Record<number, number[]>; airportClock: Record<number, number[]>; turnClock: number;
  airportRekt: NumberMap; pettyTeleports: NumberMap;
  revenge: Record<number, { attacker: number; chess: number; armed: boolean } | null>;
  revengeKills: NumberMap;
  lastKill: Record<number, { chess: number; victim: number; armed: boolean } | null>;
  orioleKills: NumberMap; rerollSeat: number | null;
}

export type FlightAction =
  | { type: 'roll'; value?: number | null; maxDice?: number; noBonus?: boolean; item?: Item | null }
  | { type: 'move' | 'teleport'; chessIndex: number }
  | { type: 'skip'; reason?: 'mysteryBox' | null }
  | { type: 'item'; item?: Item | null }
  | { type: 'debug'; op: string; player?: number; chessIndex?: number; value?: number; delta?: number };

export interface EngineChess { pos: number; finished: boolean }
export interface EnginePlayer { id: Color; chesses: EngineChess[]; totalDistance: number; defeats: number }
export interface EngineState {
  order: Color[];
  currentIndex: number;
  currentPlayer: Color;
  phase: FlightPhase;
  dice: number | null;
  diceItem: boolean | Item;
  pendingItem: { player: Color; item: Item; cost?: number } | null;
  consecutiveSixes: number;
  turn: number;
  winner: Color | null;
  happy: boolean;
  skillMode: boolean;
  players: Record<number, EnginePlayer>;
  energy: NumberMap;
}

export interface PathStep { rel: number; cell: number | null }
export interface CollisionBonus {
  type: 'collision_bonus'; player: Color; targetPlayer: Color; targetChess: number;
  cell: number | null; enemyCount: number; steps: number; reward: number; energy: number;
}
export type FlightEvent =
  | { type: 'dice'; player: Color; value: number; item: boolean | Item | null; cost: number; sixStreak: number }
  | { type: 'launch'; player: Color; chess: number; to: number }
  | { type: 'walk'; player: Color; chess: number; from: number; to: number; path: PathStep[]; bounced: boolean; bounceReason: string | null; bounceSteps: number; blocker: Color | null }
  | { type: 'jump' | 'fly'; player: Color; chess: number; from: number; to: number; path: number[] }
  | { type: 'finish'; player: Color; chess: number }
  | { type: 'beat'; player: Color; targetPlayer: Color; chess: number; cell: number | null; itemRoll: boolean | Item; reward: number; energy: number }
  | { type: 'collide'; player: Color; targetPlayer: Color; cell: number | null; chesses: { player: Color; index: number }[]; reward?: number; energy?: number }
  | CollisionBonus
  | { type: 'stack'; player: Color; cell: number; chesses: number[]; count: number }
  | { type: 'blocked'; reason: string; player: Color; chess: number; cell: number | null; targetPlayer: Color }
  | { type: 'reset'; player: Color; reason: 'three-sixes'; pieces: number[] }
  | { type: 'skip'; player: Color; value: number }
  | { type: 'pass'; player: Color; reason: string | null }
  | { type: 'turn' | 'reroll'; player: Color }
  | { type: 'end'; winner: Color }
  | { type: 'item_activate'; player: Color; item: Item; cost: number }
  | { type: 'item_cancel'; player: Color; item: Item; refund: number }
  | { type: 'mystery_box'; player: Color; cost: number; amount: number; energy: number }
  | { type: 'teleport'; player: Color; chess: number; from: number; to: number };

export interface BoardChess { position: number; finished: boolean }
export interface GameSnapshot {
  type: 'gameSnapshot'; gameSessionId: string | null; seq: number; currentPlayer: Color;
  gamePhase: FlightPhase; diceValue: number | null; diceItem: boolean | Item; pendingItem: Item | null;
  winner: Color | null; consecutiveSixes: number; round: number; pieceCount: number;
  happyMode: boolean; skillMode: boolean; energy: NumberMap;
  playerChess: Record<number, BoardChess[]>; defeats: NumberMap; totalDistance: NumberMap;
  defeatCounts: DefeatMatrix; progressHistory: ProgressSample[]; events: FlightEvent[];
  thinkingStartTime?: number | null; pausedThinkingMs?: number;
}

export interface PlayerStats { games: number; wins: number; titles: number }
export interface FlightPlayer {
  id: PlayerId; nickname: string; color: Color | null; emoji?: string;
  playerNumber?: Color | null; isAI?: boolean; isHost?: boolean; isConnected?: boolean;
  isAITakeover?: boolean; isReady?: boolean; audioEnabled?: boolean | null;
  disconnectedAt?: number | null; difficulty?: string; stats?: PlayerStats | null;
}
export interface AIPlayer { color: Color; difficulty: string; nickname: string; emoji?: string }
export interface RoomSettings { pieceCount: number; aiPlayers: AIPlayer[]; skillMode: boolean; happyMode: boolean; initialEnergy: number }
export interface ChatItem {
  type?: 'chatMessage'; playerId?: PlayerId; playerNumber?: Color | null; playerName?: string | null;
  message: string; timestamp: number; isSystemMessage?: boolean; isSpectatorMessage?: boolean;
  senderName?: string;
}
export interface FlightGameData {
  gameSessionId: string; gameStartTime: number; currentPlayer: Color | null; gamePhase: UIPhase;
  diceValue: number | null; winner: Color | null; playerChess: Record<number, BoardChess[]>;
  defeatCounts: DefeatMatrix; pieceCount: number; happyMode: boolean; canReroll: boolean;
  consecutiveSixes: number; justRolledSix: boolean; diceValueConsumed: boolean;
  progressHistory: ProgressSample[]; currentRound: number; thinkingStartTime: number | null;
  pausedTotalMs: number; pausedAt: number | null; gameOfficiallyStarted: boolean;
  isPaused?: boolean; pauseReason?: string; gamePhaseBeforePause?: UIPhase;
  skillMode?: boolean;
}
export interface FlightSessionInfo {
  gameSessionId: string; players: FlightPlayer[]; gameState: string;
  createdAt: number; gameData: FlightGameData;
}
export interface FlightRoomInfo {
  code: string; name: string; isPrivate: boolean; host: PlayerId; players: FlightPlayer[];
  gameState: string; displayState: string; gameSession: FlightSessionInfo | null;
  playerReadyStatus: Record<string, boolean>; settings: RoomSettings; roomChatHistory: ChatItem[];
  gameSessionId?: string | null;
}
export interface RoomSummary {
  code: string; name: string; pieceCount: number; skillMode: boolean; happyMode: boolean;
  playerCount: number; maxPlayers: number; gameState: string; createdAt: number; playerIds: PlayerId[];
}

export interface ReplayPlayer { color: Color; nickname: string; isAI: boolean; emoji?: string | null }
export interface ReplayConfig {
  gameSessionId?: string | null; engineVersion: number; colors: Color[]; pieceCount: number;
  happy: boolean; skillMode: boolean; startEnergy: number; players: ReplayPlayer[];
}
export type ReplayActionTuple = number[] | [9, FlightAction];
export type PackedAction = [Color, ...ReplayActionTuple];
export interface ReplayArchive extends ReplayConfig {
  format?: undefined; mode?: string; seed: number; finished: boolean; winner: Color | null;
  turn: number; actionCount?: number; actions: { p: Color; a: FlightAction }[];
}
export interface PackedReplay extends Omit<ReplayArchive, 'format' | 'happy' | 'skillMode' | 'finished' | 'winner' | 'players' | 'actions'> {
  format: 1; happy: number; skillMode: number; finished: number; winner: Color;
  players: [Color, string, number, string?][]; actions: PackedAction[];
}
