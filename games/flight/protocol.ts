import type { Messages, PlayerId, WireProtocol } from '../shared/protocol.ts';
import type {
  AIPlayer, ChatItem, FlightAction, FlightEvent, FlightGameData, FlightPlayer,
  FlightRoomInfo, FlightSessionInfo, GameSnapshot, PlayerStats, ProgressSample,
  RoomSettings, RoomSummary, FlightTitleStats,
} from './types.ts';

export interface FlightClientPayloads {
  ping: { timestamp?: number; immediate?: boolean };
  pong: Record<never, never>;
  identify: { playerId?: PlayerId | null };
  getReconnectInfo: Record<never, never>;
  createRoom: { requestId?: string; nickname?: string | null; emoji?: string; maxPlayers?: number; gameMode?: string };
  join_room: { roomCode: string; nickname?: string | null; emoji?: string };
  spectate_room: { roomCode: string; nickname?: string };
  listRooms: Record<never, never>;
  leaveRoom: { reason?: string };
  leave_room: { reason?: string };
  select_color: { colorIndex: number };
  update_nickname: { nickname: string | null; manualInput?: boolean };
  update_emoji: { emoji: string };
  player_stats: { stats: PlayerStats };
  teleportIcon: { player?: number; isActive?: boolean };
  diceReset: { player?: number };
  progressBarStart: { thinkingStartTime?: number; player?: number };
  rejoinRoom: { roomCode: string; isReady?: boolean };
  rejoinGameSession: { gameSessionId: string; needsHistory?: boolean };
  intent: { intent: FlightAction; action?: string };
  animationDone: { seq: number; hidden?: boolean };
  visibilityChange: { hidden: boolean };
  snapshotRequest: Record<never, never>;
  updatePlayer: { nickname?: string | null; emoji?: string; color?: number };
  updateSettings: { settings: Partial<RoomSettings> };
  update_room_name: { name: string | null };
  update_room_privacy: { isPrivate: boolean };
  returnToRoom: Record<never, never>;
  toggle_ready: { isReady?: boolean };
  start_game: { settings?: Partial<RoomSettings> };
  startGame: { settings?: Partial<RoomSettings> };
  add_ai_player: { colorIndex: number; difficulty?: string };
  remove_ai_player: { colorIndex: number };
  update_ai_difficulty: { colorIndex: number; difficulty: string };
  kickPlayer: { playerId: PlayerId };
  configure_piece_count: { pieceCount: number };
  aiTakeoverChange: { playerId?: PlayerId | null; isActive: boolean; auto?: boolean; reason?: string };
  audioEnabledChange: { enabled: boolean; playerId?: PlayerId | null };
  nicknameChange: { playerId?: PlayerId; nickname: string | null; manualInput?: boolean };
  gameEnd: { winnerPlayer: number; titleStats?: TitleStats | null };
  forceSettlement: { rankings: Ranking[]; titleStats?: TitleStats | null };
  gamePause: Record<never, never>;
  gameResume: Record<never, never>;
  gameInfo: { messageData: GameInfoMessage };
  audioLoaded: { gameSessionId?: string };
  chatMessage: { message: string; playerNumber?: number | null; playerName?: string | null };
  // Kept for older clients: the authoritative server deliberately ignores these.
  diceRoll: { diceValue: number; player?: number };
  playerTurnChange: { newPlayer: number };
  pieceMove: { player: number; chessIndex: number; position: number };
  chessMove: { player: number; chessIndex: number; position: number };
  finalMoveResult: { player: number; chessIndex: number; position: number };
  moveChessToStart: { player: number; chessIndex: number };
  moveChessToFinish: { player: number; chessIndex: number };
  noMovableChess: { player?: number };
  defeatCountChange: { attacker: number; target: number; count: number };
  boardSyncData: { playerChess: FlightGameData['playerChess'] };
  audioReady: Record<never, never>;
  error: { message: string };
}

export type TitleStats = Partial<FlightTitleStats> & {
  totalDistance?: Record<number, number>; totalEnergyGained?: Record<number, number>;
  diceStatistics?: Record<number, Record<number, number>>;
  skillUsage?: Record<number, {remoteDice: number; teleport: number; polyhedralDice: number; mysteryBox: number}>;
  defeatCounts?: Record<number, Record<number, number>>;
};
export interface Ranking {
  player: number; rank?: number; position?: number; progress?: number; nickname?: string; playerName?: string;
  finished?: number; finishedCount?: number; totalDistance?: number; defeats?: number; defeatCounts?: Record<number, number>;
}
export type GameInfoMessage = {type: string; player: number | null; data: GameInfoData; timestamp?: number}
  | {type: 'gamePause' | 'gameResume'; timestamp: number; player?: undefined; data?: undefined};
export interface GameInfoData {
  [key: string]: unknown;
  skillName?: string; moveType?: string; chessIndex?: number | null; diceValue?: number; value?: number;
  fromPosition?: number | null; toPosition?: number | null; targetPlayer?: number | null; targetChessIndex?: number | null;
  reward?: number; energy?: number | null; amount?: number; steps?: number; source?: string; message?: string;
  playerName?: string | null; text?: string; moveTypes?: string[]; defeatedPlayer?: number; titleName?: string;
  targetChess?: number | null; position?: number; isSpectatorMessage?: boolean; diceValueNullable?: number | null;
}
export interface PlayerUpdate {
  player?: FlightPlayer; players?: FlightPlayer[]; room?: FlightRoomInfo;
  gameSession?: FlightSessionInfo; playerId?: PlayerId; timestamp?: number;
}
export interface FlightServerPayloads {
  connected: { playerId: PlayerId };
  pong: { timestamp: number; playerId: PlayerId };
  error: { message: string; code?: string };
  reconnectInfo: { canReconnect: boolean; roomCode: string | null; source?: 'room' | 'gameSession' };
  roomsList: { rooms: RoomSummary[] };
  roomCreated: { room: FlightRoomInfo; replayed?: boolean };
  roomJoined: { room: FlightRoomInfo; gameData?: Partial<FlightGameData> & {gameSessionId: string}; gameSessionId?: string };
  roomRejoined: { playerId: PlayerId; roomCode: string; room: FlightRoomInfo };
  spectateJoined: { room: FlightRoomInfo; gameData?: FlightGameData; gameSessionId?: string; gameSession?: FlightSessionInfo; isReconnect?: boolean };
  roomLeft: { soft?: boolean };
  playerJoined: PlayerUpdate;
  playerLeft: PlayerUpdate & { reason?: string };
  playerUpdated: PlayerUpdate;
  playerDisconnected: PlayerUpdate;
  playerReconnected: PlayerUpdate;
  hostTransferred: { newHostId: PlayerId; newHostNickname: string; room: FlightRoomInfo };
  hostChanged: { oldHostId: PlayerId | null; newHostId: PlayerId; newHostNickname: string; gameSession: FlightSessionInfo; timestamp: number };
  kicked: { reason: string; message: string };
  roomNameUpdated: { name: string; room: FlightRoomInfo };
  roomPrivacyUpdated: { isPrivate: boolean; room: FlightRoomInfo };
  roomReset: { room: FlightRoomInfo };
  roomUpdated: { room: FlightRoomInfo };
  settingsUpdated: { settings: RoomSettings; room: FlightRoomInfo };
  playerReadyStatusChanged: { playerId: PlayerId; isReady: boolean };
  gameStarted: { gameSessionId: string; pieceCount: number; skillMode: boolean; happyMode: boolean; room: FlightRoomInfo };
  aiPlayerAdded: { aiPlayer: AIPlayer; room: FlightRoomInfo };
  aiPlayerRemoved: { colorIndex: number; room: FlightRoomInfo };
  aiDifficultyUpdated: { colorIndex: number; difficulty: string; room: FlightRoomInfo };
  pieceCountConfigured: { pieceCount: number; room: FlightRoomInfo };
  gameSessionConnected: { playerId: PlayerId; gameSessionId: string; gameSession: FlightSessionInfo; audioLoadedPlayers?: PlayerId[]; gameData?: Partial<FlightGameData> };
  gameSnapshot: Omit<GameSnapshot, 'type'>;
  intentRejected: { gameSessionId: string; reason: string; intent: FlightAction };
  gameInfoHistory: { gameSessionId: string; events: FlightEvent[][]; chat: ChatItem[] };
  chatMessage: ChatItem;
  gameInfo: { playerId: PlayerId; messageData: GameInfoMessage; timestamp?: number };
  playerTurnChange: { newPlayer: number; reason?: string; timestamp: number };
  teleportIcon: { playerId: PlayerId; timestamp?: number };
  diceReset: { playerId: PlayerId; timestamp?: number };
  progressBarStart: { playerId: PlayerId; timestamp?: number };
  aiTakeoverChange: { playerId: PlayerId; isActive: boolean; auto?: boolean; reason?: string; timestamp?: number };
  audioEnabledChange: { playerId: PlayerId; enabled: boolean; timestamp: number };
  nicknameChange: { playerId: PlayerId; nickname: string; timestamp?: number };
  gamePaused: { playerId: PlayerId; timestamp?: number };
  gamePause: { playerId: PlayerId; timestamp?: number };
  gameResumed: { playerId: PlayerId; reason?: string; timestamp?: number };
  gameResume: { playerId: PlayerId; reason?: string; timestamp?: number };
  gameAutoPaused: { reason: string; message: string; timestamp: number };
  roomDestroying: { reason: string; message: string; timestamp: number; roomCode?: string };
  playerNicknameUpdated: {playerId: PlayerId; nickname: string};
  playerEmojiUpdated: {playerId: PlayerId; emoji: string};
  roomConfigUpdated: {pieceCount?: number; aiPlayers?: AIPlayer[]};
  gameEnd: { playerId: PlayerId; winnerPlayer: number; titleStats?: TitleStats; timestamp?: number; gameStartTime?: number; progressHistory?: ProgressSample[]; currentRound?: number };
  forceSettlement: { playerId: PlayerId; rankings: Ranking[]; titleStats?: TitleStats; timestamp?: number; gameStartTime?: number; progressHistory?: ProgressSample[]; currentRound?: number };
  audioLoaded: { playerId: PlayerId; loadedCount: number; totalCount: number; allLoaded: boolean };
  allAudioLoaded: { gameSessionId: string; isResync?: boolean };
}

export interface FlightEnvelope { playerId?: PlayerId | null; roomCode?: string | null; timestamp?: number }
export type FlightSendPayload<Type extends keyof FlightClientPayloads> = FlightClientPayloads[Type] & FlightEnvelope & {gameSessionId?: string | null};
export type FlightClientMessage = Messages<FlightClientPayloads> & FlightEnvelope;
export type FlightClientWireMessage = FlightClientMessage | {
  [Type in keyof FlightClientPayloads]: { type: Type; data: FlightClientPayloads[Type] } & FlightEnvelope;
}[keyof FlightClientPayloads];
export type FlightServerMessage = Messages<FlightServerPayloads>;
export type FlightRequest<Type extends keyof FlightClientPayloads> = Extract<FlightClientMessage, { type: Type }>;
export type FlightResponse<Type extends keyof FlightServerPayloads> = Extract<FlightServerMessage, { type: Type }>;

/** Historical clients use both a flat payload and an envelope with nested data. */
export function normalizeInboundMessage(value: unknown): FlightClientMessage {
  if (!value || typeof value !== 'object') return value as FlightClientMessage;
  const message = value as FlightClientWireMessage;
  const payload = 'data' in message ? message.data : null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return message as FlightClientMessage;
  const { data: _data, ...envelope } = message as { data: unknown; type: string } & FlightEnvelope;
  return { ...envelope, ...payload, type: envelope.type } as FlightClientMessage;
}
export const flightServerProtocol: WireProtocol<FlightClientMessage, FlightServerMessage> = {
  decode: normalizeInboundMessage,
  encode: message => JSON.stringify(message),
};
export const flightClientProtocol: WireProtocol<FlightServerMessage, FlightClientWireMessage> = {
  decode: value => {
    if (!value || typeof value !== 'object') return value as FlightServerMessage;
    const incoming = value as {type: string; data?: unknown};
    if (!incoming.data || typeof incoming.data !== 'object' || Array.isArray(incoming.data)) return value as FlightServerMessage;
    const { data, ...envelope } = incoming;
    return { ...envelope, ...data, type: envelope.type } as FlightServerMessage;
  },
  encode: message => JSON.stringify(message),
};
