import type { WatermelonDrop, WatermelonLimits, WatermelonSnapshot } from './protocol.ts';
import type { WatermelonPhase } from './engine.ts';

export interface WatermelonProgress {
  tick: number; moves: number; score: number; best: number; highest: number;
  held: number; next: number; phase: WatermelonPhase; overflow: number;
  sound: boolean; locked: boolean; combo: number; canUndo: boolean;
}
export interface WatermelonInit {
  mode: 'practice' | 'challenge'; session_id: string | null; seed?: string;
  state?: WatermelonSnapshot; limits?: WatermelonLimits; drops?: WatermelonDrop[];
  to_tick?: number; paused?: boolean; ready?: boolean; locked?: boolean;
}
export interface WatermelonCallbacks {
  progress(progress: WatermelonProgress): void;
  drop(drop: WatermelonDrop, moves: number): void;
  claim(): void;
  practice(): void;
  announce?(text: string): void;
}
