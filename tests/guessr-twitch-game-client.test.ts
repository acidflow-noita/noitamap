import { readChatEnvelope } from '../src/guessr/chat-envelope';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchTwitchGame } from '../src/guessr/twitch-game-client';
import { encodeStreamPacket } from '../src/guessr/stream-wire';
import type { TwitchViewer } from '../src/guessr/twitch-viewer';
import type { LiveRoomView } from '../src/guessr/live-room-types';

const id = '11111111-1111-4111-8111-111111111111', now = Date.UTC(2026, 10, 3);
const state: LiveRoomView = { schema: 1, gameId: id, channel: 'streamer', hostId: '100', phase: 'guess', revision: 1,
  online: true, paused: false, round: 1, roundId: id, clue: 'abc', expiresAt: now + 86400000,
  timing: { phase: 'warmup', startsAt: now + 3000, deadline: now + 93000, hostRound: 1, seconds: 90, revealed: 0 } };
const clients: ReturnType<typeof watchTwitchGame>[] = [];
const store = new Map<string, string>();
beforeEach(() => {
  store.clear(); vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('location', { hostname: 'noitamap.test' });
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected Cloudflare request'); }));
});
afterEach(() => { clients.splice(0).forEach(c => c.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture() {
  const sendMessage = vi.fn(async () => 'sync-id');
  const viewer = { getState: () => ({ connected: true, userId: '123' }), sendMessage } as unknown as TwitchViewer;
  const handlers = { state: vi.fn(), status: vi.fn(), reveal: vi.fn(), receipts: vi.fn(),
    recovery: vi.fn<Parameters<typeof watchTwitchGame>[3]['recovery']>(() => ({ missing: 0, receipts: [] })) };
  const client = watchTwitchGame(viewer, 'streamer', id, handlers); clients.push(client);
  return { client, sendMessage, handlers };
}
const message = (text: string, login = 'streamer', sender = '100') => ({ id: crypto.randomUUID(), text,
  player: { id: sender, login, name: login }, sentAt: now });
const requestText = (call: unknown) => new TextDecoder().decode(readChatEnvelope((call as [string, string])[1])!.subarray(3));

it.each([true, false])('requests only missing receipts/results when supported, retaining old-host compatibility (supported: %s)', async supported => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(now);
  const f = fixture(); f.client.transport('live', 'Connected');
  const advertised = { ...state, timing: { ...state.timing!, ...(supported ? { recovery: 1 as const } : {}) } };
  for (const text of await encodeStreamPacket(id, { type: 'state', state: advertised })) await f.client.receive(message(text));
  await vi.advanceTimersByTimeAsync(7000);
  f.handlers.recovery.mockReturnValue({ missing: 1, receipts: [{ round: 0, key: '0123456789abcdef' }] });
  f.client.requestRecovery();
  expect(requestText(f.sendMessage.mock.calls[1])).toMatch(supported ? /^!noitaguessr_recover streamer / : /^!noitaguessr_sync streamer /);
  expect(requestText(f.sendMessage.mock.calls[1])).toMatch(/ 1 0:0123456789abcdef$/);
  await vi.advanceTimersByTimeAsync(6000); f.client.retry();
  expect(requestText(f.sendMessage.mock.calls[2])).toMatch(/^!noitaguessr_sync streamer /);
  expect(fetch).not.toHaveBeenCalled();
});

it('cancels a delayed recovery request when the requested receipt has already arrived', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(now);
  const f = fixture(); f.client.transport('live', 'Connected');
  for (const text of await encodeStreamPacket(id, { type: 'state', state })) await f.client.receive(message(text));
  f.handlers.recovery.mockReturnValue({ missing: 0, receipts: [{ round: 0, key: '0123456789abcdef' }] });
  f.client.requestRecovery();
  f.handlers.receipts.mockImplementation(() => f.handlers.recovery.mockReturnValue({ missing: 0, receipts: [] }));
  for (const text of await encodeStreamPacket(id, { type: 'receipts', round: 0, keys: ['0123456789abcdef'] })) await f.client.receive(message(text));
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.handlers.receipts).toHaveBeenCalled();
  expect(f.sendMessage).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});

it('still requests the current state after F5 even when cached data supports targeted recovery', () => {
  store.set('noitamap-guessr-live:' + id, JSON.stringify({ ...state, timing: { ...state.timing!, recovery: 1 } }));
  const f = fixture();
  f.handlers.recovery.mockReturnValue({ missing: 1, receipts: [{ round: 0, key: '0123456789abcdef' }] });
  f.client.transport('live', 'Connected');
  expect(requestText(f.sendMessage.mock.calls[0])).toMatch(/^!noitaguessr_sync streamer /);
  expect(f.handlers.state).toHaveBeenCalledWith(expect.objectContaining({ paused: true, online: false }));
  expect(fetch).not.toHaveBeenCalled();
});

it('uses one Twitch resync request and accepts the owner’s broadcast without any Worker call', async () => {
  const f = fixture(); f.client.transport('live', 'Connected');
  expect(f.sendMessage).toHaveBeenCalledOnce();
  const [channel, wire] = f.sendMessage.mock.calls[0] as unknown as [string, string];
  expect(channel).toBe('noitaguessr');
  expect(wire).toContain('joining streamer');
  expect(wire).not.toContain('need='); expect(wire).not.toContain('[ng:');
  expect(new TextDecoder().decode(readChatEnvelope(wire)!.subarray(3))).toMatch(/^!noitaguessr_sync streamer /);
  const frames = await encodeStreamPacket(id, { type: 'state', state });
  for (const text of frames) await f.client.receive(message(text, 'copycat', '999'));
  for (const text of frames) await f.client.receive(message(text, 'streamer', '999'));
  expect(f.handlers.state).not.toHaveBeenCalled();
  for (const text of frames) await f.client.receive(message(text));
  expect(f.handlers.state).toHaveBeenLastCalledWith(expect.objectContaining({ gameId: id, round: 1, online: true }));
  expect(f.handlers.status).toHaveBeenLastCalledWith('connected', '');
  expect(f.client.now()).toBe(now);
  expect(fetch).not.toHaveBeenCalled();
});

it('renders the cached clue locked after F5 and unlocks only after a fresh owner snapshot', async () => {
  const first = fixture();
  for (const text of await encodeStreamPacket(id, { type: 'state', state })) await first.client.receive(message(text));
  first.client.dispose();
  const restored = fixture();
  expect(restored.handlers.state).toHaveBeenCalledWith(expect.objectContaining({ clue: 'abc', online: false, paused: true }));
  restored.client.transport('live', 'Connected');
  for (const text of await encodeStreamPacket(id, { type: 'state', state: { ...state, revision: 2, round: 2 } }))
    await restored.client.receive(message(text));
  expect(restored.handlers.state).toHaveBeenLastCalledWith(expect.objectContaining({ round: 2, paused: false }));
  expect(restored.sendMessage).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});

it('identifies a missing round update without declaring Twitch disconnected and recovers without polling', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(now);
  const f = fixture(); f.client.transport('live', 'Connected');
  for (const text of await encodeStreamPacket(id, { type: 'state', state })) await f.client.receive(message(text));
  await vi.advanceTimersByTimeAsync(108000);
  expect(f.handlers.status).toHaveBeenLastCalledWith('retrying', 'Waiting for the streamer’s game update.');
  expect(f.sendMessage).toHaveBeenCalledOnce();
  const next = { ...state, revision: 2, round: 2, timing: { ...state.timing!, phase: 'play' as const,
    startsAt: Date.now(), deadline: Date.now() + 30000 } };
  for (const text of await encodeStreamPacket(id, { type: 'state', state: next }))
    await f.client.receive({ ...message(text), sentAt: Date.now() });
  expect(f.handlers.state).toHaveBeenLastCalledWith(expect.objectContaining(next));
  expect(f.handlers.status).toHaveBeenLastCalledWith('connected', '');
  f.client.dispose();
  const restored = fixture();
  expect(restored.handlers.state).toHaveBeenCalledWith(expect.objectContaining({ round: 2, clue: 'abc', paused: true }));
  expect(fetch).not.toHaveBeenCalled();
});

it('does not replace a saved game with a later game from the same streamer', async () => {
  const f = fixture();
  for (const text of await encodeStreamPacket('22222222-2222-4222-8222-222222222222', { type: 'state', state }))
    await f.client.receive(message(text));
  expect(f.handlers.state).not.toHaveBeenCalled();
  expect(f.handlers.status).toHaveBeenLastCalledWith('stopped', 'This game is no longer active.');
  expect(fetch).not.toHaveBeenCalled();
});

it('restores a completed game without sending any Twitch resync or Worker request', () => {
  store.set('noitamap-guessr-live:' + id, JSON.stringify({ ...state, phase: 'complete', resultId: id }));
  const f = fixture(); f.client.transport('live', 'Connected'); f.client.requestRecovery(); f.client.retry();
  expect(f.handlers.state).toHaveBeenCalledWith(expect.objectContaining({ phase: 'complete', resultId: id }));
  expect(f.handlers.status).toHaveBeenLastCalledWith('connected', '');
  expect(f.sendMessage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('applies an explicit game-ended event without needing a clue and retains it across refresh', async () => {
  const f = fixture();
  for (const text of await encodeStreamPacket(id, { type: 'state', state: { ...state, phase: 'waiting', ended: true,
    online: false, paused: true, clue: null, timing: { ...state.timing!, phase: 'lobby' } } })) {
    expect(text).toContain(' game-ended r1 '); await f.client.receive(message(text));
  }
  expect(f.handlers.state).toHaveBeenCalledWith(expect.objectContaining({ ended: true }));
  expect(f.handlers.status).toHaveBeenLastCalledWith('stopped', 'The streamer ended this game.');
  f.client.dispose(); const restored = fixture(); restored.client.transport('live', 'Connected'); restored.client.retry();
  expect(restored.handlers.state).toHaveBeenCalledWith(expect.objectContaining({ ended: true }));
  expect(restored.sendMessage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
