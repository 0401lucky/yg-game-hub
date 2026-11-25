import type { GameSummary, HubRoom } from '../operationsProtocol.ts';

export function node<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text = ''): HTMLElementTagNameMap[Tag] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}
export function get<Tag extends Element = HTMLElement>(id: string): Tag {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element: ${id}`);
  return result as unknown as Tag;
}
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfter: number;
  constructor(status: number, message: string, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export async function api<Result>(url: string, init: RequestInit = {}): Promise<Result> {
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '暂时无法获取数据，请稍后重试';
    throw new ApiError(response.status, message, Number(response.headers.get('Retry-After')) || 0);
  }
  return data as Result;
}
export function feedback(message: string, success = false): void {
  const element = get('opsFeedback');
  element.textContent = message;
  element.dataset.state = success ? 'success' : 'error';
  element.hidden = !message;
}
export function timeLabel(timestamp: string | number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export class RoomListView {
  private rooms: HubRoom[] = [];
  private games = new Map<string, { name: string; emoji: string }>([
    ['flight', { name: '飞行棋', emoji: '✈️' }], ['doudizhu', { name: '斗地主', emoji: '🃏' }],
  ]);
  private signature = '';
  constructor() {
    for (const id of ['roomGame', 'roomState', 'roomSearch']) get(id).addEventListener(id === 'roomSearch' ? 'input' : 'change', () => this.render());
    get('roomsGrid').addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-copy]') : null;
      if (target?.dataset.copy) void this.copy(target);
    });
  }
  setRooms(rooms: HubRoom[], games?: GameSummary[]): void {
    this.rooms = rooms;
    if (games) for (const game of games) this.games.set(game.id, game);
    this.render();
  }
  clear(): void { this.rooms = []; this.signature = ''; get('roomsGrid').replaceChildren(); get('roomCount').textContent = '0'; }
  private async copy(button: HTMLButtonElement): Promise<void> {
    const content = button.dataset.copy!;
    try {
      await navigator.clipboard.writeText(content.startsWith('/') ? new URL(content, location.origin).href : content);
      feedback(content.startsWith('/') ? '邀请链接已复制，发给朋友就能加入。' : `房间码 ${content} 已复制。`, true);
    } catch { feedback(`复制未完成，可以手动复制：${content.startsWith('/') ? new URL(content, location.origin).href : content}`); }
  }
  private render(): void {
    const game = get<HTMLSelectElement>('roomGame').value;
    const state = get<HTMLSelectElement>('roomState').value;
    const query = get<HTMLInputElement>('roomSearch').value.trim().toLocaleLowerCase();
    const rooms = this.rooms.filter(room => (!game || room.gameId === game)
      && (!state || (state === 'joinable' ? !!room.joinUrl : room.state === state))
      && (!query || [room.code, room.name, ...room.players.map(player => player.nickname)].some(value => value.toLocaleLowerCase().includes(query))));
    get('roomCount').textContent = String(rooms.length);
    get('roomsGrid').setAttribute('aria-busy', 'false');
    const signature = JSON.stringify([rooms, [...this.games], game, state, query]);
    if (signature === this.signature) return;
    this.signature = signature;
    const grid = get('roomsGrid');
    grid.replaceChildren();
    if (!rooms.length) {
      const empty = node('div', 'ops-empty');
      const filtered = !!(game || state || query);
      empty.append(node('h3', '', filtered ? '没找到符合条件的房间' : '现在还没有房间'),
        node('p', '', filtered ? '换个游戏或状态，或者试试其他房间码。' : '自己开一间，邀请朋友来坐坐。'));
      const actions = node('div', 'ops-empty-actions');
      if (filtered) {
        const reset = node('button', 'ops-button', '清除筛选'); reset.type = 'button';
        reset.addEventListener('click', () => {
          get<HTMLSelectElement>('roomGame').value = ''; get<HTMLSelectElement>('roomState').value = ''; get<HTMLInputElement>('roomSearch').value = ''; this.render();
        });
        actions.append(reset);
      } else {
        for (const [text, href] of [['开一间飞行棋', '/games/flight/'], ['开一桌斗地主', '/games/doudizhu/']]) {
          const link = node('a', 'ops-button', text); link.href = href!; actions.append(link);
        }
      }
      empty.append(actions); grid.append(empty); return;
    }
    for (const room of rooms) grid.append(this.card(room));
  }
  private card(room: HubRoom): HTMLElement {
    const card = node('article', 'room-card'); card.dataset.roomCode = room.code; card.dataset.gameId = room.gameId;
    const game = this.games.get(room.gameId);
    const heading = node('div', 'room-card-head');
    heading.append(node('span', 'room-game-name', `${game?.emoji ?? '🎮'} ${game?.name ?? room.gameId}`), node('span', `room-badge ${room.state}`, room.phaseLabel));
    card.append(heading, node('h3', 'room-name', room.name));
    const codeLine = node('div', 'room-code-line');
    const code = node('button', 'room-code', room.code); code.type = 'button'; code.dataset.copy = room.code; code.title = '复制房间码'; code.setAttribute('aria-label', `复制房间码 ${room.code}`);
    codeLine.append(node('span', '', '房间码'), code, node('span', '', `${room.players.length} / ${room.capacity} 人`));
    if (room.isPrivate) codeLine.append(node('span', 'room-private', '私密'));
    card.append(codeLine, node('p', 'room-mode', room.mode));
    const members = node('div', 'room-players');
    for (const player of room.players) {
      const member = node('div', 'room-player');
      const details = node('div');
      const name = node('p', 'room-player-name', player.nickname); name.title = player.nickname;
      details.append(name, node('small', 'room-player-note', [player.isHost ? '房主' : player.isAI ? '人机' : '玩家', !player.connected ? '离线' : player.ready && room.state === 'waiting' ? '已准备' : '在线'].join(' · ')));
      member.append(node('span', `room-avatar${player.isAI ? ' ai' : ''}`, player.isAI ? 'AI' : [...player.nickname][0] ?? '友'), details); members.append(member);
    }
    for (let i = room.players.length; i < room.capacity; i++) members.append(node('div', 'room-player room-open-seat', room.state === 'waiting' ? '空位 · 等你加入' : '本局未使用'));
    card.append(members);
    const actions = node('div', 'room-actions');
    const href = room.joinUrl ?? room.spectateUrl;
    if (href) { const link = node('a', 'ops-button primary', room.joinUrl ? '加入房间 →' : '观看对局 →'); link.href = href; actions.append(link); }
    else if (room.state === 'waiting') { const button = node('button', 'ops-button', '房间已满'); button.type = 'button'; button.disabled = true; actions.append(button); }
    else actions.append(node('span', 'ops-muted', room.state === 'playing' ? '对局进行中' : room.phaseLabel));
    if (room.joinUrl) {
      const invite = node('button', 'ops-button', '复制邀请'); invite.type = 'button'; invite.dataset.copy = room.joinUrl; actions.append(invite);
    }
    card.append(actions); return card;
  }
}
