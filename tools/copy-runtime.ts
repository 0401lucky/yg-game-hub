import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const gamesDir = path.join(root, 'games');
const output = path.join(root, 'runtime-games');
if (!output.startsWith(root + path.sep)) throw new Error('Runtime output must stay inside the project');
fs.rmSync(output, { recursive: true, force: true });

function copyTypescript(source: string, destination: string, recursive = false): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const file = path.join(source, entry.name);
    if (entry.isFile() && entry.name.endsWith('.ts') && (recursive || entry.name !== 'app.ts')) {
      fs.copyFileSync(file, path.join(destination, entry.name));
    } else if (entry.isDirectory() && (recursive || entry.name === 'server')) {
      copyTypescript(file, path.join(destination, entry.name), true);
    }
  }
}
copyTypescript(path.join(gamesDir, 'shared'), path.join(output, 'shared'), true);
for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !fs.existsSync(path.join(gamesDir, entry.name, 'server.ts'))) continue;
  copyTypescript(path.join(gamesDir, entry.name), path.join(output, entry.name));
}
// The optional local dictionary is also needed by the authoritative text filter.
const dictionary = path.join(gamesDir, 'flight/assets/违规词库.txt');
if (fs.existsSync(dictionary)) {
  const destination = path.join(output, 'flight/assets');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(dictionary, path.join(destination, '违规词库.txt'));
}
