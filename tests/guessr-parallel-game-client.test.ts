// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { watchParallelGame } from '../src/guessr/parallel-game-client';
import type { ParallelServerMessage } from '../src/guessr/parallel-types';
import type { TwitchViewer } from '../src/guessr/twitch-viewer';
import type { StreamResult } from '../src/guessr/stream-types';

const transport = vi.hoisted(() => ({ receive: (_message: ParallelServerMessage) => {}, join: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/guessr/parallel-connection', () => ({ ParallelConnection: class {
  constructor(_origin: string, _game: string, _player: string, _auth: unknown, events: { message: typeof transport.receive }) {
    transport.receive = events.message;
  }
  connected() { return true; } now() { return Date.now(); } dispose = transport.dispose;
} }));
vi.mock('../src/guessr/twitch-game-client', () => ({ watchTwitchGame: () => ({ join: transport.join, dispose: vi.fn() }) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

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
