import { DurableObject } from 'cloudflare:workers';
import {
  expireLiveRoom, liveRoomChannelPattern, liveRoomView, LIVE_ROOM_MAX_VIEWERS,
  nextLiveRoomAlarm, startLiveRoom, transitionLiveRoom,
  type LiveRoomAction, type LiveRoomState,
} from '../../../src/guessr/live-room-core';
import type { LiveRoomGame, LiveRoomMessage, LiveRoomView } from '../../../src/guessr/live-room-types';
import type { StreamPublishedResult, StreamRoundOutcome } from '../../../src/guessr/stream-types';

/** One channel, one durable coordinator. Viewer sockets never send guesses or heartbeats. */
export class LiveRoom extends DurableObject<CloudflareBindings> {
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    // The SQLite calls are synchronous: setup cannot interleave with another event.
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS live_room (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)',
    );
  }

  #read(): LiveRoomState | null {
    const row = this.ctx.storage.sql.exec<{ state: string }>('SELECT state FROM live_room WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.state) as LiveRoomState : null;
  }

  #broadcast(message: LiveRoomMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(encoded); }
      catch { try { socket.close(1011, 'Connection lost.'); } catch { /* Already closed. */ } }
    }
  }

  async #commit(before: LiveRoomState | null, after: LiveRoomState, now: number, heartbeat = false, reschedule = false): Promise<LiveRoomView> {
    const view = liveRoomView(after, after.game.channel, now);
    if (after !== before) {
      this.ctx.storage.sql.exec(
        'INSERT INTO live_room (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
        JSON.stringify(after),
      );
    }
    // The storage output gate holds broadcasts/RPC results until the write commits.
    if (!before || before.revision !== after.revision) this.#broadcast({ type: 'state', state: view });
    if (heartbeat) this.#broadcast({ type: 'heartbeat', at: now });
    if (after !== before || reschedule) {
      const alarm = nextLiveRoomAlarm(after, now);
      if (alarm === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(alarm);
    }
    return view;
  }

  start(ownerId: string, game: LiveRoomGame): Promise<LiveRoomView> {
    const now = Date.now(), before = this.#read();
    return this.#commit(before, startLiveRoom(before, ownerId, game, now), now);
  }

  #transition(ownerId: string, gameId: string, action: LiveRoomAction): Promise<LiveRoomView> {
    const now = Date.now(), before = this.#read();
    const after = transitionLiveRoom(before, ownerId, gameId, action, now);
    return this.#commit(before, after, now, action.type === 'pulse');
  }

  advance(ownerId: string, gameId: string, roundId: string): Promise<LiveRoomView> {
    return this.#transition(ownerId, gameId, { type: 'advance', roundId });
  }
  reveal(ownerId: string, gameId: string, roundId: string, outcome?: StreamRoundOutcome): Promise<LiveRoomView> {
    return this.#transition(ownerId, gameId, { type: 'reveal', roundId, outcome });
  }
  pulse(ownerId: string, gameId: string, hostProVerifiedUntil?: number): Promise<LiveRoomView> {
    return this.#transition(ownerId, gameId, { type: 'pulse', hostProVerifiedUntil });
  }
  pause(ownerId: string, gameId: string, paused: boolean): Promise<LiveRoomView> {
    return this.#transition(ownerId, gameId, { type: 'pause', paused });
  }
  quit(ownerId: string, gameId: string): Promise<LiveRoomView> {
    return this.#transition(ownerId, gameId, { type: 'quit' });
  }
  publish(ownerId: string, gameId: string, result?: StreamPublishedResult): Promise<LiveRoomView> {
    return this.#transition(ownerId, gameId, { type: 'publish', result });
  }

  async fetch(request: Request): Promise<Response> {
    const channel = new URL(request.url).searchParams.get('channel') || '';
    if (!liveRoomChannelPattern.test(channel)) return new Response('Invalid channel.', { status: 400 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('A WebSocket connection is required.', { status: 426 });
    }
    const origin = request.headers.get('Origin') || '';
    if (!this.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).includes(origin)) {
      return new Response('Origin is not allowed.', { status: 403 });
    }
    if (this.ctx.getWebSockets().length >= LIVE_ROOM_MAX_VIEWERS) {
      return new Response('This room is full. Please try later.', { status: 503, headers: { 'Retry-After': '60' } });
    }
    const now = Date.now(), before = this.#read();
    if (before && before.game.channel !== channel) return new Response('Wrong channel.', { status: 409 });
    let state = expireLiveRoom(before, now);
    if (state && state !== before) {
      await this.#commit(before, state, now);
      // A new host event may have run while the alarm write completed.
      state = this.#read();
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'state', state: liveRoomView(state, channel, now) } satisfies LiveRoomMessage));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    // Guesses stay on Twitch. Client polling and application pings are deliberately unsupported.
    socket.close(1008, 'This connection only receives round updates.');
  }
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try { socket.close(code === 1005 ? 1000 : code, reason); } catch { /* Already closed. */ }
  }
  webSocketError(socket: WebSocket): void {
    try { socket.close(1011, 'Connection lost.'); } catch { /* Already closed. */ }
  }

  async alarm(): Promise<void> {
    const now = Date.now(), before = this.#read();
    const after = expireLiveRoom(before, now);
    if (after) await this.#commit(before, after, now, false, true);
  }
}
