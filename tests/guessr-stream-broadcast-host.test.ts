import { afterEach, expect, it, vi } from 'vitest';
import { StreamBroadcastHost } from '../src/guessr/stream-broadcast-host';
import { StreamBroadcaster, StreamPacketReader, guessReceiptKey, streamPacketText, STREAM_RECEIPT_BATCH } from '../src/guessr/stream-wire';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame } from '../src/guessr/stream-state';
import { startStreamTiming, startHostWindow, closeChatWindow } from '../src/guessr/stream-timing';
import { gameCode } from '../src/guessr/routes';
import { streamNow, streamSecret, streamHost, streamSource, streamArea, streamAnswer } from './helpers/guessr-stream';
const hosts: StreamBroadcastHost[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.dispose()); vi.useRealTimers(); });

async function fixture() {
  const session = await new StreamService(streamSource(), streamSecret).start(streamHost, streamNow, 'twitch');
  const game = newStreamGame(session, streamNow); startStreamTiming(game, 90, streamNow);
  const sent: { text: string; at: number }[] = [], save = vi.fn(), failure = vi.fn(), joined = vi.fn();
  const send = vi.fn(async (text: string) => { sent.push({ text, at: Date.now() }); });
  const host = new StreamBroadcastHost(game, '/images', send, failure, save, joined);
  hosts.push(host); return { game, host, sent, save, failure, joined, send };
}

function clock(f: Awaited<ReturnType<typeof fixture>>) {
  const publisher = (f.host as unknown as { publisher: StreamBroadcaster }).publisher;
  const offer = publisher.offer.bind(publisher), preparations: Promise<void>[] = [];
  vi.spyOn(publisher, 'offer').mockImplementation((...args) => {
    const job = offer(...args); preparations.push(job); return job;
  });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(streamNow);
  const ready = async () => { while (preparations.length) await Promise.all(preparations.splice(0)); };
  return { ready, advance: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await ready(); } };
}

it('does not reject a received guess while its receipt is still being hashed', async () => {
  const f = await fixture(), timer = clock(f);
  await f.host.start(); await timer.ready(); await timer.advance(10_000);
  f.game.timing!.windows[0] = { opensAt: streamNow, closesAt: streamNow + 4000, closed: true };
  const nonce = '0123456789abcdef', key = await guessReceiptKey(f.game.session.rounds[0].id, '123', nonce);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((algorithm, data) => new Promise(resolve => {
    release = () => { void digest(algorithm, data).then(resolve); };
  }));
  try {
    const recording = f.host.remember(0, '123', nonce);
    f.host.receiveRequest({ player: { id: '123', login: 'chatter', name: 'Chatter' }, id: 'check', sentAt: Date.now(),
      text: `!noitaguessr_recover streamer ${gameCode(f.game.session.id, 'twitch')} 0 0:${key}` });
    await timer.advance(2000);
    expect(f.sent.some(message => message.text.includes('guess-rejected'))).toBe(false);
    release(); await recording;
    await f.host.reject(0, '123', nonce, 'unreceived');
    await timer.advance(6000);
    expect(f.sent.some(message => message.text.includes('guess-received r1'))).toBe(true);
    expect(f.sent.some(message => message.text.includes('guess-rejected'))).toBe(false);
  } finally { spy.mockRestore(); }
});

it('drains a final-round receipt even when its hash finishes after game completion starts', async () => {
  const f = await fixture(), timer = clock(f);
  await f.host.start(); await timer.ready(); await timer.advance(4000);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((algorithm, data) => new Promise(resolve => {
    release = () => { void digest(algorithm, data).then(resolve); };
  }));
  try {
    const recording = f.host.remember(9, '123', '0123456789abcdef');
    f.game.stage = 'complete';
    const completion = f.host.complete();
    release(); await recording;
    for (let i = 0; i < 10; i++) await timer.advance(2000);
    await completion;
    expect(f.sent.some(message => message.text.includes('guess-received r10'))).toBe(true);
    expect(f.failure).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

it('answers a thousand receipt checks without resending clues or delaying a new round update', async () => {
  const f = await fixture(), timer = clock(f);
  const keys = await Promise.all(Array.from({ length: 1000 }, async (_, i) => {
    const user = String(i + 1000), nonce = i.toString(16).padStart(16, '0');
    await f.host.remember(0, user, nonce, false);
    return guessReceiptKey(f.game.session.rounds[0].id, user, nonce);
  }));
  await f.host.start(); await timer.ready(); await timer.advance(4000);
  expect(f.host.snapshot().timing?.recovery).toBe(1);
  for (let i = 0; i < 1000; i++) f.host.receiveRequest({ player: { id: String(i + 1000), login: 'chatter', name: 'Chatter' },
    id: String(i), sentAt: Date.now(), text: `!noitaguessr_recover streamer ${gameCode(f.game.session.id, 'twitch')} 0 0:${keys[i]}` });
  for (let i = 0; i < 100; i++) {
    if (i === 16) { f.game.timing!.revision++; f.host.publishState(false); await timer.ready(); }
    await timer.advance(1000);
  }
  const reader = new StreamPacketReader('streamer', f.game.session.id), received = new Set<string>();
  for (const item of f.sent) {
    const packet = await reader.receive({ player: { id: '100', login: 'streamer', name: 'Streamer' }, id: crypto.randomUUID(), text: item.text, sentAt: item.at }, item.at);
    if (packet?.payload.type === 'receipts') packet.payload.keys.forEach(key => received.add(key));
  }
  expect(received).toEqual(new Set(keys));
  expect(f.sent.filter(item => item.text.includes(' state-sync '))).toHaveLength(0);
  expect(f.sent.filter(item => item.text.includes(' guess-received '))).toHaveLength(Math.ceil(1000 / STREAM_RECEIPT_BATCH));
  const transition = f.sent.find(item => item.text.includes(' state-update '));
  expect(transition).toBeDefined(); expect(transition!.at).toBeLessThanOrEqual(streamNow + 25000);
  for (const item of f.sent) expect(f.sent.filter(other => other.at > item.at - 30000 && other.at <= item.at).length).toBeLessThanOrEqual(14);
  expect(f.failure).not.toHaveBeenCalled();
});

it('recovers a released result without replaying the clue or exposing an unreleased result', async () => {
  const f = await fixture(), timer = clock(f);
  f.game.reveals[0] = { roundId: f.game.session.rounds[0].id, answer: streamAnswer, area: streamArea };
  f.game.participants.push({ id: '123', login: 'chatter', name: 'Chatter', guesses: [
    { point: streamAnswer, maximum: 5000, messageId: 'guess', sentAt: streamNow },
  ] });
  await f.host.start(); await timer.ready(); await timer.advance(4000);
  f.host.receiveRequest({ player: { id: '123', login: 'chatter', name: 'Chatter' }, id: 'recover', sentAt: Date.now(),
    text: `!noitaguessr_recover streamer ${gameCode(f.game.session.id, 'twitch')} 3` });
  await timer.ready(); await timer.advance(10000);
  expect(f.sent.filter(item => item.text.includes(' state-sync '))).toHaveLength(0);
  expect(f.sent.filter(item => item.text.includes(' round-solution r1 '))).toHaveLength(1);
  expect(f.sent.filter(item => item.text.includes(' round-solution r2 '))).toHaveLength(0);
  expect(f.failure).not.toHaveBeenCalled();
});

it('still delivers a complete shared snapshot to a viewer joining halfway through a multipart clue', async () => {
  const f = await fixture(), timer = clock(f);
  f.game.session.rounds[0].clue = { frames: Array.from({ length: 12 }, (_, i) => ({
    image: '/images/' + crypto.randomUUID().replaceAll('-', '') + '.webp', x: -1024 + i % 4 * 512, y: -512 + Math.floor(i / 4) * 384, width: 512, height: 384,
  })) };
  await f.host.start(); await timer.ready();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].text).toMatch(/ 1\/[2-9] /);
  await timer.advance(500);
  const joinedAt = Date.now();
  f.host.receiveRequest({ player: { id: '123', login: 'chatter', name: 'Chatter' }, id: 'join', sentAt: joinedAt,
    text: `!noitaguessr_sync streamer ${gameCode(f.game.session.id, 'twitch')} 0` });
  for (let i = 0; i < 12; i++) await timer.advance(1000);
  const reader = new StreamPacketReader('streamer', f.game.session.id), delivered = [];
  for (const item of f.sent.filter(item => item.at > joinedAt)) {
    const packet = await reader.receive({ player: { id: '100', login: 'streamer', name: 'Streamer' }, id: crypto.randomUUID(), text: item.text, sentAt: item.at }, item.at);
    if (packet) delivered.push(packet);
  }
  expect(delivered).toHaveLength(1);
  expect(delivered[0].payload).toMatchObject({ type: 'state', state: { round: 1, online: true, timing: { recovery: 1 } } });
  expect(delivered[0].sentAt - joinedAt).toBeLessThanOrEqual(10000);
  expect(f.failure).not.toHaveBeenCalled();
});

it.each([false, true])('broadcasts a newer closed state when leaving the host page (quit: %s)', async quit => {
  const f = await fixture(), revision = f.game.timing!.revision;
  await f.host.close(quit);
  expect(f.game.timing!.revision).toBeGreaterThan(revision);
  const reader = new StreamPacketReader('streamer', f.game.session.id);
  let received;
  for (const item of f.sent) received = await reader.receive({ player: { id: '100', login: 'streamer', name: 'Streamer' },
    id: crypto.randomUUID(), text: item.text, sentAt: item.at });
  expect(received?.payload).toMatchObject({ type: 'state', state: { online: false, paused: true, clue: null,
    revision: f.game.timing!.revision, ...(quit ? { phase: 'waiting', ended: true } : {}) } });
  if (quit) expect(f.sent[0].text).toContain(' game-ended ');
  expect(f.save).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
});

it('reports an unconfirmed end event and permits an explicit retry without silently ending locally', async () => {
  const f = await fixture(); f.send.mockRejectedValueOnce(Error('Offline'));
  await expect(f.host.close(true)).rejects.toThrow('Twitch could not send the game update.');
  expect(f.sent).toHaveLength(0);
  await f.host.close(true);
  expect(f.sent).toHaveLength(1); expect(f.sent[0].text).toContain(' game-ended ');
  expect(f.send).toHaveBeenCalledTimes(2);
});

it('sends no idle heartbeats and permanently stops after draining the final state and receipts', async () => {
  const f = await fixture();
  const publisher = (f.host as unknown as { publisher: StreamBroadcaster }).publisher;
  const original = publisher.offer.bind(publisher), preparations: Promise<void>[] = [];
  vi.spyOn(publisher, 'offer').mockImplementation((...args) => { const job = original(...args); preparations.push(job); return job; });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(streamNow); await f.host.start(); await Promise.all(preparations.splice(0));
  await vi.advanceTimersByTimeAsync(5000);
  const initial = f.sent.length;
  await vi.advanceTimersByTimeAsync(300000); await Promise.all(preparations.splice(0));
  expect(f.sent.length).toBe(initial);
  await f.host.remember(9, '123', '0123456789abcdef');
  f.game.stage = 'complete'; f.game.published = true;
  const completion = f.host.complete();
  for (let i = 0; i < 20; i++) { await Promise.all(preparations.splice(0)); await vi.advanceTimersByTimeAsync(1000); }
  await completion;
  const finished = f.sent.length;
  f.host.receiveRequest({ player: { id: '123', login: 'chatter', name: 'Chatter' }, id: 'late',
    text: `!noitaguessr_sync streamer ${gameCode(f.game.session.id)} 0`, sentAt: Date.now() });
  await vi.advanceTimersByTimeAsync(3600000); await Promise.all(preparations.splice(0));
  expect(f.sent.length).toBe(finished);
  const reader = new StreamPacketReader('streamer', f.game.session.id), delivered = [];
  for (const item of f.sent) {
    const value = await reader.receive({ player: { id: '100', login: 'streamer', name: 'Streamer' }, id: crypto.randomUUID(), text: item.text, sentAt: item.at });
    if (value) delivered.push(value.payload);
  }
  expect(delivered).toContainEqual(expect.objectContaining({ type: 'state', state: expect.objectContaining({ phase: 'complete', resultId: f.game.session.id }) }));
  expect(delivered).toContainEqual(expect.objectContaining({ type: 'receipts', round: 9 }));
  expect(f.failure).not.toHaveBeenCalled();
});

it('coalesces a thousand simultaneous joins into one snapshot instead of a response per viewer', async () => {
  const f = await fixture();
  for (let i = 0; i < 1000; i++) f.host.receiveRequest({ player: { id: String(i), login: 'user_' + i, name: 'User' },
    id: String(i), text: `!noitaguessr_sync streamer ${gameCode(f.game.session.id)} 0`, sentAt: streamNow });
  await vi.waitFor(() => expect(f.sent.length).toBeGreaterThan(0));
  expect(new Set(f.sent.map(m => streamPacketText(m.text).split(' ')[2])).size).toBe(1);
  expect(f.sent.length).toBeLessThanOrEqual(2);
  expect(f.save).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
});

it('counts unique chatter joins using existing sync messages, without counting host or retries', async () => {
  const f = await fixture();
  const join = (id: string) => f.host.receiveRequest({ player: { id, login: 'chatter', name: 'Chatter' },
    id: crypto.randomUUID(), text: `NoitaGuessr ${gameCode(f.game.session.id, 'twitch')} player-join streamer need=0`, sentAt: streamNow });
  join('123'); join('123'); join('124'); join(f.game.session.host.id);
  expect(Object.keys(f.game.joinedPlayers!)).toEqual(['123', '124']);
  expect(f.joined).toHaveBeenCalledTimes(2); expect(f.save).not.toHaveBeenCalled();
  f.host.dispose();
});

it('delivers a burst of a thousand confirmations without exceeding the Twitch message budget', async () => {
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
  for (let i = 0; i < 100; i++) {
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


it('keeps chat round ten closed during the streamer’s final countdown and final result hold', async () => {
  const f = await fixture(), timing = f.game.timing!;
  f.game.round = 8; startHostWindow(f.game, streamNow + 100000);
  const opened = timing.windows[9]!.opensAt, closed = timing.windows[9]!.closesAt!;
  closeChatWindow(f.game, closed);
  f.game.round = 9; startHostWindow(f.game, closed + 15000);
  const state = f.host.snapshot();
  expect(state.round).toBe(10); expect(state.phase).toBe('reveal');
  expect(state.timing).toMatchObject({ chatRound: null, hostRound: 10, startsAt: opened, deadline: null });
  expect(state.timing!.startsAt).not.toBe(timing.startsAt);
  f.game.stage = 'reveal'; timing.resultsUntil = timing.startsAt + 105000;
  expect(f.host.snapshot().phase).toBe('reveal');
});
