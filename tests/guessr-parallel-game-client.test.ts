// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { watchParallelGame } from '../src/guessr/parallel-game-client';
import type { ParallelServerMessage } from '../src/guessr/parallel-types';
import type { TwitchViewer } from '../src/guessr/twitch-viewer';
import type { StreamResult } from '../src/guessr/stream-types';
import type { RoomConnection } from '../src/guessr/live-room-types';

const transport = vi.hoisted(() => ({ receive: (_message: ParallelServerMessage) => {}, status: (_state: RoomConnection, _detail: string) => {}, connected: true, offset: 0, join: vi.fn(), dispose: vi.fn(), twitch: vi.fn() }));
vi.mock('../src/guessr/parallel-connection', () => ({ ParallelConnection: class {
  constructor(_origin: string, _game: string, _player: string, _auth: unknown, events: { message: typeof transport.receive; status: typeof transport.status }) {
    transport.receive = events.message; transport.status = events.status;
  }
  connected() { return transport.connected; } now() { return Date.now() + transport.offset; } dispose = transport.dispose;
} }));
vi.mock('../src/guessr/twitch-game-client', () => ({ watchTwitchGame: () => { transport.twitch(); return { join: transport.join, dispose: vi.fn() }; } }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); transport.connected = true; transport.offset = 0; });

it('delivers the existing published-result socket event to chatters without fetching or reposting it', () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('No additional result request'); }));
  const viewer = { getState: () => ({ connected: true, userId: '123' }),
    subscribe(callback: () => void) { callback(); return () => {}; } } as unknown as TwitchViewer;
  const handlers = { state: vi.fn(), status: vi.fn(), reveal: vi.fn(), receipts: vi.fn(),
    recovery: () => ({ missing: 0, receipts: [] }), durableReceipt: vi.fn(), roundResults: vi.fn(), published: vi.fn() };
  const id = '11111111-1111-4111-8111-111111111111';
  const client = watchParallelGame(viewer, 'wuote', id, handlers);
  const result: StreamResult = { schema: 1, id, version: 'fixture', createdAt: 1, finishedAt: 2,
    host: { id: '456', login: 'wuote', name: 'WUOTE' }, rounds: [], players: [] };
  transport.receive({ type: 'published', result });
  expect(handlers.published).toHaveBeenCalledExactlyOnceWith(result);
  transport.receive({ type: 'published', result: { ...result, id: '22222222-2222-4222-8222-222222222222' } });
  expect(handlers.published).toHaveBeenCalledTimes(1);
  expect(transport.join).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  client.dispose(); expect(transport.dispose).toHaveBeenCalledTimes(1);
});

it('keeps PvP time synchronized while reconnecting and preserves the actual stopped reason', () => {
  const viewer = { getState: () => ({ connected: true, userId: '123' }),
    subscribe(callback: () => void) { callback(); return () => {}; } } as unknown as TwitchViewer;
  const handlers = { state: vi.fn(), status: vi.fn(), reveal: vi.fn(), receipts: vi.fn(),
    recovery: () => ({ missing: 0, receipts: [] }), durableReceipt: vi.fn(), roundResults: vi.fn(), published: vi.fn() };
  const client = watchParallelGame(viewer, 'pvp', '11111111-1111-4111-8111-111111111111', handlers, { pvp: true });
  transport.connected = false; transport.offset = 120000;
  transport.status('retrying', 'Reconnecting…');
  expect(client.now()).toBeGreaterThanOrEqual(Date.now() + 119990);
  for (const detail of ['This invitation is not available.', 'This game is open in another tab. Continue there.']) {
    transport.status('stopped', detail); expect(handlers.status).toHaveBeenLastCalledWith('stopped', detail);
  }
  expect(transport.twitch).not.toHaveBeenCalled(); expect(transport.join).not.toHaveBeenCalled();
  client.dispose();
});
