import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamViewerHistory } from '../src/guessr/stream-viewer-history';
import { StreamPacketReader, encodeStreamPacket, guessReceiptKey } from '../src/guessr/stream-wire';
import { StreamBroadcastHost } from '../src/guessr/stream-broadcast-host';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame, acceptStreamGuess, closeStreamRound, revealStreamRound, advanceStreamRound } from '../src/guessr/stream-state';
import { startStreamTiming, startHostWindow, streamTick } from '../src/guessr/stream-timing';
import { formatGuessCommand } from '../src/guessr/guess-command';
import { streamHost, streamNow, streamSecret, streamSource, streamAnswer } from './helpers/guessr-stream';
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('No network call belongs in round broadcasts or score recovery'); }));
});
afterEach(() => vi.unstubAllGlobals());

it('runs ten rounds with a chatter ahead, reconstructs receipts and scores after refresh, and releases only finished solutions', async () => {
  const service = new StreamService(streamSource(), streamSecret);
  const session = await service.start(streamHost, streamNow, 'twitch', 10); session.live = true; session.serverNow = streamNow;
  const game = newStreamGame(session, streamNow); startStreamTiming(game, 90, streamNow);
  let personal = new StreamViewerHistory(session.config.bounds); personal.identify(session.id, '123');
  const reader = new StreamPacketReader('streamer', session.id);
  const host = new StreamBroadcastHost(game, '/images', async () => {}, () => {}, () => {});
  const deliver = async (payload: Parameters<typeof encodeStreamPacket>[1]) => {
    let decoded;
    for (const text of await encodeStreamPacket(session.id, payload)) decoded = await reader.receive({
      player: { id: streamHost.twitchUserId, login: 'streamer', name: 'Streamer' }, id: crypto.randomUUID(), text, sentAt: streamNow,
    });
    expect(decoded).not.toBeNull();
    const message = decoded!.payload;
    if (message.type === 'reveal') personal.reveal(message.round, message.reveal);
    if (message.type === 'receipts') personal.receipts(message.round, message.keys, message.rejected);
    return message;
  };
  for (let chatRound = 0; chatRound < 10; chatRound++) {
    const window = game.timing!.windows[chatRound]!;
    expect(window.closesAt! - window.opensAt).toBe(90_000);
    const nonce = crypto.getRandomValues(new Uint8Array(8)), nonceHex = Array.from(nonce, b => b.toString(16).padStart(2, '0')).join('');
    const key = await guessReceiptKey(session.rounds[chatRound].id, '123', nonceHex);
    personal.submit(chatRound, key, streamAnswer, 5000);
    expect(acceptStreamGuess(game, { player: { id: '123', login: 'chatter', name: 'Chatter' }, id: crypto.randomUUID(),
      text: formatGuessCommand(chatRound + 1, streamAnswer, 5000, session.rounds[chatRound].id, { userId: '123', nonce }),
      sentAt: window.opensAt + 1000 }, window.opensAt + 1100)).toBe('accepted');
    expect(game.reveals[chatRound]).toBeUndefined();
    const state = await deliver({ type: 'state', state: host.snapshot() });
    expect(JSON.stringify(state)).not.toContain('token');
    expect(JSON.stringify(state)).not.toContain('Private place');
    await deliver({ type: 'receipts', round: chatRound, keys: [key] });
    expect(personal.round(chatRound).received?.point).toEqual(streamAnswer);
    personal = new StreamViewerHistory(session.config.bounds); personal.identify(session.id, '123');
    expect(personal.round(chatRound).received?.point).toEqual(streamAnswer);
    const end = game.timing!.deadline!;
    streamTick(game, end);
    if (chatRound === 0) startHostWindow(game, end);
    else {
      closeStreamRound(game, streamAnswer, end);
      const reveal = await service.reveal(session.rounds[game.round].token, streamHost, end);
      revealStreamRound(game, reveal); await deliver({ type: 'reveal', round: game.round, reveal });
      expect(personal.round(game.round).score?.score).toBe(5000);
      advanceStreamRound(game, end);
    }
  }
  expect(game.round).toBe(9); expect(game.timing!.chatRound).toBeNull();
  closeStreamRound(game, streamAnswer, game.timing!.startsAt + 1000);
  const last = await service.reveal(session.rounds[9].token, streamHost, game.timing!.startsAt + 1000);
  revealStreamRound(game, last); await deliver({ type: 'reveal', round: 9, reveal: last });
  advanceStreamRound(game, game.timing!.startsAt + 1000);
  personal = new StreamViewerHistory(session.config.bounds); personal.identify(session.id, '123');
  expect(personal.total()).toBe(50_000);
  expect(personal.recovery(1023)).toEqual({ missing: 0, receipts: [] });
  const lateJoin = new StreamViewerHistory(session.config.bounds); lateJoin.identify(session.id, '999');
  expect(lateJoin.total()).toBe(0);
  expect(fetch).not.toHaveBeenCalled(); host.dispose();
});

it('keeps an unconfirmed submission explicit across reloads and resolves a negative receipt without inventing a score', async () => {
  const service = new StreamService(streamSource(), streamSecret), session = await service.start(streamHost, streamNow, 'twitch', 10);
  let personal = new StreamViewerHistory(session.config.bounds); personal.identify(session.id, '123');
  personal.submit(0, '0123456789abcdef', streamAnswer, 5000);
  personal = new StreamViewerHistory(session.config.bounds); personal.identify(session.id, '123');
  expect(personal.round(0).pending).toBe(true); expect(personal.round(0).received).toBeUndefined();
  expect(personal.recovery(1)).toEqual({ missing: 1, receipts: [{ round: 0, key: '0123456789abcdef' }] });
  personal.reveal(0, await service.reveal(session.rounds[0].token, streamHost, streamNow + 1));
  expect(personal.round(0).pending).toBe(true);
  const reader = new StreamPacketReader('streamer', session.id);
  for (const text of await encodeStreamPacket(session.id, { type: 'receipts', round: 0, keys: ['0123456789abcdef'], rejected: true, reason: 'closed' })) {
    const packet = await reader.receive({ player: { id: streamHost.twitchUserId, login: 'streamer', name: 'Streamer' }, id: 'rejected', text, sentAt: streamNow });
    if (packet?.payload.type === 'receipts') personal.receipts(packet.payload.round, packet.payload.keys, true, packet.payload.reason);
  }
  expect(personal.round(0)).toMatchObject({ pending: false, lastStatus: 'rejected', reason: 'closed', score: { score: 0 } });
  personal.identify(session.id, '124'); expect(personal.round(0).submitted).toBe(false);
});

it('keeps the last confirmed guess until its replacement arrives and preserves the same score after F5', async () => {
  const service = new StreamService(streamSource(), streamSecret), session = await service.start(streamHost, streamNow, 'twitch', 10);
  session.live = true;
  const game = newStreamGame(session, streamNow); startStreamTiming(game, 90, streamNow);
  let own = new StreamViewerHistory(session.config.bounds); own.identify(session.id, '123');
  const point = { x: streamAnswer.x + 10, y: streamAnswer.y + 20 };
  const submit = async (index: number, target = point, deliver = true) => {
    const nonce = new Uint8Array(8).fill(index), hex = Array.from(nonce, v => v.toString(16).padStart(2, '0')).join('');
    const key = await guessReceiptKey(session.rounds[0].id, '123', hex);
    own.submit(0, key, target, 5000);
    if (deliver) {
      const text = formatGuessCommand(1, target, 5000, session.rounds[0].id, { userId: '123', nonce, label: 'Chatter submitted a guess.' });
      expect(text).not.toMatch(/[ᚠ-ᛊ]/u); expect(text.length).toBeLessThanOrEqual(500);
      const message = { id: String(index), player: { id: '123', login: 'chatter', name: 'Chatter' }, text, sentAt: streamNow + 4000 + index };
      expect(acceptStreamGuess(game, { ...message, player: { ...message.player, id: '999' } }, message.sentAt)).toBe('invalid');
      expect(acceptStreamGuess(game, message, message.sentAt)).toBe('accepted');
    }
    return key;
  };
  const first = await submit(1); own.receipts(0, [first]);
  const lost = await submit(2, streamAnswer, false);
  expect(own.round(0)).toMatchObject({ pending: true, received: { point } });
  const replacement = await submit(3, streamAnswer); own.receipts(0, [replacement]);
  own.receipts(0, [first]); own.receipts(0, [lost], true);
  // A stale "not received" response can arrive after the acceptance batch.
  own.receipts(0, [replacement], true, 'unreceived');
  const reveal = await service.reveal(session.rounds[0].token, streamHost, streamNow + 100000); own.reveal(0, reveal);
  expect(game.participants[1].guesses[0]!.point).toEqual(streamAnswer);
  expect(own.round(0)).toMatchObject({ pending: false, received: { point: streamAnswer }, score: { score: 5000 } });
  own = new StreamViewerHistory(session.config.bounds); own.identify(session.id, '123');
  expect(own.round(0).score!.score).toBe(5000); expect(fetch).not.toHaveBeenCalled();
});
