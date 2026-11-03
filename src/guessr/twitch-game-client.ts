import { StreamPacketReader } from './stream-wire';
import type { StreamChatMessage } from './stream-state';
import type { StreamReveal } from './stream-types';
import type { LiveRoomView } from './live-room-types';
import type { RoomConnection } from './live-room-client';
import type { TwitchChatStatus } from './twitch-chat';
import type { TwitchViewer } from './twitch-viewer';
import { GUESSR_TRANSPORT_CHANNEL } from './chat-transport';
import { gameCode, gameIdFromCode } from './routes';
import { prepareAreaScorer } from './area-rules';

/** Receives through the page's existing Twitch connection. No Cloudflare socket,
 * polling, viewer heartbeat, or per-guess Worker request. */
export function watchTwitchGame(viewer: TwitchViewer, channel: string, expectedGame: string | undefined, handlers: {
  state: (state: LiveRoomView) => void;
  status: (state: RoomConnection, detail: string) => void;
  reveal: (round: number, reveal: StreamReveal) => void;
  receipts: (round: number, keys: string[], rejected: boolean) => void;
  recovery: () => { missing: number; receipts: { round: number; key: string }[] };
}) {
  let closed = false, currentGame = expectedGame, revision = -1, connected = false, lastRequest = 0;
  let timeOffset = 0, hasClock = false;
  let latest: LiveRoomView | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined, requestTimer: ReturnType<typeof setTimeout> | undefined;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const reader = new StreamPacketReader(channel, expectedGame, local);
  const watch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (closed) return;
      handlers.status('stopped', 'The streamer is disconnected from NoitaGuessr');
    }, 35_000);
  };
  const request = () => {
    if (closed || !connected || !viewer.getState().connected) return;
    clearTimeout(requestTimer);
    if (viewer.getState().sending) { requestTimer = setTimeout(request, 1000); return; }
    const wait = lastRequest + 6000 - Date.now();
    if (wait > 0) { requestTimer = setTimeout(request, wait); return; }
    lastRequest = Date.now();
    const recovery = handlers.recovery();
    const receipts = recovery.receipts.slice(0, 10).filter(r => r.round >= 0 && r.round < 10 && /^[a-f0-9]{16}$/.test(r.key))
      .map(r => `${r.round}:${r.key}`).join(',');
    const message = `!noitaguessr_sync ${channel} ${currentGame ? gameCode(currentGame) : '-'} ${(recovery.missing & 1023).toString(16)}${receipts ? ' ' + receipts : ''}`;
    void viewer.sendMessage(GUESSR_TRANSPORT_CHANNEL, message).catch(() => {
      if (!closed && !latest) handlers.status('retrying', 'Waiting for the streamer’s game update.');
    });
  };
  if (expectedGame) try {
    const raw = localStorage.getItem('noitamap-guessr-live:' + expectedGame);
    const cached = raw && raw.length < 8192 ? JSON.parse(raw) as LiveRoomView : null;
    if (cached?.gameId === expectedGame && cached.channel === channel && cached.timing && cached.expiresAt! > Date.now())
      { latest = cached; handlers.state({ ...cached, online: false, paused: true }); }
  } catch { /* No cache is required to join. */ }
  return {
    async receive(message: StreamChatMessage) {
      if (closed || message.player.login !== channel) return;
      const match = /^!noitaguessr_state ([0-9a-z]{26}) /.exec(message.text);
      const other = match && gameIdFromCode(match[1]);
      if (currentGame && other && other !== currentGame) {
        handlers.status('stopped', 'This game is no longer active.'); return;
      }
      const packet = await reader.receive(message);
      if (closed || !packet || currentGame && packet.gameId !== currentGame) return;
      const offset = packet.sentAt - Date.now();
      timeOffset = !hasClock || Math.abs(offset - timeOffset) > 10_000 ? offset : Math.max(timeOffset, offset); hasClock = true;
      currentGame = packet.gameId; watch();
      const payload = packet.payload;
      if (payload.type === 'state') {
        if (payload.state.revision < revision) return;
        if (payload.state.clue === null) {
          if (latest?.roundId !== payload.state.roundId || !latest.clue) { request(); return; }
          payload.state.clue = latest.clue;
        }
        revision = payload.state.revision;
        latest = payload.state;
        try { localStorage.setItem('noitamap-guessr-live:' + currentGame, JSON.stringify(payload.state)); } catch { /* Optional cache. */ }
        handlers.state(payload.state);
        handlers.status(payload.state.phase === 'waiting' ? 'stopped' : payload.state.paused && payload.state.phase !== 'complete' ? 'retrying' : 'connected',
          payload.state.phase === 'waiting' ? 'This game is no longer active.' : payload.state.paused ? 'The streamer is disconnected from NoitaGuessr' : '');
      } else if (payload.type === 'reveal') {
        try { prepareAreaScorer(payload.reveal.area, payload.reveal.answer); } catch { return; }
        handlers.reveal(payload.round, payload.reveal);
      } else handlers.receipts(payload.round, payload.keys, !!payload.rejected);
    },
    transport(status: TwitchChatStatus, detail: string) {
      if (closed) return;
      connected = status === 'live';
      if (connected) { handlers.status('connecting', 'Waiting for the streamer’s game update.'); watch(); request(); }
      else {
        clearTimeout(watchdog);
        handlers.status(status === 'connecting' ? 'connecting' : status === 'reconnecting' ? 'retrying' : 'stopped', detail);
      }
    },
    retry() { request(); watch(); },
    now() { return Date.now() + timeOffset; },
    requestRecovery: request,
    dispose() { closed = true; clearTimeout(watchdog); clearTimeout(requestTimer); },
  };
}
