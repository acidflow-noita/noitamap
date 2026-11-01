import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  expireLiveRoom, liveRoomView, startLiveRoom, transitionLiveRoom,
  nextLiveRoomAlarm, liveRoomChannelPattern, LIVE_ROOM_MAX_VIEWERS,
  type LiveRoomState, type LiveRoomAction,
} from '../../src/guessr/live-room-core.ts';
import type { LiveRoomMethods, LiveRoomMessage } from '../../src/guessr/live-room-types.ts';

/** Development transport; uses the same transitions as the deployed coordinator. */
export class LocalLiveRooms {
  private rooms = new Map<string, ReturnType<LocalLiveRooms['create']>>();
  readonly traffic = { joins: 0, hostRequests: 0, viewerMessages: 0, broadcasts: 0 };
  private readonly directory: string;
  constructor(root: string) { this.directory = resolve(root, 'task/guessr/private/live-rooms'); }
  getByName(channel: string) {
    if (!liveRoomChannelPattern.test(channel)) throw Error('Invalid channel.');
    let room = this.rooms.get(channel);
    if (!room) { room = this.create(channel); this.rooms.set(channel, room); }
    return room;
  }
  private create(channel: string) {
    let state: LiveRoomState | null = null;
    const clients = new Set<WebSocket>();
    const file = resolve(this.directory, channel + '.json');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tail: Promise<unknown> = readFile(file, 'utf8').then(raw => { state = JSON.parse(raw); })
      .catch(error => { if (error.code !== 'ENOENT') throw error; });
    const queue = <T>(work: () => Promise<T>): Promise<T> => {
      const job = tail.then(work);
      tail = job.catch(() => {});
      return job;
    };
    const broadcast = (message: LiveRoomMessage) => {
      this.traffic.broadcasts++;
      const text = JSON.stringify(message);
      for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(text);
    };
    const schedule = () => {
      clearTimeout(timer);
      const at = nextLiveRoomAlarm(state, Date.now());
      if (at !== null) {
        timer = setTimeout(() => {
          void queue(async () => { await commit(expireLiveRoom(state, Date.now())); }).catch(() => {});
        }, Math.min(2_147_483_647, Math.max(1, at - Date.now())));
        timer.unref();
      }
    };
    const commit = async (next: LiveRoomState | null) => {
      const changed = next !== state;
      const visibleChange = next?.revision !== state?.revision;
      if (changed) {
        await mkdir(this.directory, { recursive: true });
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
        await rename(temp, file);
        state = next;
      }
      schedule();
      const view = liveRoomView(state, channel, Date.now());
      if (visibleChange) broadcast({ type: 'state', state: view });
      return view;
    };
    const transition = (owner: string, game: string, action: LiveRoomAction) => queue(async () => {
      this.traffic.hostRequests++;
      const view = await commit(transitionLiveRoom(state, owner, game, action, Date.now()));
      if (action.type === 'pulse') broadcast({ type: 'heartbeat', at: Date.now() });
      return view;
    });
    const methods: LiveRoomMethods = {
      start: (owner, game) => queue(async () => {
        this.traffic.hostRequests++;
        return commit(startLiveRoom(state, owner, game, Date.now()));
      }),
      reveal: (owner, game, roundId, outcome) => transition(owner, game, { type: 'reveal', roundId, outcome }),
      advance: (owner, game, roundId) => transition(owner, game, { type: 'advance', roundId }),
      pause: (owner, game, paused) => transition(owner, game, { type: 'pause', paused }),
      quit: (owner, game) => transition(owner, game, { type: 'quit' }),
      pulse: (owner, game, hostProVerifiedUntil) => transition(owner, game, { type: 'pulse', hostProVerifiedUntil }),
      publish: (owner, game, result) => transition(owner, game, { type: 'publish', result }),
    };
    return {
      ...methods,
      join: (socket: WebSocket) => {
        if (clients.size >= LIVE_ROOM_MAX_VIEWERS) { socket.close(1008, 'Room is full.'); return; }
        this.traffic.joins++;
        clients.add(socket);
        socket.on('error', () => socket.close());
        socket.on('close', () => clients.delete(socket));
        socket.on('message', () => {
          this.traffic.viewerMessages++;
          socket.close(1008, 'This connection is read-only.');
        });
        void queue(async () => {
          await commit(expireLiveRoom(state, Date.now()));
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'state', state: liveRoomView(state, channel, Date.now()) }));
        }).catch(() => socket.close(1011, 'Could not load the live room.'));
      },
      dispose: () => { clearTimeout(timer); for (const client of clients) client.close(1001, 'Server stopped.'); },
    };
  }
  attach(server: Server): () => void {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    const upgrade: Parameters<Server['on']>[1] = (req: any, socket: any, head: Buffer) => {
      const path = new URL(req.url || '/', 'http://local').pathname;
      const match = /^\/guessr-api\/stream\/rooms\/([a-z0-9_]{1,25})$/.exec(path);
      if (!match) return;
      try {
        const host = new URL('http://' + req.headers.host);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)
          || !req.headers.origin || new URL(req.headers.origin).host !== host.host)
          throw Error();
        sockets.handleUpgrade(req, socket, head, ws => this.getByName(match[1]).join(ws));
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
    };
    server.on('upgrade', upgrade);
    const dispose = () => {
      server.off('upgrade', upgrade);
      for (const room of this.rooms.values()) room.dispose();
      sockets.close();
    };
    server.once('close', dispose);
    return dispose;
  }
}
