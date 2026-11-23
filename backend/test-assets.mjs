// 静态资源完整性检查：抓 HTML 里所有本地引用，逐个请求确认可访问
const BASE = 'http://127.0.0.1:3001';
const pages = [
  '/',
  '/games/flight/',
  '/games/flight/game.html',
  '/games/flight/spectate.html',
  '/games/flight/replay.html',
  '/games/flight/stats.html',
  '/games/flight/admin.html'
];

const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
const importRe = /from\s+["']([^"']+)["']/g;

const seen = new Set();
const results = [];

function resolveRef(ref, pageUrl) {
  if (!ref || ref.startsWith('#') || ref.startsWith('data:') || ref.startsWith('http')
      || ref.startsWith('mailto:') || ref.startsWith('javascript:')) return null;
  return new URL(ref, BASE + pageUrl).href;
}

async function check(url, from) {
  if (seen.has(url)) return;
  seen.add(url);
  let status = 0;
  try {
    const res = await fetch(url, { redirect: 'manual' });
    status = res.status;
    if (status === 200 && url.endsWith('.js')) {
      const text = await res.text();
      for (const m of text.matchAll(importRe)) {
        const abs = resolveRef(m[1], new URL(url).pathname);
        if (abs) queue.push({ url: abs, from: url });
      }
    }
  } catch (e) {
    status = -1;
  }
  results.push({ url, status, from });
}

const queue = [];

for (const page of pages) {
  const res = await fetch(BASE + page);
  if (res.status !== 200) { results.push({ url: page, status: res.status, from: 'PAGE' }); continue; }
  const html = await res.text();
  for (const m of html.matchAll(attrRe)) {
    const abs = resolveRef(m[1], page);
    if (abs) queue.push({ url: abs, from: page });
  }
}

while (queue.length) {
  const item = queue.shift();
  await check(item.url, item.from);
}

const bad = results.filter((r) => r.status !== 200);
for (const r of results) {
  const flag = r.status === 200 ? 'OK  ' : 'FAIL';
  console.log(`${flag} ${String(r.status).padEnd(4)} ${r.url.replace(BASE, '')}${r.status === 200 ? '' : '   <- ' + r.from}`);
}
console.log(`\n===== 共检查 ${results.length} 个资源，失败 ${bad.length} 个 =====`);
process.exit(bad.length ? 1 : 0);
