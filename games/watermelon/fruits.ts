import { LEVELS } from './engine.ts';

export const FRUIT_CORES = [
  { cx: 256, cy: 287.85, rx: 194.76, ry: 191.08 },
  { cx: 258.45, cy: 351.54, rx: 173.93, ry: 137.19 },
  { cx: 247.43, cy: 314.79, rx: 194.76, ry: 173.93 },
  { cx: 256, cy: 256, rx: 194.76, ry: 197.21 },
  { cx: 253.55, cy: 259.67, rx: 199.66, ry: 198.43 },
  { cx: 247.43, cy: 281.72, rx: 200.88, ry: 177.61 },
  { cx: 259.67, cy: 262.12, rx: 205.78, ry: 177.61 },
  { cx: 256, cy: 259.67, rx: 199.66, ry: 186.18 },
  { cx: 243.75, cy: 253.55, rx: 208.23, ry: 194.76 },
] as const;
export const FRUITS = LEVELS.map((fruit, level) => ({ ...fruit, level, image: `/games/watermelon/assets/fruits/${fruit.id}.webp` }));
export function fruitName(level: number): string { return LEVELS[level]?.name ?? '—'; }
