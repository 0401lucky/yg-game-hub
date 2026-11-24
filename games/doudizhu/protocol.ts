import type { Messages, WireProtocol } from '../shared/protocol.ts';
import type { Action, Difficulty, PublicGame, RoomInfo } from './types.ts';

export type ReactionKey = 'hello' | 'hurry' | 'nice' | 'thinking' | 'wow' | 'gg';
export interface ClientPayloads {
  hello: { token?: string; nickname?: string };
  ping: Record<never, never>;
  nickname: { nickname: string };
  detachAccount: Record<never, never>;
  create: { difficulty?: Difficulty; nickname?: string; autoFill?: boolean; solo?: boolean };
  join: { code: string; nickname?: string };
  leave: Record<never, never>;
  sync: Record<never, never>;
  ready: { ready: boolean };
  settings: { difficulty?: Difficulty; autoFill?: boolean };
  bot: { seat: number; enabled: boolean };
  start: Record<never, never>;
  action: Action;
  auto: { enabled: boolean };
  reaction: { key: ReactionKey };
  rematch: Record<never, never>;
  lobby: Record<never, never>;
}
export type ClientMessage = { type: 'hello'; token?: string; nickname?: string; data?: ClientPayloads['hello']; requestId?: string } | {
  [Type in Exclude<keyof ClientPayloads, 'hello'>]: { type: Type; data?: ClientPayloads[Type]; requestId?: string };
}[Exclude<keyof ClientPayloads, 'hello'>];
export interface ServerPayloads {
  welcome: { token: string; playerId: string; roomCode: string | null; serverNow: number };
  pong: { serverNow: number };
  state: { revision: number; serverNow: number; room: RoomInfo; me: { id: string; seat: number }; game: PublicGame | null };
  error: { code: string; message: string; requestId?: string };
  left: Record<never, never>;
  superseded: Record<never, never>;
  accountDetached: Record<never, never>;
  reaction: { seat: number; key: ReactionKey; text: string; id: string };
}
export type ServerMessage = Messages<ServerPayloads> & {serverNow?: number};
export type Request<Type extends keyof ClientPayloads> = Extract<ClientMessage, { type: Type }>;
export type Response<Type extends keyof ServerPayloads> = Extract<ServerMessage, { type: Type }>;
export const serverProtocol: WireProtocol<ClientMessage, ServerMessage> = {
  decode: value => value as ClientMessage,
  encode: message => JSON.stringify(message),
};
export const clientProtocol: WireProtocol<ServerMessage, ClientMessage> = {
  decode: value => value as ServerMessage,
  encode: message => JSON.stringify(message),
};
