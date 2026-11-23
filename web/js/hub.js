/**
 * 游戏门户：读取 games.json 渲染游戏卡片，并展示在线概况。
 * 新增游戏只需：1) 把游戏放进 games/<id>/；2) 在 games.json 里加一条。
 */
(function () {
  'use strict';

  var gridEl = null;

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function skeleton(count) {
    gridEl.innerHTML = '';
    var wrap = el('div', 'hub-grid');
    for (var i = 0; i < count; i++) wrap.appendChild(el('div', 'hub-skeleton'));
    gridEl.appendChild(wrap);
  }

  function card(game) {
    var isLive = game.status === 'online';
    var node = el(isLive ? 'a' : 'div', 'hub-card ' + (isLive ? 'live' : 'soon'));
    if (isLive) node.href = game.path;

    var art = el('div', 'hub-card-art', game.emoji || '🎮');
    art.style.background = 'linear-gradient(135deg, ' + (game.accentSoft || '#eee') + ', ' +
      (game.accent || '#ddd') + ')';
    art.appendChild(el('span', 'hub-badge' + (isLive ? '' : ' soon-badge'), isLive ? '可玩' : '即将上线'));
    node.appendChild(art);

    var body = el('div', 'hub-card-body');
    var name = el('div', 'hub-card-name', escapeHtml(game.name));
    if (game.subtitle) name.appendChild(el('small', null, escapeHtml(game.subtitle)));
    body.appendChild(name);

    body.appendChild(el('p', 'hub-card-desc', escapeHtml(game.desc || '')));

    var tags = el('div', 'hub-tags');
    (game.tags || []).forEach(function (tag) {
      tags.appendChild(el('span', 'hub-tag', escapeHtml(tag)));
    });
    if (game.players) tags.appendChild(el('span', 'hub-tag', escapeHtml(game.players)));
    body.appendChild(tags);

    body.appendChild(
      el('span', 'hub-cta' + (isLive ? '' : ' hub-cta-muted'), isLive ? '进入游戏 →' : '还在写，敬请期待')
    );
    node.appendChild(body);
    return node;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderGames(games) {
    gridEl.innerHTML = '';

    var live = games.filter(function (g) { return g.status === 'online'; });
    var soon = games.filter(function (g) { return g.status !== 'online'; });

    if (live.length) {
      gridEl.appendChild(sectionTitle('现在能玩'));
      var liveWrap = el('div', 'hub-grid');
      live.forEach(function (g) { liveWrap.appendChild(card(g)); });
      gridEl.appendChild(liveWrap);
    }

    if (soon.length) {
      gridEl.appendChild(sectionTitle('在计划里'));
      var soonWrap = el('div', 'hub-grid');
      soon.forEach(function (g) { soonWrap.appendChild(card(g)); });
      gridEl.appendChild(soonWrap);
    }
  }

  function sectionTitle(text) {
    return el('div', 'hub-section-title', escapeHtml(text));
  }

  function updateStatus() {
    fetch('/api/rooms', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rooms = data.totalRooms || 0;
        var players = 0;
        (data.rooms || []).forEach(function (room) {
          players += (room.players || []).filter(function (p) { return p.isConnected; }).length;
        });
        setPill('hubRooms', rooms);
        setPill('hubPlayers', players);
      })
      .catch(function () { /* 在线概况拿不到不影响玩 */ });
  }

  function setPill(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = String(value);
  }

  function renderGreeting(user) {
    var node = document.getElementById('hubGreeting');
    if (!node) return;
    if (user) {
      node.innerHTML = '欢迎回来，<b>' + escapeHtml(user.nickname || user.username) + '</b>';
    } else {
      node.innerHTML = '想存战绩就右上角登录一下，不登录也能直接开房间玩。';
    }
  }

  function start() {
    gridEl = document.getElementById('hubGames');
    if (!gridEl) return;
    skeleton(2);

    fetch('games.json', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderGames(data.games || []);
        var site = data.site || {};
        if (site.title) document.title = site.title + ' · ' + (site.owner || '');
        var titleNode = document.getElementById('hubTitle');
        if (titleNode && site.title) titleNode.textContent = site.title;
        var subNode = document.getElementById('hubSubtitle');
        if (subNode && site.subtitle) subNode.textContent = site.subtitle;
      })
      .catch(function () {
        gridEl.innerHTML = '';
        gridEl.appendChild(el('div', 'hub-card soon', '<div class="hub-card-body">游戏列表加载失败，刷新试试</div>'));
      });

    updateStatus();
    setInterval(updateStatus, 20000);

    if (window.accountUI) {
      window.accountUI.onChange(renderGreeting);
      renderGreeting(window.accountUI.getUser());
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
