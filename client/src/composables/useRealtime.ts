import { onBeforeUnmount, onMounted } from 'vue';
import { api } from '../api';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Opens a WebSocket to /api/ws and calls `onEvent` for every message —
 * events carry no payload (see server/src/realtime.ts), so the caller just
 * refetches its own data. Authenticates with a short-lived ticket (fetched
 * fresh on every (re)connect) rather than the long-lived access token, since
 * a WebSocket handshake cannot carry an Authorization header.
 */
export function useRealtime(onEvent: () => void): void {
  let socket: WebSocket | null = null;
  let backoffMs = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    let ticket: string;
    try {
      ticket = (await api<{ ticket: string }>('/ws-ticket', { method: 'POST' })).ticket;
    } catch {
      scheduleReconnect();
      return;
    }
    if (stopped) return;

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${window.location.host}/api/ws?ticket=${ticket}`);

    socket.onopen = () => {
      backoffMs = MIN_BACKOFF_MS;
    };
    socket.onmessage = () => onEvent();
    socket.onclose = () => {
      if (!stopped) scheduleReconnect();
    };
    socket.onerror = () => socket?.close();
  }

  function scheduleReconnect() {
    reconnectTimer = setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      void connect();
    }, backoffMs);
  }

  onMounted(connect);
  onBeforeUnmount(() => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  });
}
