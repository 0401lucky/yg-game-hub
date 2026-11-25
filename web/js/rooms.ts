import type { HubRoomsResponse } from '../operationsProtocol.ts';
import { api, feedback, get, RoomListView, timeLabel } from './operationsUi.ts';

const view = new RoomListView();
let pending: AbortController | null = null;
let timer: number | undefined;

async function refresh(): Promise<void> {
  if (pending) return;
  const controller = new AbortController(); pending = controller;
  get<HTMLButtonElement>('refreshButton').disabled = true;
  try {
    const data = await api<HubRoomsResponse>('/api/hub/rooms', { signal: controller.signal });
    if (controller.signal.aborted) return;
    view.setRooms(data.rooms);
    get('publicRoomCount').textContent = String(data.rooms.length);
    get('joinableRoomCount').textContent = String(data.rooms.filter(room => room.joinUrl).length);
    get('playingRoomCount').textContent = String(data.rooms.filter(room => room.state === 'playing').length);
    get('connectionStatus').textContent = '房间实时更新'; get('connectionStatus').dataset.state = 'online';
    get('lastUpdated').textContent = `更新于 ${timeLabel(data.timestamp)}`;
    if (get('opsFeedback').dataset.state !== 'success') feedback('');
  } catch {
    if (!controller.signal.aborted) {
      get('connectionStatus').textContent = '更新暂时失败'; get('connectionStatus').dataset.state = 'error';
      feedback('房间列表暂时无法更新，请点击刷新重试。'); get('roomsGrid').setAttribute('aria-busy', 'false');
    }
  } finally {
    if (pending === controller) { pending = null; get<HTMLButtonElement>('refreshButton').disabled = false; }
  }
}
function startAutoRefresh(): void {
  clearInterval(timer);
  timer = window.setInterval(() => { if (get<HTMLInputElement>('autoRefresh').checked && !document.hidden) void refresh(); }, 5000);
}
get('refreshButton').addEventListener('click', () => { void refresh(); });
get('autoRefresh').addEventListener('change', () => { if (get<HTMLInputElement>('autoRefresh').checked) void refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && get<HTMLInputElement>('autoRefresh').checked) void refresh(); });
window.addEventListener('pagehide', () => { clearInterval(timer); pending?.abort(); });
window.addEventListener('pageshow', event => {
  if (event.persisted) { pending?.abort(); pending = null; startAutoRefresh(); if (get<HTMLInputElement>('autoRefresh').checked) void refresh(); }
});
startAutoRefresh();
void refresh();
