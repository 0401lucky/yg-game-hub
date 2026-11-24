import fs from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const signatures = new Map<string, string>();
function signature(file: string): string | null {
  try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}
function collect(directory: string, target: Map<string, string>): void {
  let entries: Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (['node_modules', 'data', 'assets', 'public', 'css', 'js'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file, target);
    else if ((entry.name.endsWith('.ts') && entry.name !== 'app.ts') || entry.name === '.env') {
      const value = signature(file);
      if (value !== null) target.set(file, value);
    }
  }
}
function changed(): boolean {
  const next = new Map<string, string>();
  collect(path.join(root, 'backend'), next);
  collect(path.join(root, 'games'), next);
  // backend/app.ts is part of the host, while games/<id>/app.ts is frontend-only.
  for (const name of ['backend/app.ts', '.env', 'package.json']) {
    const file = path.join(root, name);
    const value = signature(file);
    if (value !== null) next.set(file, value);
  }
  const result = next.size !== signatures.size || [...next].some(([file, value]) => signatures.get(file) !== value);
  signatures.clear(); for (const [file, value] of next) signatures.set(file, value);
  return result;
}
changed();
const start = () => spawn(process.execPath, ['backend/server.ts'], { cwd: root, stdio: 'inherit', windowsHide: true });
let child = start();
let timer: ReturnType<typeof setTimeout> | undefined;
let restarting = false;
let pending = false;
let closing = false;
function schedule(): void {
  if (closing || !changed()) return;
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => { void restart(); }, 150);
}
async function restart(): Promise<void> {
  if (closing || restarting) return;
  restarting = true; pending = false;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  if (!closing) { console.log('[dev] 后端源码更新，重新启动'); child = start(); }
  restarting = false;
  if (pending && !closing) { clearTimeout(timer); timer = setTimeout(() => { void restart(); }, 150); }
}
// Compare write signatures so Windows access-time notifications cannot drop rooms.
const watchers = ['backend', 'games'].map(directory => fs.watch(path.join(root, directory), { recursive: true }, schedule));
watchers.push(fs.watch(root, (_event, name) => { if (name === '.env' || name === 'package.json') schedule(); }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  closing = true; clearTimeout(timer); for (const watcher of watchers) watcher.close();
  child.kill(); process.exit(0);
});
