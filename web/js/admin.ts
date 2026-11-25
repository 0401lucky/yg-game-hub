import type { AdminOverview, AdminSession, CleanupResponse, DailyRow, GameSummary } from '../operationsProtocol.ts';
import { api, ApiError, feedback, get, node, RoomListView, timeLabel } from './operationsUi.ts';

const rooms = new RoomListView();
let active = false;
let configured = false;
let refreshTimer: number | undefined;
let expiryTimer: number | undefined;
let cooldownTimer: number | undefined;
let pending: AbortController | null = null;
let loginPending = false;

function gateMessage(message: string): void {
  get('adminGateMessage').textContent = message;
  get('adminGateMessage').hidden = !message;
}
function stop(): void {
  clearInterval(refreshTimer); clearTimeout(expiryTimer); refreshTimer = undefined; expiryTimer = undefined;
  pending?.abort(); pending = null;
}
function lock(message = ''): void {
  active = false; stop();
  get('adminContent').hidden = true; get('adminGate').hidden = false; get('adminLogout').hidden = true;
  get<HTMLInputElement>('adminKey').value = ''; get<HTMLInputElement>('adminKey').type = 'password';
  get('adminKeyToggle').textContent = '显示'; get('adminKeyToggle').setAttribute('aria-pressed', 'false'); get('adminKeyToggle').setAttribute('aria-label', '显示管理密钥');
  get<HTMLButtonElement>('adminLogin').disabled = !configured;
  for (const element of document.querySelectorAll('[data-metric]')) element.textContent = '—';
  for (const id of ['adminGames', 'onlineUsers', 'historyChart', 'historyRows']) get(id).replaceChildren();
  for (const id of ['statsDate', 'lastUpdated', 'systemUptime', 'systemMemory', 'adminExpiry']) get(id).textContent = '';
  get('onlineUserCount').textContent = '0'; rooms.clear(); feedback('');
  get<HTMLDialogElement>('cleanupDialog').close();
  gateMessage(message);
}
function unlock(session: AdminSession): void {
  if (!session.authenticated || !session.expiresAt || session.expiresAt <= Date.now()) { lock('管理会话已过期，请重新输入密钥。'); return; }
  active = true; configured = true;
  get('adminContent').hidden = false; get('adminGate').hidden = true; get('adminLogout').hidden = false;
  get<HTMLInputElement>('adminKey').value = ''; get<HTMLInputElement>('adminKey').type = 'password';
  get('adminExpiry').textContent = `会话有效至 ${timeLabel(session.expiresAt)}`;
  clearTimeout(expiryTimer);
  expiryTimer = window.setTimeout(() => lock('管理会话已过期，请重新输入密钥。'), session.expiresAt - Date.now());
  clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => { if (!document.hidden && get<HTMLInputElement>('autoRefresh').checked) void refresh(); }, 5000);
  void refresh();
}
async function initialize(): Promise<void> {
  try {
    const session = await api<AdminSession>('/api/admin/session');
    configured = session.configured;
    if (session.authenticated) unlock(session);
    else lock(configured ? '' : '管理入口尚未启用，请联系站点管理员配置管理密钥。');
  } catch {
    // The login request also checks configuration, so allow a retry after a transient outage.
    configured = true; lock('暂时无法检查管理入口，请稍后重试。');
  }
}
function checkAuthorization(error: unknown): boolean {
  if (!(error instanceof ApiError) || ![401, 503].includes(error.status)) return false;
  if (error.status === 503) configured = false;
  lock(error.status === 401 ? '管理会话已失效，请重新输入密钥。' : error.message);
  return true;
}
async function refresh(): Promise<void> {
  if (!active || pending) return;
  const controller = new AbortController(); pending = controller;
  get<HTMLButtonElement>('refreshButton').disabled = true;
  try {
    const data = await api<AdminOverview>('/api/admin/overview', { signal: controller.signal });
    if (!active || controller.signal.aborted) return;
    render(data);
    get('connectionStatus').textContent = '运营数据实时更新'; get('connectionStatus').dataset.state = 'online';
    if (get('opsFeedback').dataset.state !== 'success') feedback('');
  } catch (error) {
    if (controller.signal.aborted || !active) return;
    if (checkAuthorization(error)) return;
    get('connectionStatus').textContent = '更新暂时失败'; get('connectionStatus').dataset.state = 'error';
    feedback('运营数据暂时无法更新，请点击刷新重试。');
  } finally {
    if (pending === controller) pending = null;
    get<HTMLButtonElement>('refreshButton').disabled = false;
  }
}
function render(data: AdminOverview): void {
  const values: Record<string, string | number> = {
    totalOnline: data.totals.onlinePlayers, totalActiveGames: data.totals.activeGames, totalRooms: data.totals.rooms,
    pendingCleanup: data.system.pendingCleanup, dailyPlayed: data.daily.gamesPlayed, dailyFinished: data.daily.gamesFinished,
    dailyPlayers: data.daily.uniquePlayers, dailyPeak: data.daily.peakOnline, dailyRooms: data.daily.roomsCreated,
    statsDate: data.daily.date, lastUpdated: `更新于 ${timeLabel(data.timestamp)}`, onlineUserCount: data.onlineUsers.length,
    systemUptime: `已运行 ${duration(data.system.uptimeSeconds)}`, systemMemory: `内存 ${data.system.memoryMB} MB`,
  };
  for (const [id, value] of Object.entries(values)) get(id).textContent = String(value);
  const games = get('adminGames'); games.replaceChildren();
  for (const game of data.games) games.append(gameCard(game));
  rooms.setRooms(data.rooms, data.games);
  const users = get('onlineUsers'); users.replaceChildren();
  const statusNames = { idle: '大厅', in_room: '房间中', playing: '对局中', spectating: '观战中' };
  for (const user of data.onlineUsers) {
    const game = data.games.find(item => item.id === user.gameId);
    const tag = node('div', 'admin-user');
    tag.append(node('span', '', user.nickname), node('small', '', `${game?.name ?? user.gameId} · ${statusNames[user.status]}${user.roomCode ? ` · ${user.roomCode}` : ''}`));
    users.append(tag);
  }
  if (!data.onlineUsers.length) users.append(node('p', 'ops-muted', '目前没有在线联机玩家。'));
  renderHistory(data.history);
}
function gameCard(game: GameSummary): HTMLElement {
  const card = node('article', 'admin-game-card'); card.dataset.gameId = game.id;
  card.append(node('h3', '', `${game.emoji} ${game.name}`));
  const metrics = node('div', 'admin-game-stats');
  const values = game.id === 'minesweeper'
    ? [['活跃对局', game.activeGames], ['保存进度', game.savedSessions]]
    : [['在线玩家', game.onlinePlayers], ['房间', game.roomCount], ['等待开局', game.waitingRooms], ['正在对局', game.playingRooms]];
  for (const [label, value] of values) { const metric = node('div'); metric.append(node('span', '', String(label)), node('b', '', String(value))); metrics.append(metric); }
  card.append(metrics);
  if (game.id === 'minesweeper') card.append(node('p', '', '单人游戏不创建联机房间；保存中的进度可随时继续。'));
  return card;
}
function duration(seconds: number): string {
  const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds / 3600) % 24; const minutes = Math.floor(seconds / 60) % 60;
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : minutes ? `${minutes} 分钟` : `${seconds} 秒`;
}
function svg<Tag extends keyof SVGElementTagNameMap>(tag: Tag, attributes: Record<string, string>, text = ''): SVGElementTagNameMap[Tag] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text) element.textContent = text;
  return element;
}
function renderHistory(history: DailyRow[]): void {
  const chart = get<SVGSVGElement>('historyChart'); chart.replaceChildren();
  chart.append(svg('title', {}, '最近七天的开局与完赛数量；详细数字见下方每日数据表'));
  const rows = history.toReversed();
  const maximum = Math.max(1, ...rows.flatMap(row => [row.gamesPlayed, row.gamesFinished]));
  const top = Math.ceil(maximum / 4) * 4;
  for (let i = 0; i <= 4; i++) {
    const y = 170 - i * 36;
    chart.append(svg('line', { x1: '38', y1: String(y), x2: '654', y2: String(y), class: 'chart-line' }),
      svg('text', { x: '27', y: String(y + 3), 'text-anchor': 'end' }, String(top * i / 4)));
  }
  const x = (index: number) => 46 + index * 600 / Math.max(1, rows.length - 1);
  const y = (value: number) => 170 - value / top * 144;
  for (const [field, color] of [['gamesPlayed', '#69a883'], ['gamesFinished', '#d6a17a']] as const) {
    const points = rows.map((row, index) => `${x(index)},${y(row[field])}`).join(' ');
    chart.append(svg('polyline', { points, fill: 'none', stroke: color, 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    rows.forEach((row, index) => {
      const point = svg('circle', { cx: String(x(index)), cy: String(y(row[field])), r: '3.5', fill: color });
      point.append(svg('title', {}, `${row.date} ${field === 'gamesPlayed' ? '开局' : '完赛'} ${row[field]}`)); chart.append(point);
    });
  }
  rows.forEach((row, index) => chart.append(svg('text', { x: String(x(index)), y: '198', 'text-anchor': 'middle' }, row.date.slice(5))));
  const body = get('historyRows'); body.replaceChildren();
  for (const row of history) {
    const tr = node('tr');
    for (const value of [row.date, row.gamesPlayed, row.gamesFinished, row.uniquePlayers, row.peakOnline, row.roomsCreated]) tr.append(node('td', '', String(value)));
    body.append(tr);
  }
}
function cooldown(seconds: number): void {
  clearInterval(cooldownTimer);
  const deadline = Date.now() + Math.max(1, seconds) * 1000;
  const button = get<HTMLButtonElement>('adminLogin');
  function tick(): void {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    button.disabled = remaining > 0 || !configured;
    button.textContent = remaining ? `${remaining} 秒后重试` : '验证并进入 →';
    if (!remaining) clearInterval(cooldownTimer);
  }
  tick(); cooldownTimer = window.setInterval(tick, 1000);
}
get('adminLoginForm').addEventListener('submit', event => {
  event.preventDefault();
  if (loginPending || get<HTMLButtonElement>('adminLogin').disabled) return;
  loginPending = true; get<HTMLButtonElement>('adminLogin').disabled = true; gateMessage('正在验证…');
  void api<AdminSession>('/api/admin/login', { method: 'POST', body: JSON.stringify({ key: get<HTMLInputElement>('adminKey').value }) })
    .then(session => { unlock(session); gateMessage(''); })
    .catch((error: unknown) => {
      gateMessage(error instanceof ApiError ? error.message : '验证暂时未完成，请稍后重试。');
      if (error instanceof ApiError && error.status === 503) configured = false;
      if (error instanceof ApiError && error.status === 429) cooldown(error.retryAfter);
      else { get<HTMLInputElement>('adminKey').focus(); get<HTMLInputElement>('adminKey').select(); }
    })
    .finally(() => { loginPending = false; if (get<HTMLButtonElement>('adminLogin').textContent === '验证并进入 →') get<HTMLButtonElement>('adminLogin').disabled = !configured; });
});
get('adminKeyToggle').addEventListener('click', () => {
  const input = get<HTMLInputElement>('adminKey'); const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
  get('adminKeyToggle').textContent = visible ? '隐藏' : '显示'; get('adminKeyToggle').setAttribute('aria-pressed', String(visible));
  get('adminKeyToggle').setAttribute('aria-label', visible ? '隐藏管理密钥' : '显示管理密钥');
});
get('adminLogout').addEventListener('click', () => {
  const button = get<HTMLButtonElement>('adminLogout'); button.disabled = true;
  void api<AdminSession>('/api/admin/logout', { method: 'POST', body: '{}' })
    .then(() => lock('已退出管理，重新进入时需要验证密钥。'))
    .catch(error => { if (!checkAuthorization(error)) feedback('退出请求未完成，请稍后重试。'); })
    .finally(() => { button.disabled = false; });
});
get('refreshButton').addEventListener('click', () => { void refresh(); });
get('autoRefresh').addEventListener('change', () => { if (get<HTMLInputElement>('autoRefresh').checked) void refresh(); });
get('cleanupButton').addEventListener('click', () => { if (active) get<HTMLDialogElement>('cleanupDialog').showModal(); });
get('cancelCleanup').addEventListener('click', () => get<HTMLDialogElement>('cleanupDialog').close());
get('confirmCleanup').addEventListener('click', () => {
  if (!active) return;
  get<HTMLDialogElement>('cleanupDialog').close(); const button = get<HTMLButtonElement>('cleanupButton'); button.disabled = true;
  void api<CleanupResponse>('/api/admin/cleanup', { method: 'POST', body: '{}' })
    .then(async result => { if (active) { feedback(result.message, true); await refresh(); } })
    .catch(error => { if (!checkAuthorization(error) && active) feedback('清理未完成，请稍后重试。'); })
    .finally(() => { button.disabled = false; });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && get<HTMLInputElement>('autoRefresh').checked) void refresh(); });
window.addEventListener('pagehide', () => { stop(); clearInterval(cooldownTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) { lock('正在重新验证管理会话…'); void initialize(); } });
void initialize();
