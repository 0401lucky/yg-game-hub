import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { ClientPayloads, Response, ServerMessage } from '../../games/doudizhu/protocol.ts';
import type { ActionResult } from '../../games/doudizhu/types.ts';
import type { FlightClientPayloads, FlightClientWireMessage, FlightResponse, FlightServerMessage } from '../../games/flight/protocol.ts';
import { flightClientProtocol } from '../../games/flight/protocol.ts';

export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function waitUntil<Value>(predicate: () => Value, timeout = 6000): Promise<NonNullable<Value>> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value as NonNullable<Value>;
    await delay(12);
  }
  throw new Error('等待测试状态超时');
}
export function acceptedState(result: ActionResult) {
  assert(result.ok, JSON.stringify(result));
  return result.state;
}
export function rejectionCode(result: ActionResult) {
  assert(!result.ok, '应拒绝非法操作');
  return result.code;
}
export function removeTestDirectory(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('yg-ts-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

/** Each HTTP suite gets its own Node process, port, session secret and SQLite. */
export async function startHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-ts-test-'));
  const child = fork(new URL('../../tools/test-server.ts', import.meta.url), [], {
    execPath: process.execPath,
    env: { ...process.env, PORT: '0', YG_TEST_DATA_DIR: dataDir, SESSION_SECRET: 'isolated-typescript-tests' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let logs = '';
  child.stdout?.on('data', chunk => { logs = (logs + String(chunk)).slice(-30000); });
  child.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-30000); });
  const ready = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`测试服务启动超时\n${logs}`)), 15000);
    child.on('message', message => {
      if (message && typeof message === 'object' && 'port' in message && typeof message.port === 'number') {
        clearTimeout(timeout); resolve(message.port);
      }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`测试服务退出 ${code}\n${logs}`)); });
    child.once('error', reject);
  });
  try {
    const port = await ready;
    return { base: `http://127.0.0.1:${port}`, dataDir, logs: () => logs, async close() {
      const exited = once(child, 'exit');
      child.send({ type: 'shutdown' });
      const killer = setTimeout(() => child.kill(), 5000);
      await exited; clearTimeout(killer); removeTestDirectory(dataDir);
    } };
  } catch (error) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    removeTestDirectory(dataDir); throw error;
  }
}

export class CardClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  state: Response<'state'> | null = null;
  token: string | null = null;
  playerId: string | null = null;
  closeCode: number | null = null;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', raw => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(message);
      if (message.type === 'welcome') { this.token = message.token; this.playerId = message.playerId; }
      if (message.type === 'state') this.state = message;
    });
    ws.on('close', code => { this.closeCode = code; });
  }
  send<Type extends keyof ClientPayloads>(type: Type, data?: ClientPayloads[Type], requestId?: string) {
    this.ws.send(JSON.stringify({ type, data: data ?? {}, requestId }));
  }
}

export class FlightClient {
  readonly ws: WebSocket;
  readonly playerId: string;
  readonly inbox: FlightServerMessage[] = [];
  private constructor(ws: WebSocket, playerId: string) {
    this.ws = ws; this.playerId = playerId;
    ws.on('message', raw => this.inbox.push(flightClientProtocol.decode(JSON.parse(String(raw)))));
  }
  static async connect(base: string, playerId = `test_${crypto.randomUUID()}`, cookie?: string) {
    if (!playerId.startsWith('player_')) playerId = `player_${playerId}`;
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', cookie ? { headers: { Cookie: cookie } } : {});
    const client = new FlightClient(ws, playerId);
    await once(ws, 'open'); client.send('identify', { playerId });
    await client.wait('connected', message => message.playerId === playerId);
    return client;
  }
  send<Type extends keyof FlightClientPayloads>(type: Type, data?: FlightClientPayloads[Type], flat = false): void {
    const message = flat ? { type, ...data, playerId: this.playerId } : { type, data: data ?? {}, playerId: this.playerId, timestamp: Date.now() };
    this.ws.send(flightClientProtocol.encode(message as FlightClientWireMessage));
  }
  async wait<Type extends FlightServerMessage['type']>(type: Type, predicate: (message: FlightResponse<Type>) => unknown = () => true) {
    return waitUntil(() => this.inbox.find((message): message is FlightResponse<Type> => message.type === type && Boolean(predicate(message as FlightResponse<Type>))));
  }
  clear(): void { this.inbox.length = 0; }
  close(): void { this.ws.terminate(); }
}
