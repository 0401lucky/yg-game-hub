import type { WatermelonSnapshot } from './protocol.ts';
import * as E from './engine.ts';
import { WatermelonRenderer } from './renderer.ts';
import type { WatermelonCallbacks, WatermelonInit, WatermelonProgress } from './types.ts';

const BEST_STORAGE_KEY = 'yg.watermelon.best.v1';

export class WatermelonRuntime {
  private game: E.WatermelonGame;
  private readonly renderer: WatermelonRenderer;
  private readonly observer: ResizeObserver;
  private mode: 'practice' | 'challenge' = 'practice';
  private locked = false;
  private completed = false;
  private restoring = false;
  private disposed = false;
  private generation = 0;
  private sound = false;
  private audio: AudioContext | null = null;
  private activePointer: number | null = null;
  private previousTime = 0;
  private animationFrame = 0;
  private dirty = true;
  private lastNotifiedTick = 0;
  private lastBest = 0;
  private lastMergeTick = -1000;
  private combo = 0;
  private undoSnapshot: WatermelonSnapshot | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: WatermelonCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: WatermelonCallbacks) {
    this.canvas = canvas; this.callbacks = callbacks;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建游戏画面，请换个浏览器重试。');
    try {
      const value = Number(window.localStorage.getItem(BEST_STORAGE_KEY));
      if (Number.isFinite(value) && value >= 0) this.lastBest = value;
    } catch { /* The input queue works when local storage is unavailable. */ }
    this.game = E.createGame({ best: this.lastBest });
    this.renderer = new WatermelonRenderer(canvas, ctx, () => { this.dirty = true; });
    this.observer = new ResizeObserver(() => { this.renderer.resize(); this.dirty = true; });
    this.observer.observe(canvas);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.cancelPointer);
    canvas.addEventListener('lostpointercapture', this.cancelPointer);
    canvas.addEventListener('keydown', this.keyDown);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    window.addEventListener('blur', this.backgroundPause);
    window.addEventListener('pagehide', this.backgroundPause);
    this.notify();
    this.renderer.draw(this.game, 0);
    this.animationFrame = window.requestAnimationFrame(this.frame);
  }

  get progress(): WatermelonProgress {
    return {
      tick: this.game.tickCount, moves: this.game.drops, score: this.game.score, best: this.game.best,
      highest: this.game.highest, held: this.game.held, next: this.game.next, phase: this.game.phase,
      overflow: this.game.overflow, sound: this.sound, locked: this.locked,
      combo: this.combo, canUndo: this.mode === 'practice' && !!this.undoSnapshot && !this.locked && !this.restoring,
    };
  }

  get checkpoint(): { seed: string; state: WatermelonSnapshot } {
    return { seed: this.game.seed, state: E.snapshot(this.game) };
  }

  private notify(): WatermelonProgress {
    if (this.game.best !== this.lastBest) {
      this.lastBest = this.game.best;
      try { window.localStorage.setItem(BEST_STORAGE_KEY, String(this.lastBest)); } catch { /* Optional local record. */ }
    }
    this.lastNotifiedTick = this.game.tickCount;
    const progress = this.progress;
    if (!this.disposed) this.callbacks.progress(progress);
    this.dirty = true;
    return progress;
  }

  private clearPointer(): void {
    const pointer = this.activePointer;
    this.activePointer = null;
    if (pointer !== null && this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer);
  }

  private resetFeedback(): void {
    this.renderer.reset(); this.combo = 0; this.lastMergeTick = -1000;
    this.undoSnapshot = null; this.previousTime = 0; this.clearPointer();
  }

  async initialize(init: WatermelonInit): Promise<WatermelonProgress> {
    if (this.disposed) throw new Error('游戏页面已关闭。');
    const generation = ++this.generation;
    this.restoring = true; this.locked = true; this.clearPointer(); E.pause(this.game); this.previousTime = 0;
    try {
      let game: E.WatermelonGame;
      const best = Math.max(this.lastBest, this.game.best);
      if (init.mode === 'challenge') {
        if (!init.session_id || !init.seed || !E.validSnapshot(init.state) || !Array.isArray(init.drops)) throw new Error('这局需要重新恢复。');
        let state = init.state;
        const target = init.to_tick;
        const drops = init.drops.map(drop => ({ ...drop }));
        const segmentLimit = init.limits?.max_segment_ticks ?? E.MAX_SEGMENT_TICKS;
        const dropLimit = init.limits?.max_drops ?? E.MAX_DROPS;
        if (!Number.isSafeInteger(target) || target === undefined || target < state.tick || target - state.tick > 72000 || drops.length > 512
          || !Number.isSafeInteger(segmentLimit) || segmentLimit < 1 || segmentLimit > E.MAX_SEGMENT_TICKS
          || !Number.isSafeInteger(dropLimit) || dropLimit < 1 || dropLimit > E.MAX_DROPS) throw new Error('本局进度需要重新加载。');
        let previousTick = state.tick;
        for (const drop of drops) {
          if (!Number.isSafeInteger(drop.tick) || drop.tick < previousTick || drop.tick > target || !Number.isSafeInteger(drop.x) || drop.x < 0 || drop.x > 360) throw new Error('本局投放记录无效。');
          previousTick = drop.tick;
        }
        while (state.tick < target || drops.length) {
          let end = Math.min(target, state.tick + segmentLimit);
          let count = drops.findIndex(drop => drop.tick > end);
          if (count < 0) count = drops.length;
          if (count > dropLimit) { count = dropLimit; end = drops[count - 1].tick; }
          state = E.replay(init.seed, state, end, drops.splice(0, count));
          if (state.tick < target || drops.length) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          if (this.disposed || generation !== this.generation) throw new Error('游戏恢复已取消。');
        }
        game = E.restore(init.seed, state, { best });
        if (init.paused !== false) E.pause(game);
      } else {
        game = init.seed && init.state ? E.restore(init.seed, init.state, { best }) : E.createGame({ best });
        if (init.state) E.pause(game);
        else if (!init.ready) { E.start(game); if (init.paused) E.pause(game); }
      }
      if (this.disposed || generation !== this.generation) throw new Error('游戏恢复已取消。');
      this.game = game; this.mode = init.mode; this.completed = false; this.locked = !!init.locked;
      this.resetFeedback();
    } finally {
      if (generation === this.generation) this.restoring = false;
    }
    return this.notify();
  }

  async capture(lock = false): Promise<WatermelonProgress> {
    E.pause(this.game); this.locked = this.locked || lock; this.clearPointer(); this.previousTime = 0;
    // Flush the final tick before resolving, so settlement includes every input.
    return this.notify();
  }

  async resume(): Promise<WatermelonProgress> {
    if (!this.locked && !this.restoring && !this.completed && !this.disposed) {
      E.resume(this.game); this.previousTime = 0; this.canvas.focus({ preventScroll: true });
    }
    return this.notify();
  }

  async begin(): Promise<WatermelonProgress> {
    if (this.disposed || this.restoring) return this.progress;
    if (this.completed) { this.callbacks.practice(); return this.progress; }
    if (this.locked) return this.progress;
    if (this.mode === 'challenge' && this.game.phase === 'over') { this.callbacks.claim(); return this.progress; }
    if (this.game.phase === 'paused') return this.resume();
    if (this.mode === 'practice' && (this.game.phase === 'ready' || this.game.phase === 'over')) {
      if (this.game.phase === 'over') this.game = E.createGame({ best: this.game.best });
      E.start(this.game); this.resetFeedback(); this.canvas.focus({ preventScroll: true }); this.tone(0);
    }
    return this.notify();
  }

  async togglePause(): Promise<WatermelonProgress> {
    if (this.locked || this.restoring || this.disposed) return this.progress;
    return this.game.phase === 'paused' ? this.resume() : this.capture();
  }

  async undo(): Promise<WatermelonProgress> {
    if (this.mode !== 'practice' || !this.undoSnapshot || this.locked || this.restoring || this.disposed) return this.progress;
    const paused = this.game.phase === 'paused';
    this.game = E.restore(this.game.seed, this.undoSnapshot, { best: this.game.best });
    if (paused) E.pause(this.game);
    this.resetFeedback();
    this.callbacks.announce?.('已撤回上一颗水果。');
    return this.notify();
  }

  async complete(): Promise<WatermelonProgress> {
    E.pause(this.game); this.locked = true; this.completed = true; this.clearPointer(); this.undoSnapshot = null;
    return this.notify();
  }

  async toggleSound(): Promise<WatermelonProgress> {
    this.sound = !this.sound;
    if (this.sound) this.tone(1);
    return this.notify();
  }

  private silence = (): void => { this.sound = false; this.notify(); };

  private tone(level: number, merge = false): void {
    if (!this.sound || this.disposed) return;
    try {
      if (!this.audio) {
        const Audio = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) { this.silence(); return; }
        this.audio = new Audio();
      }
      if (this.audio.state === 'suspended') void this.audio.resume().catch(this.silence);
      const osc = this.audio.createOscillator(), gain = this.audio.createGain(), now = this.audio.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime((merge ? 360 : 235) * Math.pow(1.12, level), now);
      osc.frequency.exponentialRampToValueAtTime((merge ? 510 : 130) * Math.pow(1.12, level), now + .14);
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.065, now + .012); gain.gain.exponentialRampToValueAtTime(.001, now + .22);
      osc.connect(gain); gain.connect(this.audio.destination); osc.start(now); osc.stop(now + .24);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    } catch { this.silence(); }
  }

  private drop(x = this.game.aim): void {
    if (this.locked || this.restoring || this.disposed || this.game.phase !== 'playing') return;
    const rounded = E.clamp(Math.round(x), 0, 360), tick = this.game.tickCount;
    const before = this.mode === 'practice' ? E.snapshot(this.game) : null;
    if (!E.drop(this.game, rounded)) return;
    this.undoSnapshot = before;
    this.callbacks.drop({ tick, x: rounded }, this.game.drops);
    this.notify();
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || this.activePointer !== null || this.game.phase !== 'playing' || this.locked || this.restoring) return;
    event.preventDefault(); this.activePointer = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId); this.canvas.focus({ preventScroll: true });
    E.aim(this.game, this.renderer.pointerX(event.clientX)); this.dirty = true;
  };
  private pointerMove = (event: PointerEvent): void => {
    if (this.game.phase !== 'playing' || this.locked || this.restoring) return;
    if (this.activePointer === event.pointerId || (this.activePointer === null && event.pointerType === 'mouse')) {
      E.aim(this.game, this.renderer.pointerX(event.clientX)); this.dirty = true;
    }
  };
  private pointerUp = (event: PointerEvent): void => {
    if (this.activePointer !== event.pointerId) return;
    event.preventDefault(); this.clearPointer(); this.drop(this.renderer.pointerX(event.clientX));
  };
  private cancelPointer = (event: PointerEvent): void => { if (this.activePointer === event.pointerId) this.clearPointer(); };

  private keyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || this.restoring) return;
    const key = event.key.toLowerCase();
    if (key === 'p' || key === 'escape') {
      event.preventDefault(); if (!event.repeat) void this.togglePause(); return;
    }
    if (key === 'u' && this.mode === 'practice') { event.preventDefault(); if (!event.repeat) void this.undo(); return; }
    if (!['arrowleft', 'arrowright', ' ', 'enter'].includes(key)) return;
    event.preventDefault();
    if ((key === ' ' || key === 'enter') && !event.repeat && this.game.phase !== 'playing') { void this.begin(); return; }
    if (this.game.phase !== 'playing' || this.locked) return;
    if (key === 'arrowleft') E.aim(this.game, this.game.aim - 12);
    if (key === 'arrowright') E.aim(this.game, this.game.aim + 12);
    if ((key === ' ' || key === 'enter') && !event.repeat) this.drop();
    this.dirty = true;
  };
  private backgroundPause = (): void => {
    if (this.game.phase === 'playing' && !this.restoring) { E.pause(this.game); this.clearPointer(); this.previousTime = 0; this.notify(); }
  };
  private visibilityChanged = (): void => { if (document.hidden) this.backgroundPause(); };

  private consumeEvents(): boolean {
    const changed = this.game.events.length > 0;
    for (const event of this.game.events) {
      if (event.type === 'drop') this.tone(event.level);
      if (event.type === 'merge') {
        this.combo = this.game.tickCount - this.lastMergeTick <= 132 ? this.combo + 1 : 1;
        this.lastMergeTick = this.game.tickCount;
        this.tone(event.level, true); this.renderer.merge(event);
        if (event.level === E.LEVELS.length - 1) this.callbacks.announce?.('合成大西瓜！');
      }
      if (event.type === 'over') this.callbacks.announce?.(`本局结束，获得 ${event.score} 分。`);
    }
    this.game.events.length = 0;
    if (this.combo > 0 && this.game.tickCount - this.lastMergeTick > 132) { this.combo = 0; return true; }
    return changed;
  }

  private frame = (time: number): void => {
    if (this.disposed) return;
    const dt = this.previousTime ? Math.min(.067, (time - this.previousTime) / 1000) : 0;
    this.previousTime = time;
    if (!this.locked && !this.restoring) {
      E.step(this.game, dt);
      if (this.consumeEvents() || this.game.tickCount - this.lastNotifiedTick >= 30) this.notify();
    }
    if (this.dirty || this.game.phase === 'playing') {
      this.renderer.draw(this.game, this.game.phase === 'playing' ? dt : 0, !this.completed);
      this.dirty = false;
    }
    this.animationFrame = window.requestAnimationFrame(this.frame);
  };

  dispose(): void {
    if (this.disposed) return;
    this.backgroundPause(); this.disposed = true; this.generation++; this.clearPointer();
    window.cancelAnimationFrame(this.animationFrame); this.observer.disconnect(); this.renderer.dispose();
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.cancelPointer);
    this.canvas.removeEventListener('lostpointercapture', this.cancelPointer);
    this.canvas.removeEventListener('keydown', this.keyDown);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    window.removeEventListener('blur', this.backgroundPause);
    window.removeEventListener('pagehide', this.backgroundPause);
    if (this.audio && this.audio.state !== 'closed') void this.audio.close().catch(() => {});
  }
}
