// 用 Playwright browser_run_code_unsafe 的 filename 参数运行。
// 只拦截新测试页的 WebSocket；真实服务器、真实玩家手牌均不被改动。
(async (page) => {
  const initial = await page.evaluate(async () => {
    const engine = await import('/games/doudizhu/engine.mjs');
    for (let seed = 1; seed < 10000; seed++) {
      const dealt = engine.createGame({ seed, firstBidder: 0 });
      const playing = engine.applyAction(dealt, 0, { type: 'bid', score: 3 }).state;
      const bomb = [...engine.rankGroups(playing.hands[0]).values()].find(cards => cards.length === 4);
      if (bomb && playing.hands[0].includes('BJ') && playing.hands[0].includes('RJ') && playing.bottom.some(id => engine.rankOf(id) === 14)) {
        window.__ddzVisual = { engine, state: dealt };
        return { view: engine.publicState(dealt, 0), bomb };
      }
    }
    throw new Error('没有找到适合动画检查的确定性发牌');
  });
  const fixture = await page.context().newPage();
  await fixture.setViewportSize({ width: 1440, height: 900 });
  let route;
  let revision = 0;
  let round = 1;
  let view = initial.view;
  const players = [
    { id: 'visual-human', nickname: '今晚的牌友', seat: 0, isBot: false, ready: true, connected: true, auto: false, rematchReady: false, avatar: 'queen' },
    { id: 'visual-raven', nickname: '玄鸦 · 魔王', seat: 1, isBot: true, level: 'hell', ready: true, connected: true, auto: true, rematchReady: true, avatar: 'raven' },
    { id: 'visual-fox', nickname: '青狐 · 棋手', seat: 2, isBot: true, level: 'hard', ready: true, connected: true, auto: true, rematchReady: true, avatar: 'joker-green' }
  ];
  const publish = () => route.send(JSON.stringify({
    type: 'state', revision: ++revision, serverNow: Date.now(),
    room: { code: '999999', hostId: 'visual-human', players, difficulty: 'hell', autoFill: true, round },
    me: { id: 'visual-human', seat: 0 }, game: { ...view, deadline: view.phase === 'ended' ? null : Date.now() + 30000 }
  }));
  const apply = async action => {
    view = await page.evaluate(action => {
      const { engine, state } = window.__ddzVisual;
      const result = engine.applyAction(state, state.turn, action);
      if (!result.ok) throw new Error(result.reason);
      window.__ddzVisual.state = result.state;
      return engine.publicState(result.state, 0);
    }, action);
    publish();
  };
  await fixture.routeWebSocket('**/ws/doudizhu', socket => {
    route = socket;
    socket.onMessage(async raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'welcome', token: 'visual-fixture-only', playerId: players[0].id, roomCode: null, serverNow: Date.now() }));
        publish();
      } else if (message.type === 'action') {
        await apply(message.data);
        if (view.phase === 'playing' && view.trick) {
          await fixture.waitForTimeout(90);
          await apply({ type: 'pass' });
          await fixture.waitForTimeout(90);
          await apply({ type: 'pass' });
        }
      } else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', serverNow: Date.now() }));
      else if (message.type === 'sync') publish();
    });
  });
  const select = async ids => {
    await fixture.keyboard.press('Escape');
    for (const id of ids) await fixture.locator(`#hand [data-card="${id}"]`).click({ position: { x: 7, y: 12 } });
  };
  try {
    await fixture.goto('http://127.0.0.1:3001/games/doudizhu/');
    await fixture.locator('#hand .card').first().waitFor();
    await fixture.screenshot({ path: 'D:/games/doudizhu-animation-deal.png', scale: 'css' });
    await fixture.locator('[data-command="bid"][data-score="3"]').click();
    await fixture.waitForFunction(() => document.querySelectorAll('#hand .card').length === 20);
    await fixture.waitForFunction(() => !document.querySelector('#hand .drawn, #hand .dealing'));
    await fixture.screenshot({ path: 'D:/games/doudizhu-table-final-desktop.png', scale: 'css' });
    await fixture.setViewportSize({ width: 390, height: 844 });
    await fixture.screenshot({ path: 'D:/games/doudizhu-table-final-mobile.png', scale: 'css' });
    await fixture.setViewportSize({ width: 360, height: 640 });
    await fixture.screenshot({ path: 'D:/games/doudizhu-table-final-small.png', scale: 'css' });
    await fixture.setViewportSize({ width: 844, height: 390 });
    await fixture.screenshot({ path: 'D:/games/doudizhu-table-final-landscape.png', scale: 'css' });
    const landscape = await fixture.evaluate(() => ({
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      self: document.getElementById('selfPlayer').getBoundingClientRect().toJSON(),
      opponent: document.getElementById('opponentLeft').getBoundingClientRect().toJSON()
    }));
    await fixture.setViewportSize({ width: 1440, height: 900 });
    await select(initial.bomb);
    await fixture.locator('[data-command="play"]').click();
    await fixture.locator('.combo-effect strong').filter({ hasText: '炸弹' }).waitFor();
    await fixture.waitForTimeout(220);
    await fixture.screenshot({ path: 'D:/games/doudizhu-animation-bomb.png', scale: 'css' });
    await fixture.locator('.combo-effect').waitFor({ state: 'hidden' });
    if (view.multiplier !== 2) throw new Error('炸弹倍率未同步');
    await select(['BJ', 'RJ']);
    await fixture.locator('[data-command="play"]').click();
    await fixture.locator('.combo-effect strong').filter({ hasText: '王炸' }).waitFor();
    await fixture.waitForTimeout(220);
    await fixture.screenshot({ path: 'D:/games/doudizhu-animation-rocket.png', scale: 'css' });
    await fixture.locator('.combo-effect').waitFor({ state: 'hidden' });
    if (view.multiplier !== 4) throw new Error('王炸倍率未同步');

    // 用合法的单张领出与两家不出，将该确定性牌局推进到最后一张。
    view = await page.evaluate(() => {
      const session = window.__ddzVisual;
      while (session.state.hands[0].length > 1) {
        for (const action of [{ type: 'play', cards: [session.state.hands[0].at(-1)] }, { type: 'pass' }, { type: 'pass' }]) {
          const result = session.engine.applyAction(session.state, session.state.turn, action);
          if (!result.ok) throw new Error(result.reason);
          session.state = result.state;
        }
      }
      return session.engine.publicState(session.state, 0);
    });
    publish();
    await fixture.waitForFunction(() => document.querySelectorAll('#hand .card').length === 1);
    await select(view.hand);
    await fixture.locator('[data-command="play"]').click();
    await fixture.locator('.combo-effect strong').filter({ hasText: '春天' }).waitFor();
    const springBeforeSettlement = !(await fixture.locator('#resultDialog').isVisible());
    await fixture.waitForTimeout(260);
    await fixture.screenshot({ path: 'D:/games/doudizhu-animation-spring.png', scale: 'css' });
    await fixture.locator('#resultDialog').waitFor({ state: 'visible' });
    await fixture.screenshot({ path: 'D:/games/doudizhu-settlement-final.png', scale: 'css' });
    const scores = view.scores;
    await fixture.locator('#resultDialog .modal-close').click();

    // 再检查飞机组合提示，仍使用引擎自然洗出的合法手牌。
    const airplane = await page.evaluate(() => {
      const session = window.__ddzVisual;
      for (let seed = 1; seed < 2000; seed++) {
        const state = session.engine.applyAction(session.engine.createGame({ seed, firstBidder: 0 }), 0, { type: 'bid', score: 3 }).state;
        const move = session.engine.legalPlays(state.hands[0]).find(move => move.pattern.type === 'airplane');
        if (move) { session.state = state; return { cards: move.cards, view: session.engine.publicState(state, 0) }; }
      }
      throw new Error('没有找到飞机检查牌局');
    });
    round++;
    view = airplane.view;
    publish();
    await fixture.waitForFunction(() => document.getElementById('roundNumber').textContent.includes('2'));
    await fixture.waitForFunction(() => !document.querySelector('#hand .dealing'));
    await select(airplane.cards);
    await fixture.locator('[data-command="play"]').click();
    await fixture.locator('.combo-effect strong').filter({ hasText: '飞机' }).waitFor();
    await fixture.waitForTimeout(200);
    await fixture.screenshot({ path: 'D:/games/doudizhu-animation-airplane.png', scale: 'css' });
    await fixture.waitForFunction(() => document.getElementById('turnPrompt').classList.contains('my-turn'));
    return { springBeforeSettlement, scores, landscape, airplaneCards: airplane.cards.length };
  } finally {
    await fixture.close();
    await page.evaluate(() => { delete window.__ddzVisual; });
  }
})
