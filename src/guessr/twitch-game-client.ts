import { StreamPacketReader, streamPacketText, type GuessRejectionReason } from './stream-wire';
import type { StreamChatMessage } from './stream-state';
import type { StreamReveal } from './stream-types';
import type { LiveRoomView } from './live-room-types';
import type { RoomConnection } from './live-room-types';
import type { TwitchChatStatus } from './twitch-chat';
import type { TwitchViewer } from './twitch-viewer';
import { GUESSR_TRANSPORT_CHANNEL } from './chat-transport';
import { gameCode, gameIdFromCode } from './routes';
import { prepareAreaScorer } from './area-rules';
import { chatEnvelope } from './chat-envelope';
import { connectionDiagnostic } from './connection-diagnostics';

/** Receives through the page's existing Twitch connection. No Cloudflare socket,
 * polling, viewer heartbeat, or per-guess Worker request. */
export function watchTwitchGame(viewer: TwitchViewer, channel: string, expectedGame: string | undefined, handlers: {
  state: (state: LiveRoomView) => void;
  status: (state: RoomConnection, detail: string) => void;
  reveal: (round: number, reveal: StreamReveal) => void;
  receipts: (round: number, keys: string[], rejected: boolean, reason?: GuessRejectionReason) => void;
  recovery: () => { missing: number; receipts: { round: number; key: string }[] };
}) {
  let closed = false, currentGame = expectedGame, revision = -1, connected = false, lastRequest = 0;
  let needsState = true;
  let consentedUserId: string | null = null;
  const consentKey = () => currentGame ? 'noitamap-guessr-joined-v2:' + channel + ':' + currentGame : null;
  const hasJoined = () => {
    const id = viewer.getState().userId;
    if (!id || !viewer.getState().connected) return false;
    if (consentedUserId === id) return true;
    try { return !!consentKey() && sessionStorage.getItem(consentKey()!) === id; } catch { return false; }
  };
  const rememberJoin = () => {
    if (!consentedUserId || !consentKey()) return;
    try { sessionStorage.setItem(consentKey()!, consentedUserId); } catch { /* This open tab still retains consent. */ }
  };
  let timeOffset = 0, hasClock = false;
  let latest: LiveRoomView | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined, requestTimer: ReturnType<typeof setTimeout> | undefined;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const reader = new StreamPacketReader(channel, expectedGame, local);
  const watch = () => {
    clearTimeout(watchdog);
    if (!hasJoined() || latest?.ended || latest?.phase === 'complete' || latest?.timing?.phase === 'lobby' || latest?.timing?.deadline === null) return;
    const delay = latest?.timing?.deadline ? Math.max(10_000, latest.timing.deadline - Date.now() - timeOffset + 15_000) : 15_000;
    watchdog = setTimeout(() => {
      if (closed) return;
      connectionDiagnostic({ event: 'game-update-timeout' });
      handlers.status('retrying', 'Waiting for the streamer’s game update.');
      needsState = true; request(); watch();
    }, delay);
  };
  const request = () => {
    clearTimeout(requestTimer); requestTimer = undefined;
    if (closed || !hasJoined() || latest?.ended || latest?.phase === 'complete' || !connected || !viewer.getState().connected) return;
    const recovery = handlers.recovery();
    // A delayed check may have been answered by a broadcast while waiting for
    // the send budget. Never turn it into another join/resync request.
    if (!needsState && !recovery.missing && !recovery.receipts.length) return;
    if (viewer.getState().sending) { requestTimer = setTimeout(request, 1000); return; }
    const wait = lastRequest + 6000 - Date.now();
    if (wait > 0) { requestTimer = setTimeout(request, wait); return; }
    lastRequest = Date.now();
    const receipts = recovery.receipts.slice(0, 6).filter(r => r.round >= 0 && r.round < 10 && /^[a-f0-9]{16}$/.test(r.key))
      .map(r => `${r.round}:${r.key}`).join(',');
    const code = currentGame ? gameCode(currentGame, 'twitch') : '-';
    const rounds = recovery.receipts.length ? recovery.receipts.slice(0, 6).map(r => r.round + 1)
      : Array.from({ length: 10 }, (_, i) => i + 1).filter(round => recovery.missing & 1 << (round - 1));
    const label = latest && !recovery.receipts.length && !recovery.missing ? `NoitaGuessr ${code}: reconnecting.`
      : recovery.receipts.length ? `NoitaGuessr ${code}: checking guess delivery for rounds ${rounds.join(', ')}.`
      : recovery.missing ? `NoitaGuessr ${code}: restoring results for rounds ${rounds.join(', ')}.`
      : `NoitaGuessr ${code}: joining ${channel}'s game.`;
    // Older host tabs retain the existing command until they reload. Capability
    // comes from a fresh host state; F5/reconnect always requests state first.
    const command = needsState || latest?.timing?.recovery !== 1 ? '!noitaguessr_sync' : '!noitaguessr_recover';
    const requestText = `${command} ${channel} ${code} ${(recovery.missing & 1023).toString(16)}${receipts ? ' ' + receipts : ''}`;
    const message = chatEnvelope(label, new Uint8Array([78, 71, 82, ...new TextEncoder().encode(requestText)]));
    void viewer.sendMessage(GUESSR_TRANSPORT_CHANNEL, message).catch(() => {
      if (!closed && !latest) handlers.status('retrying', 'Waiting for the streamer’s game update.');
    });
  };
  if (expectedGame) try {
    const raw = localStorage.getItem('noitamap-guessr-live:' + expectedGame);
    const cached = raw && raw.length < 8192 ? JSON.parse(raw) as LiveRoomView : null;
    if (cached?.gameId === expectedGame && cached.channel === channel && cached.timing && cached.expiresAt! > Date.now())
      { latest = cached; handlers.state(cached.ended || cached.phase === 'complete' ? cached : { ...cached, online: false, paused: true }); }
  } catch { /* No cache is required to join. */ }
  return {
    hasJoined,
    join() {
      const state = viewer.getState();
      if (closed || !state.connected || !state.userId) return;
      consentedUserId = state.userId; rememberJoin(); needsState = true; request(); watch();
    },
    async receive(message: StreamChatMessage) {
      if (closed || message.player.login !== channel) return;
      const receivedAt = Date.now();
      const match = /^!noitaguessr_state ([0-9a-z]{26}) /.exec(streamPacketText(message.text));
      const other = match && gameIdFromCode(match[1]);
      if (currentGame && other && other !== currentGame) {
        handlers.status('stopped', 'This game is no longer active.'); return;
      }
      const packet = await reader.receive(message);
      if (closed || !packet || currentGame && packet.gameId !== currentGame) return;
      // Decompression/validation time is local work, not clock skew. Sampling
      // after awaiting it makes the displayed countdown run behind Twitch.
      const offset = packet.sentAt - receivedAt;
      timeOffset = !hasClock || Math.abs(offset - timeOffset) > 10_000 ? offset : Math.max(timeOffset, offset); hasClock = true;
      currentGame = packet.gameId; rememberJoin();
      const payload = packet.payload;
      if (payload.type === 'state') {
        if (payload.state.revision < revision) return;
        if (payload.state.clue === null && !payload.state.ended && payload.state.timing?.phase !== 'lobby') {
          if (latest?.roundId !== payload.state.roundId || !latest.clue) { needsState = true; request(); return; }
          payload.state.clue = latest.clue;
        }
        revision = payload.state.revision;
        latest = payload.state;
        needsState = false;
        watch();
        try { localStorage.setItem('noitamap-guessr-live:' + currentGame, JSON.stringify(payload.state)); } catch { /* Optional cache. */ }
        handlers.state(payload.state);
        const ended = payload.state.ended || payload.state.phase === 'waiting' && payload.state.timing?.phase !== 'lobby';
        handlers.status(ended ? 'stopped' : payload.state.paused && payload.state.phase !== 'complete' ? 'retrying' : 'connected',
          ended ? 'The streamer ended this game.' : payload.state.paused ? 'The streamer is disconnected from NoitaGuessr' : '');
      } else if (payload.type === 'reveal') {
        try { prepareAreaScorer(payload.reveal.area, payload.reveal.answer); } catch { return; }
        handlers.reveal(payload.round, payload.reveal);
      } else handlers.receipts(payload.round, payload.keys, !!payload.rejected, payload.reason);
    },
    transport(status: TwitchChatStatus, detail: string) {
      if (closed) return;
      connected = status === 'live';
      if (connected) {
        if (latest?.ended) { handlers.status('stopped', 'The streamer ended this game.'); return; }
        if (latest?.phase === 'complete') { handlers.status('connected', ''); return; }
        needsState = true;
        handlers.status('connecting', 'Waiting for the streamer’s game update.'); watch(); request();
      }
      else {
        clearTimeout(watchdog);
        handlers.status(status === 'connecting' ? 'connecting' : status === 'reconnecting' ? 'retrying' : 'stopped', detail);
      }
    },
    retry() { needsState = true; request(); watch(); },
    now() { return Date.now() + timeOffset; },
    requestRecovery: request,
    dispose() { closed = true; clearTimeout(watchdog); clearTimeout(requestTimer); },
  };
}
