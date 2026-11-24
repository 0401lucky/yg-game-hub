






import { errorMessage } from '../../shared/errors.ts';
// 前端兜底埋点：异常和页面生命周期各往服务端丢一条。
//
// 为什么需要它：手机上「点一下按钮 App 就退出去」这种，浏览器不会把控制台留给我们，
// 事后只能靠服务端日志区分两种完全不同的情况 ——
//   1) 页面自己 window.location 跳走了（能收到一条 pagehide，且服务端会看到新页面的 WS 连接）
//   2) 渲染进程被系统/内存杀掉（收不到 pagehide，也不会有新页面连接，只有一个断开的 socket）
// 有了这两条线索，同类问题下次不用再靠猜。

const REPORT_URL = '/api/client-error';
const MAX_REPORTS = 8;

let sent = 0;
let installed = false;

function send(kind: string, payload: {message?: string; stack?: string; extra?: unknown} = {}) {
    if (sent >= MAX_REPORTS) return;
    sent += 1;

    const body = JSON.stringify({
        kind,
        url: location.href,
        message: payload.message || '',
        stack: payload.stack || '',
        extra: payload.extra || null,
        ts: Date.now(),
    });

    try {
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            // pagehide 只有 beacon 发得出去
            if (navigator.sendBeacon(REPORT_URL, new Blob([body], { type: 'application/json' }))) return;
        }
        fetch(REPORT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => { /* 上报本身失败就算了，绝不能反过来影响游戏 */ });
    } catch (error) {
        // 静默
    }
}

export function installClientTelemetry(context = 'flight') {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    window.addEventListener('error', (event) => {
        const err = event.error;
        send('error', {
            message: event.message || (err && errorMessage(err)) || 'unknown error',
            stack: err && err.stack ? String(err.stack) : '',
            extra: { context, file: event.filename, line: event.lineno, col: event.colno },
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        send('unhandledrejection', {
            message: (reason && (reason.message || String(reason))) || 'unhandled rejection',
            stack: reason && reason.stack ? String(reason.stack) : '',
            extra: { context },
        });
    });

    // 页面被卸载（刷新 / 跳转 / 被系统回收前给的最后一次机会）
    window.addEventListener('pagehide', () => {
        send('pagehide', { extra: { context } });
    });
}
