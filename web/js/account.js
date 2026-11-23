/**
 * 全局账号组件（门户与各游戏共用，零依赖）
 *
 * 用法：页面引入 /css/account.css 与 /js/account.js 即可，
 * 脚本会在右上角挂一个账号胶囊，并对外暴露 window.accountUI。
 */
(function () {
  'use strict';

  var state = { user: null, stats: null, enabled: true, loading: true };
  var listeners = [];
  var els = {};

  // 战绩面板上的游戏名（新增游戏时在这里加一行）。没登记的游戏 id 会原样显示
  var GAME_NAMES = { flight: '飞行棋' };

  // ------------------------ 工具 ------------------------

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(path, {
      method: opts.body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { ok: res.ok, status: res.status, data: json };
      });
    });
  }

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(state.user, state.stats); } catch (e) { console.error(e); }
    });
  }

  function initial(name) {
    var text = String(name || '?').trim();
    return text ? text.slice(0, 1).toUpperCase() : '?';
  }

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { els.toast.classList.remove('show'); }, 1900);
  }

  // ------------------------ 与游戏联动 ------------------------

  /** 登录后把账号昵称填进游戏大厅的昵称输入框，省得手打 */
  function syncGameNickname(nickname) {
    if (!nickname) return;
    ['playerUsername', 'multiplayerPlayerUsername'].forEach(function (id) {
      var input = document.getElementById(id);
      if (input) {
        input.value = nickname;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    try {
      if (window.playerIdManager && typeof window.playerIdManager.saveNickname === 'function') {
        window.playerIdManager.saveNickname(nickname);
      }
    } catch (e) { /* 游戏模块可能尚未就绪，忽略 */ }
  }

  // ------------------------ 渲染 ------------------------

  function renderChip() {
    var chip = els.chip;
    chip.innerHTML = '';
    if (state.user) {
      chip.appendChild(el('span', 'ac-avatar', initial(state.user.nickname || state.user.username)));
      chip.appendChild(el('span', null, state.user.nickname || state.user.username));
      chip.appendChild(el('span', 'ac-caret', '▾'));
      chip.title = '账号：' + state.user.username;
    } else {
      chip.appendChild(el('span', null, state.loading ? '…' : '登录 / 注册'));
      chip.title = '登录后可保存战绩';
    }
  }

  function renderPanel() {
    var panel = els.panel;
    panel.innerHTML = '';
    if (!state.user) return;

    panel.appendChild(el('div', 'ac-panel-name', escapeHtml(state.user.nickname || state.user.username)));
    panel.appendChild(el('div', 'ac-panel-sub', '账号 ' + escapeHtml(state.user.username)));

    var stats = state.stats || { games: 0, wins: 0, winRate: 0, recent: [] };
    var grid = el('div', 'ac-stats');
    grid.appendChild(el('div', 'ac-stat', '<b>' + stats.games + '</b><span>对局</span>'));
    grid.appendChild(el('div', 'ac-stat', '<b>' + stats.wins + '</b><span>胜场</span>'));
    grid.appendChild(el('div', 'ac-stat', '<b>' + stats.winRate + '%</b><span>胜率</span>'));
    panel.appendChild(grid);

    // 玩的不止一款游戏了，拆开给个数
    if (stats.byGame && stats.byGame.length) {
      var parts = stats.byGame
        .filter(function (g) { return g.games > 0; })
        .map(function (g) { return (GAME_NAMES[g.gameId] || g.gameId) + ' ' + g.games + ' 局'; });
      if (parts.length) panel.appendChild(el('div', 'ac-panel-sub', parts.join(' · ')));
    }

    var recent = el('div', 'ac-recent');
    if (!stats.recent || !stats.recent.length) {
      recent.appendChild(el('div', 'ac-empty', '还没有战绩，去开一局'));
    } else {
      stats.recent.slice(0, 6).forEach(function (m) {
        var row = el('div', 'ac-recent-row');
        var when = new Date(m.endedAt);
        var label = (GAME_NAMES[m.gameId] || '对局') + ' · ' + (m.roomCode || '自定义') + ' · ' + (m.playerCount || 0) + '人';
        var time = isNaN(when) ? '' : (when.getMonth() + 1) + '/' + when.getDate();
        row.appendChild(el('span', null, label + (time ? ' · ' + time : '')));
        row.appendChild(el('span', m.isWinner ? 'ac-win' : 'ac-lose', m.isWinner ? '胜' : '负'));
        recent.appendChild(row);
      });
    }
    panel.appendChild(recent);

    var logout = el('button', 'ac-btn', '退出登录');
    logout.addEventListener('click', function () {
      api('/api/auth/logout', { body: {} }).then(function () {
        state.user = null;
        state.stats = null;
        closePanel();
        renderChip();
        renderPanel();
        toast('已退出登录');
        notify();
      });
    });
    panel.appendChild(logout);
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function openPanel() { els.panel.classList.add('open'); }
  function closePanel() { els.panel.classList.remove('open'); }

  // ------------------------ 弹窗 ------------------------

  var modalMode = 'login';

  function buildModal() {
    var mask = el('div', 'ac-modal-mask');
    mask.innerHTML =
      '<div class="ac-modal">' +
        '<h3>账号</h3>' +
        '<div class="ac-modal-tip">登录后对局战绩会记到你的账号上，昵称自动带入房间。</div>' +
        '<div class="ac-tabs">' +
          '<button class="ac-tab active" data-mode="login">登录</button>' +
          '<button class="ac-tab" data-mode="register">注册</button>' +
        '</div>' +
        '<div class="ac-field"><label>用户名</label><input id="acUsername" autocomplete="username" maxlength="20" placeholder="2-20 位，中英文/数字/下划线"></div>' +
        '<div class="ac-field" data-only="register"><label>昵称（房间内显示）</label><input id="acNickname" autocomplete="nickname" maxlength="16" placeholder="留空则用用户名"></div>' +
        '<div class="ac-field"><label>密码</label><input id="acPassword" type="password" autocomplete="current-password" maxlength="72" placeholder="至少 6 位"></div>' +
        '<div class="ac-error" id="acError"></div>' +
        '<button class="ac-btn ac-btn-primary" id="acSubmit">登录</button>' +
      '</div>';

    var submit = mask.querySelector('#acSubmit');
    var error = mask.querySelector('#acError');
    var username = mask.querySelector('#acUsername');
    var nickname = mask.querySelector('#acNickname');
    var password = mask.querySelector('#acPassword');

    function applyMode() {
      mask.querySelectorAll('.ac-tab').forEach(function (tab) {
        tab.classList.toggle('active', tab.dataset.mode === modalMode);
      });
      mask.querySelectorAll('[data-only="register"]').forEach(function (node) {
        node.style.display = modalMode === 'register' ? '' : 'none';
      });
      submit.textContent = modalMode === 'register' ? '注册并登录' : '登录';
      password.setAttribute('autocomplete', modalMode === 'register' ? 'new-password' : 'current-password');
      error.textContent = '';
    }

    mask.querySelectorAll('.ac-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        modalMode = tab.dataset.mode;
        applyMode();
      });
    });

    function doSubmit() {
      var name = username.value.trim();
      var pass = password.value;
      if (!name || !pass) {
        error.textContent = '用户名和密码都要填';
        return;
      }
      submit.disabled = true;
      var path = modalMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      var body = { username: name, password: pass };
      if (modalMode === 'register' && nickname.value.trim()) body.nickname = nickname.value.trim();

      api(path, { body: body }).then(function (res) {
        submit.disabled = false;
        if (!res.ok || !res.data.user) {
          error.textContent = res.data.error || '操作失败，请重试';
          return;
        }
        state.user = res.data.user;
        state.stats = res.data.stats || null;
        closeModal();
        renderChip();
        renderPanel();
        syncGameNickname(state.user.nickname);
        toast(modalMode === 'register' ? '注册成功，已登录' : '欢迎回来，' + state.user.nickname);
        notify();
      }).catch(function () {
        submit.disabled = false;
        error.textContent = '网络异常，请重试';
      });
    }

    submit.addEventListener('click', doSubmit);
    mask.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSubmit();
    });
    mask.addEventListener('click', function (e) {
      if (e.target === mask) closeModal();
    });

    document.body.appendChild(mask);
    els.modal = mask;
    els.modalApplyMode = applyMode;
  }

  function openModal(mode) {
    modalMode = mode || 'login';
    els.modalApplyMode();
    els.modal.classList.add('open');
    setTimeout(function () {
      var input = els.modal.querySelector('#acUsername');
      if (input) input.focus();
    }, 60);
  }

  function closeModal() { els.modal.classList.remove('open'); }

  // ------------------------ 启动 ------------------------

  function build() {
    var root = el('div', 'ac-root');
    var chip = el('button', 'ac-chip', '登录 / 注册');
    var panel = el('div', 'ac-panel');

    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.user) {
        els.panel.classList.contains('open') ? closePanel() : openPanel();
      } else {
        openModal('login');
      }
    });

    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) closePanel();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closePanel();
        if (els.modal) closeModal();
      }
    });

    root.appendChild(chip);
    root.appendChild(panel);
    document.body.appendChild(root);

    els.chip = chip;
    els.panel = panel;

    var toastNode = el('div', 'ac-toast');
    document.body.appendChild(toastNode);
    els.toast = toastNode;

    buildModal();
    renderChip();
  }

  function refresh() {
    return api('/api/auth/me').then(function (res) {
      state.loading = false;
      state.enabled = res.data.enabled !== false;
      state.user = res.data.user || null;
      state.stats = res.data.stats || null;
      renderChip();
      renderPanel();
      if (state.user) syncGameNickname(state.user.nickname);
      notify();
    }).catch(function () {
      state.loading = false;
      renderChip();
    });
  }

  function start() {
    build();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.accountUI = {
    refresh: refresh,
    getUser: function () { return state.user; },
    getStats: function () { return state.stats; },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    openLogin: function () { openModal('login'); }
  };
})();
