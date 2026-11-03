import { afterEach, expect, it, vi } from 'vitest';
import { encodeStreamPacket, StreamPacketReader, guessReceiptKey, StreamBroadcaster, STREAM_RECEIPT_BATCH } from '../src/guessr/stream-wire';
import type { StreamWirePayload } from '../src/guessr/stream-wire';
import { streamArea, streamAnswer } from './helpers/guessr-stream';
import { gameCode } from '../src/guessr/routes';

const id = '11111111-1111-4111-8111-111111111111';
const packet: StreamWirePayload = { type: 'state', state: { schema: 1, channel: 'streamer', hostId: '123', hostPro: 'active', gameId: id,
  revision: 2, phase: 'guess', online: true, paused: false, round: 2, roundId: id, clue: 'abc', expiresAt: 2e12,
  timing: { phase: 'play', startsAt: 10000, deadline: 100000, hostRound: 1, seconds: 90 } } };
const chat = (text: string, login = 'streamer') => ({ text, player: { id: '123', login, name: 'Streamer' }, id: crypto.randomUUID(), sentAt: 10000 });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('round-trips bounded packets only from the requested actual Twitch sender and game', async () => {
  const messages = await encodeStreamPacket(id, packet), reader = new StreamPacketReader('streamer', id);
  expect(messages.every(text => text.length <= 500)).toBe(true);
  expect(messages.every(text => /^[\x20-\x7e]+$/.test(text))).toBe(true);
  expect(messages[0]).toMatch(/^NoitaGuessr [a-z0-9]{26} round-open r2 v2 [a-f0-9]{8} 1\/\d+ /);
  expect(messages[0].split(' ')[1]).toBe(gameCode(id, 'twitch'));
  for (const text of messages) expect(await reader.receive(chat(text, 'copycat'))).toBeNull();
  let received;
  for (const text of [...messages].reverse()) received = await reader.receive(chat(text));
  expect(received?.payload).toEqual(packet);
  const other = new StreamPacketReader('streamer', '22222222-2222-4222-8222-222222222222');
  for (const text of messages) expect(await other.receive(chat(text))).toBeNull();
});

it('strips private fields and reconstructs a released scoring area', async () => {
  const reveal = { roundId: id, answer: streamAnswer, area: { ...streamArea, starts: 'PRIVATE.bin' }, token: 'PRIVATE_TOKEN' };
  const messages = await encodeStreamPacket(id, { type: 'reveal', round: 0, reveal });
  const reader = new StreamPacketReader('streamer'); let result;
  for (const text of messages) result = await reader.receive(chat(text));
  expect(result?.payload).toEqual({ type: 'reveal', round: 0, reveal: { roundId: id, answer: streamAnswer, area: streamArea } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it('packs receipt batches within a small message budget and binds receipts to the sender', async () => {
  const key = await guessReceiptKey(id, '123', '1111111111111111');
  expect(await guessReceiptKey(id, '124', '1111111111111111')).not.toBe(key);
  const keys = await Promise.all(Array.from({ length: STREAM_RECEIPT_BATCH }, (_, i) => guessReceiptKey(id, String(i), crypto.randomUUID())));
  const messages = await encodeStreamPacket(id, { type: 'receipts', round: 0, keys });
  expect(messages).toHaveLength(1);
  const reader = new StreamPacketReader('streamer', id);
  expect((await reader.receive(chat(messages[0])))?.payload).toEqual({ type: 'receipts', round: 0, keys });
});

it('does not apply incomplete fragments and ignores oversized or malformed input', async () => {
  const messages = await encodeStreamPacket(id, { type: 'reveal', round: 0,
    reveal: { roundId: id, answer: streamAnswer, area: { ...streamArea,
      runs: Array.from({ length: 1000 }, (_, i) => [i, i * 7 % 50, i * 7 % 50 + 1] as const) } } });
  expect(messages.length).toBeGreaterThan(1);
  const reader = new StreamPacketReader('streamer', id);
  expect(await reader.receive(chat(messages[0]))).toBeNull();
  expect(await reader.receive(chat('x'.repeat(501)))).toBeNull();
  expect(await reader.receive(chat(messages[1].replace(/\/[0-9a-z]+ /, '/zz ')))).toBeNull();
});

it('coalesces repeated resync requests and bounds throughput independently of audience size', async () => {
  // Compress real packets before fake clocks; native streams use their own tasks.
  const sent: { at: number; text: string }[] = [];
  const broadcaster = new StreamBroadcaster(id, async text => { sent.push({ at: Date.now(), text }); }, error => { throw error; });
  for (let i = 0; i < 100; i++) await broadcaster.offer('state', packet, 0);
  expect(sent.length).toBeLessThanOrEqual(2);
  broadcaster.dispose();
  vi.useFakeTimers(); vi.setSystemTime(1000000);
  const send = vi.fn(async () => {}), failure = vi.fn();
  const capped = new StreamBroadcaster(id, send, failure);
  // Inject already encoded queue entries to test the actual sender scheduler.
  for (let i = 0; i < 24; i++) (capped as any).queue.set(String(i), { frames: ['test'], next: 0, priority: 1 });
  (capped as any).pump(); await vi.advanceTimersByTimeAsync(30000);
  expect(send.mock.calls.length).toBeLessThanOrEqual(14);
  expect(failure).not.toHaveBeenCalled(); capped.dispose();
});

it('preserves the sender budget across a reload instead of allowing another immediate burst', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const send = vi.fn(async () => {}), failure = vi.fn();
  const first = new StreamBroadcaster(id, send, failure, '123');
  for (let i = 0; i < 14; i++) (first as any).queue.set(String(i), { frames: ['test'], next: 0, priority: 1 });
  (first as any).pump(); await vi.advanceTimersByTimeAsync(25_000);
  expect(send).toHaveBeenCalledTimes(14); first.dispose();
  const reloaded = new StreamBroadcaster(id, send, failure, '123');
  (reloaded as any).queue.set('after-refresh', { frames: ['test'], next: 0, priority: 1 });
  (reloaded as any).pump(); await vi.advanceTimersByTimeAsync(5000);
  expect(send).toHaveBeenCalledTimes(14);
  await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(15);
  expect(failure).not.toHaveBeenCalled(); reloaded.dispose();
});

it('finishes an in-flight multipart clue before sending a newer state for the same game', async () => {
  const randomClue = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(600)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const first: StreamWirePayload = { type: 'state', state: { ...(packet as Extract<StreamWirePayload, { type: 'state' }>).state, clue: randomClue, revision: 10 } };
  const second: StreamWirePayload = { type: 'state', state: { ...first.state, revision: 11 } };
  const sent: string[] = [];
  let release!: () => void;
  const firstSend = new Promise<void>(resolve => { release = resolve; });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1_000_000);
  const broadcaster = new StreamBroadcaster(id, async text => { sent.push(text); if (sent.length === 1) await firstSend; }, error => { throw error; });
  await broadcaster.offer('state', first);
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain(' 1/1 ');
  await broadcaster.offer('state', second);
  release(); await vi.advanceTimersByTimeAsync(30000); broadcaster.dispose(); vi.useRealTimers();
  const reader = new StreamPacketReader('streamer', id), delivered = [];
  for (const text of sent) {
    const value = await reader.receive(chat(text.replace(/[\p{C}\p{M}]/gu, '')));
    if (value?.payload.type === 'state') delivered.push(value.payload.state);
  }
  expect(delivered.map(state => state.revision)).toEqual([10, 11]);
  expect(delivered.every(state => state.clue === randomClue)).toBe(true);
});
