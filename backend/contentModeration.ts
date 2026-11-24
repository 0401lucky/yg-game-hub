import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR } from './config.ts';
import { errorMessage } from '../games/shared/errors.ts';

export function createTextSanitizer(): (input: unknown) => string {
  let regexes: RegExp[] = [];
  try {
    const raw = fs.readFileSync(path.join(GAMES_DIR, 'flight/assets/违规词库.txt'), 'utf8');
    const words = [...new Set(raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    regexes = words.map(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
    console.log(`[内容过滤] 已加载违规词 ${regexes.length} 条`);
  } catch (error) {
    console.warn('[内容过滤] 违规词库加载失败，将跳过文本过滤:', errorMessage(error));
  }
  return input => {
    if (input == null) return '';
    let text = String(input);
    for (const regex of regexes) text = text.replace(regex, match => '*'.repeat(match.length));
    return text;
  };
}
