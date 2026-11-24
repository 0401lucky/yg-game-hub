import type { FlyingChessGameBase } from './gameBase.ts';
import type { gameState } from './gameState.ts';
import type { animation } from './animation.ts';
import type { uiUpdater } from './uiUpdater.ts';
import type { dice } from './dice.ts';
import type { eventHandler } from './eventHandler.ts';
import type { gameInfo } from './gameInfo.ts';
import type { energyDisplay } from './energyDisplay.ts';
import type { energyManager } from './energyManager.ts';
import type { progressDisplay } from './progressDisplay.ts';
import type { defeatCountDisplay } from './defeatCountDisplay.ts';
import type { skillManager } from './skillManager.ts';
import type { multiplayerGameManager } from './multiplayerGameManager.ts';
import type { botController } from './botController.ts';
import type { lightningManager } from './lightningManager.ts';
import type { utils } from './utils.ts';
import type { FlightClientPayloads, FlightServerMessage, GameInfoMessage, Ranking } from '../protocol.ts';
import type { EngineState, FlightEvent, FlightTitleStats, PackedAction, PackedReplay, ProgressSample, ReplayArchive, ReplayConfig } from '../types.ts';

export type GameStateModel = typeof gameState;
export type AnimationModel = typeof animation;
export type UIUpdaterModel = typeof uiUpdater;
export type DiceModel = typeof dice;
export type EventHandlerModel = typeof eventHandler;
export type GameInfoModel = typeof gameInfo;
export type EnergyDisplayModel = typeof energyDisplay;
export type EnergyManagerModel = typeof energyManager;
export type ProgressDisplayModel = typeof progressDisplay;
export type DefeatCountDisplayModel = typeof defeatCountDisplay;
export type SkillManagerModel = typeof skillManager;
export type MultiplayerGameModel = typeof multiplayerGameManager;
export type BotControllerModel = typeof botController;
export type LightningManagerModel = typeof lightningManager;
export type UtilsModel = typeof utils;
export type GameRuntime = FlyingChessGameBase & { lightningManager?: LightningManagerModel; localPlayerColor?: number | null; isReplay?: boolean; isTeleportMode?: boolean; updateMultiplayerState?: (data?: unknown) => void };
export interface Point { x: number; y: number }
export interface ChessElement extends SVGUseElement { _moveToken?: object | null; offsetWidth?: number }
export interface UIChess { position: number; finished: boolean; element: ChessElement | null; lastLandPos: number }
export type ChessBoard = Record<number, UIChess[]>;
export type TitleTier = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
export interface TitleDefinition { id: string; name: string; desc: string; tier: TitleTier; min?: number; note?: string; happyDisabled?: boolean; happyOnly?: boolean; itemOnly?: boolean; source?: string | TitleFamily }
export interface TitleFamily { key: string; value(stats: FlightTitleStats, player: number): number; levels: (TitleDefinition & {min: number})[]; happyDisabled?: boolean; happyOnly?: boolean; itemOnly?: boolean; note?: string }
export interface UIRanking extends Ranking { progress: number; playerName?: string; finishedCount?: number; defeatCounts: Record<number, number>; title?: TitleDefinition[]; titles?: TitleDefinition[]; emoji?: string; isAI?: boolean; isWinner?: boolean; playerNumber?: number; progressPercentage?: number }
export interface TitleCarousel { titleContent: HTMLElement; titleBadge: HTMLElement; titleDesc: HTMLElement; ribbon: HTMLElement | null; titles: (TitleDefinition | undefined)[]; index: number }
export interface GameSummaryPlayer {seat: number; rank: number; name: string; isAI: boolean; emoji?: string | null; progress: number; finished: number; defeatCounts: Record<number, number>; titles: string[]}
export interface LocalPlayer { id?: number; name?: string; playerNumber?: number; nickname?: string; emoji?: string | {key: string}; emojiIndex?: number; aiEmojiKey?: string; isAI?: boolean; difficulty?: string }
export interface SetupPlayer extends LocalPlayer {id: number; name: string; emojiIndex: number}
export interface GameConfig {
  mode?: string; playerCount?: number; pieceCount?: number; players?: LocalPlayer[]; bots?: number[];
  humanPlayer?: number; humanUsername?: string; selectedPlayer?: number; selectedEmoji?: string;
  skillMode?: boolean; happyMode?: boolean; initialEnergy?: number; botDifficulties?: Record<number, string>;
  humanEmoji?: string;
}
export interface LocalGameClient {
  titleStats?: FlightTitleStats | null; announcedTitles?: [string, number][] | null;
  diceStatistics?: Record<number, Record<number, number>> | null; progressHistory?: ProgressSample[] | null;
  gameStartTime?: number | null; playedMs?: number; gameConfig?: string | null;
  totalEnergyGained?: Record<number, number> | null;
  skillUsage?: Record<number, {remoteDice: number; teleport: number; polyhedralDice: number; mysteryBox: number}> | null;
}
export interface LocalGameSave { state: EngineState; seed: number | null; rngState?: number | null; actions: PackedAction[]; client?: LocalGameClient | null; replayConfig?: ReplayConfig; defeats?: Record<number, Record<number, number>> | null; savedAt?: number }
export interface RecentReplay { id: string; at: number; archive: PackedReplay }
export interface StatsTotals { games: number; wins: number; seconds: number; distance: number; kills: number; titles: number }
export interface StatsBucket { totals: StatsTotals; titles: Record<string, {count: number; firstAt: number; lastAt: number}> }
export interface FinishedGame {
  id: string; at: number; mode: string; modeKey: string; players: GameSummaryPlayer[]; pieces: number; kind: string;
  nickname: string; mySeat: number; won: boolean; finished: boolean; winner: number; turns: number;
  hands: number; seconds: number; kills: number; distance: number; progress: number; replayId: string | null; titles?: string[];
}
export interface StatsProfile { modes: Record<string, StatsBucket>; games: FinishedGame[] }
export type FinishedGameInput = Omit<Partial<FinishedGame>, 'players'> & { mode: string; players?: GameSummaryPlayer[] };
export type PendingMessage = { [Type in keyof FlightClientPayloads]: {type: Type; data: import('../protocol.ts').FlightSendPayload<Type>} }[keyof FlightClientPayloads];
export interface MultiplayerGameData {
  gameSessionId?: string; roomCode?: string; room?: import('../types.ts').FlightRoomInfo;
  players?: import('../types.ts').FlightPlayer[]; pieceCount?: number; skillMode?: boolean; happyMode?: boolean;
  isHost?: boolean; isSpectator?: boolean; isReconnecting?: boolean;
  wsClient?: {playerId?: string | number | null; serverUrl?: string}; gameData?: import('../types.ts').FlightGameData;
  currentPlayer?: import('../types.ts').FlightPlayer;
}
export interface MessageMerge { element: HTMLElement; html: string }
export interface MoveLine { player: number; chessIndex: number; moveTypes: string[]; element: HTMLElement; bonus: number }
export interface SkillLine { player: number; skillName: string; element: HTMLElement; chessIndex: number | null; fromPosition?: number; toPosition?: number; diceValue?: number }
export type ReplayWithClient = ReplayArchive & { client?: LocalGameClient | null };
export type SnapshotLike = Extract<FlightServerMessage, {type: 'gameSnapshot'}>;
export type LogMessage = GameInfoMessage;
export type EngineEvents = FlightEvent[];
