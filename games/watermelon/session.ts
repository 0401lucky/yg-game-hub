import { MAX_BODIES, MAX_DROPS, MAX_SEGMENT_TICKS, validSnapshot } from './engine.ts';
import type { WatermelonActiveSession, WatermelonDrop, WatermelonResult, WatermelonSegment, WatermelonSessionResponse } from './protocol.ts';
import type { WatermelonInit } from './types.ts';

interface StorageAdapter { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface Recovery { version: 1; session: WatermelonActiveSession; drops: WatermelonDrop[]; toTick: number; paused: boolean }
const prefix = 'yg.watermelon.challenge.v1:';
function storage(): StorageAdapter | undefined {
  if (!('document' in globalThis)) return undefined;
  try { return (globalThis as unknown as { localStorage?: StorageAdapter }).localStorage; } catch { return undefined; }
}
export function readStored<T>(key: string): T | null {
  try { const raw = storage()?.getItem(key); return raw && raw.length <= 300000 ? JSON.parse(raw) as T : null; } catch { return null; }
}
export function writeStored(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
export function removeStored(key: string): void { try { storage()?.removeItem(key); } catch { /* Storage is optional. */ } }
const integer = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
export function validResult(value: unknown): value is WatermelonResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as WatermelonResult;
  return typeof result.id === 'string' && integer(result.score, 0, 2147483647) && integer(result.highest, -1, 8)
    && integer(result.moves, 0, 100000000) && integer(result.durationMs, 0, 1000000000)
    && typeof result.won === 'boolean' && typeof result.recorded === 'boolean' && Number.isFinite(result.endedAt);
}
export function validSession(value: unknown): value is WatermelonActiveSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as WatermelonActiveSession, limits = session.limits;
  return typeof session.session_id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(session.session_id)
    && typeof session.seed === 'string' && /^[\x20-\x7e]{1,128}$/.test(session.seed)
    && session.engine_version === 'watermelon-v1' && session.tick_rate === 120 && validSnapshot(session.state)
    && session.base_tick === session.state.tick && session.base_moves === session.state.drops
    && typeof session.paused === 'boolean' && (session.result === null || validResult(session.result))
    && Boolean(limits && integer(limits.max_segment_ticks, 1, MAX_SEGMENT_TICKS)
      && integer(limits.max_drops, 1, MAX_DROPS) && integer(limits.max_bodies, 1, MAX_BODIES));
}
export function readRecovery(owner: string): Recovery | null {
  const saved = readStored<Recovery>(prefix + owner);
  if (!saved || saved.version !== 1 || !validSession(saved.session) || !integer(saved.toTick, saved.session.base_tick, saved.session.base_tick + 72000)
    || !Array.isArray(saved.drops) || saved.drops.length > 512) return null;
  let tick = saved.session.base_tick;
  for (const drop of saved.drops) {
    if (!drop || !integer(drop.tick, tick, saved.toTick) || !integer(drop.x, 0, 360)) return null;
    tick = drop.tick;
  }
  return saved;
}
export function clearRecovery(owner: string): void { removeStored(prefix + owner); }

export class ApiError extends Error {
  readonly status: number;
  readonly session: WatermelonActiveSession | null;
  constructor(status: number, message: string, session: WatermelonActiveSession | null = null) {
    super(message); this.status = status; this.session = session;
  }
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api/watermelon/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { error?: string; session?: WatermelonActiveSession } | null;
    if (!response.ok || !payload) throw new ApiError(response.status, payload?.error || '暂时无法同步这局，请重试', validSession(payload?.session) ? payload.session : null);
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, '连接中断，进度已留在本机');
  } finally { clearTimeout(timer); }
}

type Send = (path: string, body: WatermelonSegment) => Promise<WatermelonSessionResponse>;
export class ChallengeSession {
  active: WatermelonActiveSession;
  readonly owner: string;
  private pending: WatermelonDrop[] = [];
  private toTick: number;
  private paused: boolean;
  private lastSaved = 0;
  private syncing: Promise<WatermelonActiveSession> | null = null;
  private finishing: Promise<WatermelonSessionResponse> | null = null;
  private packet: WatermelonSegment | null = null;
  private finalPacket: WatermelonSegment | null = null;
  private readonly send: Send;
  constructor(active: WatermelonActiveSession, owner: string, saved: Recovery | null = readRecovery(owner), send: Send = request) {
    if (!validSession(active)) throw new ApiError(0, '本局进度无效，请重新连接');
    this.active = active; this.owner = owner; this.toTick = active.base_tick; this.paused = true; this.send = send;
    if (saved && saved.session.session_id === active.session_id && saved.session.seed === active.seed && !active.result) {
      this.active = saved.session; this.pending = saved.drops.map(drop => ({ ...drop }));
      this.toTick = saved.toTick; this.rebase(active);
    }
    this.persist(true);
  }
  get init(): WatermelonInit {
    return {
      mode: 'challenge', session_id: this.active.session_id, seed: this.active.seed,
      state: this.active.state, limits: this.active.limits, drops: this.pending.map(drop => ({ ...drop })),
      to_tick: this.toTick, paused: true, locked: Boolean(this.active.result),
    };
  }
  private persist(force = false): void {
    if (!force && Date.now() - this.lastSaved < 500) return;
    this.lastSaved = Date.now();
    writeStored(prefix + this.owner, { version: 1, session: this.active, drops: this.pending, toTick: this.toTick, paused: this.paused } satisfies Recovery);
  }
  observe(tick: number, paused: boolean): void {
    if (!integer(tick, this.active.base_tick, this.active.base_tick + 72000)) throw new ApiError(0, '本局进度需要重新同步');
    this.toTick = Math.max(this.toTick, tick);
    const changed = this.paused !== paused; this.paused = paused; this.persist(changed);
  }
  drop(drop: WatermelonDrop, moves: number): void {
    if (moves !== this.active.base_moves + this.pending.length + 1 || this.pending.length >= 512) throw new ApiError(0, '投放记录需要重新同步');
    this.pending.push({ ...drop }); this.toTick = Math.max(this.toTick, drop.tick); this.persist(true);
  }
  private rebase(active: WatermelonActiveSession): boolean {
    if (!validSession(active) || active.session_id !== this.active.session_id || active.seed !== this.active.seed) throw new ApiError(409, '这局已在另一张页面重新开始', active);
    const consumed = active.base_moves - this.active.base_moves;
    const remaining = this.pending.slice(Math.max(0, consumed));
    const ownProgress = consumed >= 0 && consumed <= this.pending.length && active.base_tick <= this.toTick && remaining.every(drop => drop.tick >= active.base_tick);
    this.active = active;
    if (ownProgress) this.pending = remaining;
    else { this.pending = []; this.toTick = active.base_tick; }
    this.persist(true);
    return ownProgress;
  }
  sync(): Promise<WatermelonActiveSession> {
    if (!this.syncing) this.syncing = this.drain().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async drain(): Promise<WatermelonActiveSession> {
    const target = this.toTick;
    let sendPause = this.active.paused !== this.paused;
    while (this.packet || this.active.base_tick < target || this.pending.some(drop => drop.tick <= target) || sendPause) {
      if (!this.packet) {
        let end = Math.min(target, this.active.base_tick + this.active.limits.max_segment_ticks);
        let count = this.pending.findIndex(drop => drop.tick > end);
        if (count < 0) count = this.pending.length;
        if (count > this.active.limits.max_drops) { count = this.active.limits.max_drops; end = this.pending[count - 1].tick; }
        this.packet = {
          request_id: crypto.randomUUID(), session_id: this.active.session_id,
          base_tick: this.active.base_tick, base_moves: this.active.base_moves, to_tick: end,
          drops: this.pending.slice(0, count).map(drop => ({ ...drop })), paused: this.paused,
        };
      }
      try {
        const response = await this.send('checkpoint', this.packet);
        if (!this.rebase(response.session)) throw new ApiError(412, '另一张页面更新了进度，请重新连接', response.session);
        this.packet = null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.session && !error.session.result) {
          this.packet = null;
          if (this.rebase(error.session)) { sendPause = this.active.paused !== this.paused; continue; }
        }
        throw error;
      }
      sendPause = this.active.paused !== this.paused;
      if (this.active.result) return this.active;
    }
    return this.active;
  }
  finish(): Promise<WatermelonSessionResponse> {
    if (!this.finishing) this.finishing = this.submit().finally(() => { this.finishing = null; });
    return this.finishing;
  }
  private async submit(): Promise<WatermelonSessionResponse> {
    do { await this.sync(); }
    while (!this.active.result && (this.active.base_tick < this.toTick || this.pending.length > 0 || this.active.paused !== this.paused));
    this.finalPacket ??= {
      request_id: crypto.randomUUID(), session_id: this.active.session_id,
      base_tick: this.active.base_tick, base_moves: this.active.base_moves,
      to_tick: this.active.base_tick, drops: [], paused: true,
    };
    const response = await this.send('finish', this.finalPacket);
    this.active = response.session;
    clearRecovery(this.owner);
    return response;
  }
}
