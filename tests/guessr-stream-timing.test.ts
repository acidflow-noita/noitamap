import { describe, expect, it } from 'vitest';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame, acceptStreamGuess, closeStreamRound, revealStreamRound, advanceStreamRound } from '../src/guessr/stream-state';
import { startStreamTiming, startHostWindow, streamTick, hostMayGuess, suspendStreamTiming, resumeStreamTiming } from '../src/guessr/stream-timing';
import { formatGuessCommand } from '../src/guessr/guess-command';
import { streamAnswer, streamHost, streamNow, streamSecret, streamSource } from './helpers/guessr-stream';

async function fixture(seconds = 90) {
  const service = new StreamService(streamSource(), streamSecret);
  const session = await service.start(streamHost, streamNow, 'twitch'); session.live = true; session.serverNow = streamNow;
  const game = newStreamGame(session, streamNow); startStreamTiming(game, seconds, streamNow);
  const guess = (round: number, sentAt: number, receivedAt = sentAt) => acceptStreamGuess(game, {
    player: { id: '123', login: 'chatter', name: 'Chatter' }, id: crypto.randomUUID(), sentAt,
    text: formatGuessCommand(round + 1, streamAnswer, 4900, session.rounds[round].id, { userId: '123' }),
  }, receivedAt);
  return { game, service, session, guess };
}

describe('chat first, timed streamer rounds', () => {
  it('opens chat round one after a silent countdown, then starts chat two and streamer one together', async () => {
    const f = await fixture(), t = f.game.timing!;
    expect(hostMayGuess(f.game, streamNow + 10_000)).toBe(false);
    expect(f.guess(0, streamNow + 2999)).toBe('closed');
    expect(f.guess(0, streamNow + 3000)).toBe('accepted');
    expect(f.guess(1, streamNow + 5000)).toBe('future');
    expect(streamTick(f.game, streamNow + 92_999)).toBeNull();
    expect(streamTick(f.game, streamNow + 93_000)).toBe('warmup-finished');
    startHostWindow(f.game, streamNow + 93_000);
    expect(t.chatRound).toBe(1);
    expect(t.windows[1]!.opensAt).toBe(t.startsAt);
    expect(hostMayGuess(f.game, t.startsAt - 1)).toBe(false);
    expect(hostMayGuess(f.game, t.startsAt)).toBe(true);
    expect(f.guess(1, t.startsAt)).toBe('accepted');
    expect(f.guess(0, streamNow + 93_001)).toBe('closed');
  });

  it('accepts small delivery delays by Twitch send time, but rejects guesses sent after closure', async () => {
    const f = await fixture(), deadline = f.game.timing!.deadline!;
    streamTick(f.game, deadline); startHostWindow(f.game, deadline);
    expect(f.guess(0, deadline - 1, deadline + 2000)).toBe('accepted');
    expect(f.guess(0, deadline + 1, deadline + 2000)).toBe('closed');
    expect(f.guess(0, deadline - 1, deadline + 6000)).toBe('closed');
  });

  it('keeps the chatter window open after an early timed host submission and preserves the chatter’s own allowance', async () => {
    const f = await fixture(); startHostWindow(f.game, streamNow + 93_000);
    const open = f.game.timing!.startsAt;
    f.game.clue.travelSpent = 4000;
    closeStreamRound(f.game, streamAnswer, open + 1000);
    revealStreamRound(f.game, await f.service.reveal(f.session.rounds[0].token, streamHost, open + 1001), open + 1001);
    expect(f.guess(1, open + 2000)).toBe('accepted');
    expect(f.game.participants[1].guesses[1]!.maximum).toBe(4900);
    expect(streamTick(f.game, open + 2000)).toBeNull();
    expect(streamTick(f.game, f.game.timing!.deadline!)).toBe('advance');
  });

  it('supports explicit manual closure without a deadline', async () => {
    const f = await fixture(0);
    expect(streamTick(f.game, streamNow + 500_000)).toBeNull();
    startHostWindow(f.game, streamNow + 500_000);
    const open = f.game.timing!.startsAt;
    expect(f.guess(1, open)).toBe('accepted');
    closeStreamRound(f.game, streamAnswer, open + 1000);
    expect(f.game.timing!.windows[1]!.closed).toBe(true);
    expect(f.guess(1, open + 1001)).toBe('closed');
  });

  it('preserves the current phase through refresh and extends only unfinished windows during recovery', async () => {
    const f = await fixture(); startHostWindow(f.game, streamNow + 93_000);
    const start = f.game.timing!.startsAt, oldDeadline = f.game.timing!.deadline!;
    suspendStreamTiming(f.game, start + 10_000);
    expect(f.guess(1, start + 10_001)).toBe('closed');
    const restored = JSON.parse(JSON.stringify(f.game));
    resumeStreamTiming(restored, start + 40_000);
    expect(restored.timing.startsAt).toBe(start);
    expect(restored.timing.deadline).toBe(oldDeadline + 30_000);
    expect(restored.timing.windows[0].closesAt).toBe(streamNow + 93_000);
    expect(hostMayGuess(restored, start + 40_000)).toBe(true);
  });

  it('finishes all ten host rounds without creating an eleventh chatter round', async () => {
    const f = await fixture(); startHostWindow(f.game, streamNow + 93_000);
    for (let i = 0; i < 10; i++) {
      expect(f.game.round).toBe(i);
      expect(f.game.timing!.chatRound).toBe(i < 9 ? i + 1 : null);
      const end = f.game.timing!.deadline!;
      expect(streamTick(f.game, end)).toBe('submit');
      closeStreamRound(f.game, i === 3 ? null : streamAnswer, end);
      // Even a slow reveal response must leave time to inspect the round results.
      revealStreamRound(f.game, await f.service.reveal(f.session.rounds[i].token, streamHost, end + 10000), end + 10000);
      expect(streamTick(f.game, end + 17999)).toBeNull();
      expect(streamTick(f.game, end + 18000)).toBe(i < 9 ? 'advance' : 'finish');
      advanceStreamRound(f.game, end + 18000);
    }
    expect(f.game.stage).toBe('complete');
    expect(f.game.timing!.windows.filter(Boolean)).toHaveLength(10);
    expect(f.game.participants[0].guesses[3]!.point).toBeNull();
  });
});
