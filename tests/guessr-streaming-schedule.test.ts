import { describe, expect, it } from 'vitest';
import { StreamService } from '../src/guessr/stream-server';
import { defaultStreaming } from '../src/guessr/match-settings';
import { acceptParallelGuess, beginParallel, createParallelRecord, directGuessMessage, joinParallelPlayer,
  nextParallelAlarm, submitParallelHost, tickParallel } from '../src/guessr/parallel-core';
import { streamSnapshot } from '../src/guessr/stream-snapshot';
import { advanceStreamRound } from '../src/guessr/stream-state';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';

const player = { id: '1234', login: 'opponent', name: 'Opponent' };
async function match(rounds: 3 | 5 | 10 = 5, seconds = 30) {
  const service = new StreamService(streamSource(), streamSecret);
  const session = { ...await service.start(streamHost, streamNow, 'parallel', rounds, { streaming: false }), live: true as const };
  const record = createParallelRecord({ owner: streamHost.sub, session, seconds,
    reveals: await service.coordinatorReveals(session.token, streamHost, streamNow) }, streamNow);
  joinParallelPlayer(record, player); beginParallel(record, 'start', streamNow);
  return record;
}
function guess(record: Awaited<ReturnType<typeof match>>, at: number, revision = 1) {
  return directGuessMessage(record, player, { roundId: record.game.session.rounds[record.game.round].id,
    point: streamAnswer, maximum: 5000, nonce: revision.toString(16).padStart(16, '0'), revision }, at)!;
}

describe('streaming setup controls the actual schedule', () => {
  it('defaults SvC on and 1v1 off and seals the chosen value in the session', async () => {
    expect(defaultStreaming('stream')).toBe(true); expect(defaultStreaming('pvp')).toBe(false);
    const service = new StreamService(streamSource(), streamSecret);
    expect((await service.start(streamHost, streamNow, 'parallel', 3)).streaming).toBe(true);
    expect((await service.start(streamHost, streamNow, 'parallel', 3, { mode: 'pvp' })).streaming).toBe(false);
    expect((await service.start(streamHost, streamNow, 'parallel', 3, { mode: 'pvp', streaming: true })).streaming).toBe(true);
  });

  it.each([3, 5, 10] as const)('runs %i shared rounds without a warm-up, leaked early answer or extra final turn', async count => {
    const record = await match(count), game = record.game;
    expect(game.timing!.phase).toBe('play');
    for (let i = 0; i < count; i++) {
      expect(game.round).toBe(i); expect(game.timing!.chatRound).toBe(i);
      const snapshot = streamSnapshot(game, '/images');
      expect(snapshot.streaming).toBe(false); expect(snapshot.round).toBe(i + 1);
      const deadline = game.timing!.deadline!;
      submitParallelHost(record, 'host-' + i, game.session.rounds[i].id, streamAnswer, 5000, game.timing!.startsAt + 1);
      expect(game.stage).toBe('closing'); expect(game.reveals).toHaveLength(i);
      expect(streamSnapshot(game, '/images').phase).toBe('guess');
      expect(acceptParallelGuess(record, guess(record, deadline - 1), deadline + 4000).status).toBe('accepted');
      tickParallel(record, deadline + 4999); expect(game.reveals).toHaveLength(i);
      tickParallel(record, deadline + 5000); expect(game.reveals).toHaveLength(i + 1);
      expect(game.timing!.resultsUntil).toBe(deadline + 35000);
      tickParallel(record, deadline + 35000);
    }
    expect(game.stage).toBe('complete');
    expect(game.participants.every(p => p.guesses.length === count && p.guesses.every(Boolean))).toBe(true);
  });

  it('preserves the shared deadline and waiting host guess after restoration, then shortens only after everyone submitted', async () => {
    let record = await match();
    const start = record.game.timing!.startsAt;
    const deadline = record.game.timing!.deadline!;
    submitParallelHost(record, 'host', record.game.session.rounds[0].id, streamAnswer, 5000, start + 1);
    record = JSON.parse(JSON.stringify(record));
    expect(record.game.session.streaming).toBe(false);
    expect(nextParallelAlarm(record, start + 2)).toBe(deadline + 5000);
    expect(acceptParallelGuess(record, guess(record, start + 1000), start + 1000).status).toBe('accepted');
    expect(record.game.timing!.deadline).toBe(start + 6000);
    expect(nextParallelAlarm(record, start + 1000)).toBe(start + 11000);
    tickParallel(record, start + 10999); expect(record.game.reveals).toHaveLength(0);
    tickParallel(record, start + 11000); expect(record.game.reveals).toHaveLength(1);
  });

  it('closes untimed shared rounds explicitly and accepts their in-flight guesses before revealing', async () => {
    const record = await match(3, 0), game = record.game, at = game.timing!.startsAt + 1000;
    submitParallelHost(record, 'host', game.session.rounds[0].id, streamAnswer, 5000, at);
    expect(game.timing!.windows[0]!.closed).toBe(true);
    expect(acceptParallelGuess(record, guess(record, at + 1000), at + 4000).status).toBe('accepted');
    tickParallel(record, at + 5000); expect(game.stage).toBe('reveal');
    advanceStreamRound(game, at + 6000);
    expect(game.round).toBe(1); expect(game.timing!.chatRound).toBe(1);
    expect(game.timing!.deadline).toBeNull();
  });
});
