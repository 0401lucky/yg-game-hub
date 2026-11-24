// 可选浏览器验收：node tools/doudizhu-browser-check.cjs <已安装的 playwright 或 playwright-core 路径>
// 使用独立浏览器与临时账号数据库，结束后自动清理。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '..');

async function startAccountServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'doudizhu-qa-server.cjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('账号测试服务启动超时')), 10000);
    child.stdout.on('data', data => {
      log += String(data);
      for (const line of log.split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try { const parsed = JSON.parse(line); if (parsed.dataRoot) { clearTimeout(timer); resolve(parsed); } } catch {}
      }
    });
    child.stderr.on('data', data => { log += String(data); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`账号测试服务退出 ${code}: ${log}`)); });
  });
  return { child, ...info };
}

async function denseCards(browser, engine) {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const page = await context.newPage();
  const take = (ranks, copies) => ranks.flatMap(rank => engine.DECK.filter(id => engine.rankOf(id) === rank).slice(0, copies));
  const played = [...take([7, 8, 9, 10], 3), ...take([3, 4, 5, 6], 1)];
  const pool = engine.DECK.filter(id => !played.includes(id));
  let state = { ...engine.createGame({ seed: 99 }), phase: 'playing', landlordSeat: 1, turn: 1, highestBid: 3, bids: [0, 3, 0],
    hands: [engine.sortCards(pool.slice(4, 21)), engine.sortCards([...played, ...pool.slice(0, 4)]), engine.sortCards(pool.slice(21))], bottom: pool.slice(0, 3) };
  state = engine.applyAction(state, 1, { type: 'play', cards: played }).state;
  state = engine.applyAction(state, 2, { type: 'pass' }).state;
  const players = [0, 1, 2].map(seat => ({ id: `dense-${seat}`, nickname: ['你的座位', '长牌型玩家', '牌友'][seat], seat, isBot: false, ready: true, connected: true, auto: false, avatar: ['queen', 'raven', 'joker-green'][seat] }));
  let revision = 0;
  let socket;
  const publish = () => socket.send(JSON.stringify({ type: 'state', revision: ++revision, serverNow: Date.now(), room: { code: '888888', hostId: players[0].id, players, round: 1, difficulty: 'hard', autoFill: true }, me: { id: players[0].id, seat: 0 }, game: { ...engine.publicState(state, 0), deadline: Date.now() + 30000 } }));
  await page.routeWebSocket('**/ws/doudizhu', route => {
    socket = route;
    route.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') { route.send(JSON.stringify({ type: 'welcome', token: 'dense-fixture-only', playerId: players[0].id })); publish(); }
      if (message.type === 'action') { const result = engine.applyAction(state, 0, message.data); assert(result.ok); state = result.state; publish(); }
    });
  });
  try {
    await page.goto('http://127.0.0.1:3001/games/doudizhu/');
    await page.waitForFunction(() => !document.querySelector('#hand .dealing') && document.querySelectorAll('#hand .card').length === 17);
    await page.locator('[data-command="pass"]').click();
    await page.waitForFunction(() => document.getElementById('playSelf').textContent.includes('不出'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#playSelf .pass-label')).opacity === '1');
    assert.equal(await page.locator('#playRight .card-row').count(), 1);
    assert.equal(await page.locator('#playRight .card').count(), 16);
    await page.screenshot({ path: path.join(output, 'doudizhu-long-play-mobile.png'), scale: 'css' });
    const mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('#playRight .card')].map(card => { const r = card.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }) }));
    assert.equal(mobile.width, mobile.scrollWidth);
    assert(mobile.cards.every(card => card.left >= 0 && card.right <= 360 && card.top >= 0 && card.bottom <= 640));
    const visibleRanks = await page.locator('#playRight .card').evaluateAll(cards => cards.every(card => {
      const rect = card.getBoundingClientRect();
      return document.elementFromPoint(rect.left + 6, rect.top + 4)?.closest('.card') === card;
    }));
    assert(visibleRanks, '长牌的角标不能被头像或状态遮住');
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator('#playRight .card-row').count(), 2);
    await page.screenshot({ path: path.join(output, 'doudizhu-long-play-desktop.png'), scale: 'css' });
    console.log('PASS 长牌型：手机居中展开、桌面分行，16 张均完整显示');
  } finally { await context.close(); }
}

async function accountFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const username = `qa_ddz_${Date.now().toString(36)}`;
  const password = 'Doudizhu-test-2026!';
  const hand = () => page.locator('#hand .card').evaluateAll(nodes => nodes.map(node => node.dataset.card).sort().join(','));
  try {
    await page.goto('http://127.0.0.1:3012/games/doudizhu/');
    await page.locator('#soloButton').click();
    await page.locator('#hand .card').first().waitFor();
    const code = new URL(page.url()).searchParams.get('room');
    const before = await hand();
    await page.locator('.ac-chip').click();
    await page.locator('.ac-tab[data-mode="register"]').click();
    await page.locator('#acUsername').fill(username);
    await page.locator('#acNickname').fill('登录后的牌友');
    await page.locator('#acPassword').fill(password);
    await page.locator('#acSubmit').click();
    await page.locator('#selfPlayer .player-name').filter({ hasText: '登录后的牌友' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('room'), code);
    assert.equal(await hand(), before);
    await page.locator('.ac-chip').click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.locator('.ac-chip').filter({ hasText: '登录 / 注册' }).waitFor();
    await page.waitForTimeout(180);
    await page.reload();
    await page.locator('#hand .card').first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get('room'), code);
    assert.equal(await hand(), before);
    await page.locator('.ac-chip').click();
    await page.locator('#acUsername').fill(username);
    await page.locator('#acPassword').fill(password);
    await page.locator('#acSubmit').click();
    await page.locator('#selfPlayer .player-name').filter({ hasText: '登录后的牌友' }).waitFor();
    await page.locator('#autoButton').click();
    await page.locator('#resultDialog').waitFor({ state: 'visible', timeout: 60000 });
    const stats = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).stats);
    assert.equal(stats.games, 1);
    assert.equal(stats.recent[0].gameId, 'doudizhu');
    await page.locator('#resultDialog .modal-close').click();
    await page.locator('.ac-chip').click();
    const displayed = await page.locator('.ac-stats .ac-stat').first().innerText();
    assert.match(displayed, /1/);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'doudizhu-account-stats.png'), scale: 'css' });
    console.log('PASS 登录/退出保留牌局，结算写入战绩并自动更新账号面板');
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let server;
  try {
    if (!process.argv.includes('--dense-only')) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:3001/games/doudizhu/');
      const visual = (0, eval)(fs.readFileSync(path.join(__dirname, 'doudizhu-visual.js'), 'utf8'));
      const result = await visual(page);
      assert.equal(result.springBeforeSettlement, true);
      assert.equal(result.airplaneCards, 6);
      console.log('PASS 发牌、底牌、炸弹、王炸、飞机、春天与结算动画');
      await context.close();
    }
    const engine = await import(pathToFileURL(path.join(root, 'games/doudizhu/engine.mjs')).href);
    await denseCards(browser, engine);
    if (!process.argv.includes('--visual-only') && !process.argv.includes('--dense-only')) {
      server = await startAccountServer();
      await accountFlow(browser);
    }
    console.log('BROWSER_QA_OK');
  } finally {
    await browser.close();
    if (server) {
      const exited = once(server.child, 'exit');
      server.child.kill();
      await exited;
      const resolved = fs.realpathSync(server.dataRoot);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('yg-ddz-ui-test-')) throw new Error('账号测试目录清理路径校验失败');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
