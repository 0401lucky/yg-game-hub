import type { Express } from 'express';
import type { IncomingMessage } from 'node:http';
import type WebSocket from 'ws';
import type { PublicUser, WireProtocol } from '../games/shared/protocol.ts';
import type { DailyStats } from './dailyStats.ts';
import type * as auth from './auth.ts';
import type { GameSnapshot } from '../web/operationsProtocol.ts';

export interface AccountSocket extends WebSocket { user?: PublicUser | null }
export interface CleanupResult { sessions: number; rooms: number; connections: number }
export interface GameContext {
  auth: typeof auth;
  stats: DailyStats;
  sanitizeText(input: unknown): string;
}
export type GameProtocol<Client extends { type: string }, Server extends { type: string }> = WireProtocol<Client, Server>;

/** A game owns its routes, room state and protocol; the host owns the port. */
export interface GameModule<Client extends { type: string } = { type: string }, Server extends { type: string } = { type: string }> {
  id: string;
  websocketPaths: readonly string[];
  fallbackWebSocket?: boolean;
  protocol?: GameProtocol<Client, Server>;
  registerHttp(app: Express): void;
  getOverview?(): GameSnapshot;
  handleConnection?(ws: AccountSocket, request: IncomingMessage): void;
  start?(): void;
  cleanup?(): CleanupResult;
  close?(): void;
}
export type GameFactory = (context: GameContext) => GameModule | Promise<GameModule>;
