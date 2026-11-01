import { gameApiOrigin } from './api';
import type { LiveRoomMessage, LiveRoomView } from './live-room-types';
import { STREAM_MAX_DOCUMENT_BYTES, STREAM_ROUNDS } from './stream-types';

export type RoomConnection = 'connecting' | 'connected' | 'retrying' | 'stopped' | 'offline';
export function liveRoomSocketUrl(channel: string): string | null {
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) return null;
  const api = gameApiOrigin();
  const local = !api && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!api && !local) return null;
  const url = new URL((local ? '/guessr-api/stream/rooms/' : '/api/streams/rooms/') + channel, api || location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function validState(state: LiveRoomView, channel: string): boolean {
  return !!state && state.schema === 1 && state.channel === channel
    && Number.isSafeInteger(state.revision) && state.revision >= 0
    && ['waiting', 'guess', 'reveal', 'complete'].includes(state.phase)
    && typeof state.online === 'boolean' && typeof state.paused === 'boolean'
    && Number.isSafeInteger(state.round) && state.round >= 0 && state.round <= STREAM_ROUNDS
    && (state.phase === 'waiting'
      ? state.gameId === null && state.roundId === null && state.clue === null
      : typeof state.gameId === 'string' && /^[a-f0-9-]{36}$/.test(state.gameId)
        && typeof state.roundId === 'string' && /^[a-f0-9-]{36}$/.test(state.roundId)
        && typeof state.clue === 'string' && /^[\w-]{1,2048}$/.test(state.clue));
}

/** One read-only connection for the page, including between games.
 * No polling, viewer heartbeat messages, per-guess requests or auth calls. */
export function watchLiveRoom(channel: string, handlers: {
  state: (state: LiveRoomView) => void;
  status: (status: RoomConnection, detail: string) => void;
}, options: { url?: string; socket?: (url: string) => WebSocket } = {}) {
  const url = options.url ?? liveRoomSocketUrl(channel);
  let socket: WebSocket | undefined, disposed = false, attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let healthySince = 0;
  const network = typeof window === 'undefined' ? undefined : window;
  const offline = () => !!network && navigator.onLine === false;
  const clearWatchdog = () => clearTimeout(watchdog);
  const detach = () => {
    clearWatchdog();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(); socket = undefined;
    }
  };
  const failed = (terminal = false) => {
    detach();
    if (disposed) return;
    if (offline()) { networkLost(); return; }
    if (terminal || attempts >= 6) {
      handlers.status('stopped', 'NoitaGuessr game connection unavailable. Try reconnecting.');
      return;
    }
    handlers.status('retrying', 'Reconnecting to the NoitaGuessr game…');
    const delay = Math.min(60_000, 2_000 * 2 ** attempts++) + Math.random() * 1000;
    retryTimer = setTimeout(connect, delay);
  };
  const watch = (milliseconds: number) => {
    clearWatchdog();
    watchdog = setTimeout(() => failed(), milliseconds);
  };
  const connect = () => {
    if (disposed) return;
    if (offline()) { networkLost(); return; }
    if (!url) { handlers.status('stopped', 'NoitaGuessr multiplayer games are not configured on this site yet.'); return; }
    handlers.status(attempts ? 'retrying' : 'connecting', 'Connecting to the NoitaGuessr game…');
    healthySince = Date.now();
    try { socket = (options.socket ?? (url => new WebSocket(url)))(url); }
    catch { failed(); return; }
    watch(20_000);
    socket.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > STREAM_MAX_DOCUMENT_BYTES * 2 + 4096) { failed(true); return; }
      let message: LiveRoomMessage;
      try { message = JSON.parse(event.data); } catch { failed(true); return; }
      if (message?.type === 'heartbeat' && Number.isFinite(message.at)) {
        // The one host pulse supplies every viewer's liveness signal.
        watch(180_000);
      } else if (message?.type === 'state' && validState(message.state, channel)) {
        handlers.state(message.state);
        handlers.status('connected', '');
        if (message.state.online) watch(180_000);
        else clearWatchdog(); // A waiting/offline host does not trigger polling.
      } else { failed(true); return; }
      if (Date.now() - healthySince > 300_000) attempts = 0;
    };
    socket.onclose = event => failed(event.code === 1008);
    socket.onerror = () => failed();
  };
  const networkLost = () => {
    clearTimeout(retryTimer);
    detach();
    if (!disposed) handlers.status('offline', 'You are offline. Reconnect to continue.');
  };
  const networkRestored = () => {
    if (disposed || socket) return;
    clearTimeout(retryTimer);
    attempts = 0;
    connect();
  };
  network?.addEventListener('offline', networkLost);
  network?.addEventListener('online', networkRestored);
  connect();
  return {
    retry() { clearTimeout(retryTimer); detach(); attempts = 0; connect(); },
    dispose() {
      disposed = true; clearTimeout(retryTimer); detach();
      network?.removeEventListener('offline', networkLost);
      network?.removeEventListener('online', networkRestored);
    },
  };
}
