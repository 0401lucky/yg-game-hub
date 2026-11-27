import { LEVELS } from './engine.ts';

export const FRUIT_CORES = [
  { cx: 255.5, cy: 287, rx: 193.5, ry: 194.84 },
  { cx: 249, cy: 308, rx: 173, ry: 175.8 },
  { cx: 256, cy: 278, rx: 208, ry: 207.17 },
  { cx: 255.5, cy: 277, rx: 198.5, ry: 187.45 },
  { cx: 256, cy: 283, rx: 198, ry: 190.92 },
  { cx: 256, cy: 276, rx: 208, ry: 208.56 },
  { cx: 255.5, cy: 273, rx: 217.5, ry: 215.4 },
  { cx: 255.5, cy: 276, rx: 199.5, ry: 208.93 },
  { cx: 255.5, cy: 282, rx: 195.5, ry: 200.66 },
] as const;
export const FRUITS = LEVELS.map((fruit, level) => ({ ...fruit, level, image: `/games/watermelon/assets/fruits/${fruit.id}.webp` }));
export function fruitName(level: number): string { return LEVELS[level]?.name ?? '—'; }
