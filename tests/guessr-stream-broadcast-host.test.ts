import { afterEach, expect, it, vi } from 'vitest';
import { StreamBroadcastHost } from '../src/guessr/stream-broadcast-host';
import { StreamBroadcaster, StreamPacketReader, guessReceiptKey } from '../src/guessr/stream-wire';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame } from '../src/guessr/stream-state';
import { startStreamTiming } from '../src/guessr/stream-timing';
import { gameCode } from '../src/guessr/routes';
import { streamNow, streamSecret, streamHost, streamSource } from './helpers/guessr-stream';
const hosts: StreamBroadcastHost[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.dispose()); vi.useRealTimers(); });

async function fixture() {
  const session = await new StreamService(streamSource(), streamSecret).start(streamHost, streamNow, 'twitch');
  const game = newStreamGame(session, streamNow); startStreamTiming(game, 90, streamNow);
  const sent: { text: string; at: number }[] = [], save = vi.fn(), failure = vi.fn();
  const host = new StreamBroadcastHost(game, '/images', async text => { sent.push({ text, at: Date.now() }); }, failure, save);
  hosts.push(host); return { game, host, sent, save, failure };
}

it.each([false, true])('broadcasts a newer closed state when leaving the host page (quit: %s)', async quit => {
  const f = await fixture(), revision = f.game.timing!.revision;
  await f.host.close(quit);
  expect(f.game.timing!.revision).toBeGreaterThan(revision);
  const reader = new StreamPacketReader('streamer', f.game.session.id);
  let received;
  for (const item of f.sent) received = await reader.receive({ player: { id: '100', login: 'streamer', name: 'Streamer' },
    id: crypto.randomUUID(), text: item.text, sentAt: item.at });
  expect(received?.payload).toMatchObject({ type: 'state', state: { online: false, paused: true, clue: null,
    revision: f.game.timing!.revision, ...(quit ? { phase: 'waiting' } : {}) } });
  expect(f.save).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
});

it('coalesces a thousand simultaneous joins into one snapshot instead of a response per viewer', async () => {
  const f = await fixture();
  for (let i = 0; i < 1000; i++) f.host.receiveRequest({ player: { id: String(i), login: 'user_' + i, name: 'User' },
    id: String(i), text: `!noitaguessr_sync streamer ${gameCode(f.game.session.id)} 0`, sentAt: streamNow });
  await vi.waitFor(() => expect(f.sent.length).toBeGreaterThan(0));
  expect(new Set(f.sent.map(m => m.text.split(' ')[2])).size).toBe(1);
  expect(f.sent.length).toBeLessThanOrEqual(2);
  expect(f.save).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
});

it('delivers a thousand receipt confirmations within a round while respecting the sender limit', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 1000 }, (_, i) => f.host.remember(0, String(i), i.toString(16).padStart(16, '0'))));
  const publisher = (f.host as unknown as { publisher: StreamBroadcaster }).publisher;
  const offer = publisher.offer.bind(publisher), preparations: Promise<void>[] = [];
  vi.spyOn(publisher, 'offer').mockImplementation((...args) => {
    const ready = offer(...args); preparations.push(ready); return ready;
  });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(streamNow); await f.host.start();
  await Promise.all(preparations.splice(0));
  for (let i = 0; i < 90; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    // Real compression is asynchronous native IO, not simulated seconds.
    await Promise.all(preparations.splice(0));
  }
  f.host.dispose(); vi.useRealTimers();
  const reader = new StreamPacketReader('streamer', f.game.session.id), received = new Set<string>();
  for (const item of f.sent) {
    const packet = await reader.receive({ player: { id: '100', login: 'streamer', name: 'Streamer' }, id: crypto.randomUUID(), text: item.text, sentAt: item.at });
    if (packet?.payload.type === 'receipts') packet.payload.keys.forEach(key => received.add(key));
  }
  expect(received.size).toBe(1000);
  expect(received.has(await guessReceiptKey(f.game.session.rounds[0].id, '999', '00000000000003e7'))).toBe(true);
  for (const item of f.sent) expect(f.sent.filter(other => other.at > item.at - 30_000 && other.at <= item.at).length).toBeLessThanOrEqual(14);
  expect(f.sent.every(item => item.text.length <= 500)).toBe(true);
  expect(f.failure).not.toHaveBeenCalled();
});
