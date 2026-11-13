import { describe, expect, it } from 'vitest';
import { StreamService } from '../src/guessr/stream-server';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';
import { acceptParallelGuess, beginParallel, createParallelRecord, directGuessMessage, joinParallelPlayer,
  nextParallelAlarm, parallelResult, submitParallelHost, tickParallel } from '../src/guessr/parallel-core';
import { streamSnapshot } from '../src/guessr/stream-snapshot';
import { STREAM_DELIVERY_GRACE_MS, STREAM_SUBMISSION_GRACE_MS } from '../src/guessr/stream-timing';

async function fixture(rounds: 3 | 5 | 10 = 5) {
  const service = new StreamService(streamSource(), streamSecret);
  const session = { ...await service.start(streamHost, streamNow, 'parallel', rounds), live: true as const };
  return createParallelRecord({ owner: streamHost.sub, session, seconds: 30,
    reveals: await service.coordinatorReveals(session.token, streamHost, streamNow) }, streamNow);
}
const player = (id: number) => ({ id: String(id + 1000), login: 'player' + id, name: 'Player ' + id });
describe('durable dual-path game rules', () => {
  it.each([3, 5, 10] as const)('records 100 players through all %i rounds, deduplicating both paths and protecting latest updates', async count => {
    const record = await fixture(count), game = record.game;
    for (let i = 0; i < 100; i++) joinParallelPlayer(record, player(i));
    beginParallel(record, 'start', streamNow);
    const submitChat = () => {
      const index = game.timing!.chatRound;
      if (index === null) return;
      const at = game.timing!.startsAt + 1000;
      for (let i = 0; i < 100; i++) {
        const old = directGuessMessage(record, player(i), { roundId: game.session.rounds[index].id, point: streamAnswer, maximum: 5000,
          nonce: (i * 2 + 1).toString(16).padStart(16, '0'), revision: 1 }, at)!;
        const replacement = directGuessMessage(record, player(i), { roundId: game.session.rounds[index].id, point: streamAnswer, maximum: 4900,
          nonce: (i * 2 + 2).toString(16).padStart(16, '0'), revision: 2 }, at)!;
        expect(acceptParallelGuess(record, old, at).status).toBe('accepted');
        expect(acceptParallelGuess(record, replacement, at).status).toBe('accepted');
        expect(acceptParallelGuess(record, { ...replacement, id: 'twitch-' + i }, at + 10).status).toBe('duplicate');
        expect(acceptParallelGuess(record, old, at + 20).status).toBe('old');
      }
    };
    submitChat(); tickParallel(record, nextParallelAlarm(record, streamNow)!);
    for (let round = 0; round < count; round++) {
      expect(game.round).toBe(round);
      submitChat();
      submitParallelHost(record, 'host-' + round, game.session.rounds[round].id, streamAnswer, 5000, game.timing!.startsAt + 1500);
      let steps = 0;
      while (game.round === round && game.stage !== 'complete' && steps++ < 5)
        tickParallel(record, nextParallelAlarm(record, game.timing!.startsAt + 1500)!);
      expect(steps).toBeLessThan(5);
    }
    expect(game.stage).toBe('complete');
    const result = parallelResult(record);
    expect(result.players).toHaveLength(101);
    expect(result.rounds).toHaveLength(count);
    expect(result.players.filter(p => p.id !== '100').every(p => p.rounds.length === count && p.rounds.every(r => r[0] + r[1] === 4900))).toBe(true);
    expect(record.metrics.accepted).toBe(200 * count);
    expect(record.metrics.replacements).toBe(100 * count);
  });
  it('accepts last-second deliveries through the fixed grace, never after revealing or by a claimed future time', async () => {
    const record = await fixture(), game = record.game;
    beginParallel(record, 'start', streamNow);
    const deadline = game.timing!.deadline!;
    tickParallel(record, deadline); // Host round 1 and chat round 2 begin together.
    const message = directGuessMessage(record, player(1), { roundId: game.session.rounds[0].id, point: streamAnswer,
      maximum: 5000, nonce: '1111111111111111', revision: 1 }, deadline + STREAM_SUBMISSION_GRACE_MS)!;
    expect(acceptParallelGuess(record, message, deadline + STREAM_DELIVERY_GRACE_MS).status).toBe('accepted');
    const tooLate = { ...message, player: player(2), text: directGuessMessage(record, player(2), {
      roundId: game.session.rounds[0].id, point: streamAnswer, maximum: 5000, nonce: '2222222222222222', revision: 1,
    }, deadline + 2001)!.text, sentAt: deadline + 2001 };
    expect(acceptParallelGuess(record, tooLate, deadline + 4000).status).toBe('closed');
    submitParallelHost(record, 'host', game.session.rounds[0].id, streamAnswer, 5000, game.timing!.startsAt + 1);
    expect(game.reveals).toHaveLength(0);
    tickParallel(record, deadline + 4999); expect(game.reveals).toHaveLength(0);
    tickParallel(record, deadline + 5000); expect(game.reveals).toHaveLength(1);
    expect(acceptParallelGuess(record, message, deadline + 10000).status).toBe('duplicate');
  });
  it('does not expose future answers, host credentials or player positions in the public state', async () => {
    const record = await fixture(); beginParallel(record, 'start', streamNow);
    const publicState = streamSnapshot(record.game, '/images');
    const text = JSON.stringify(publicState);
    expect(publicState.totalRounds).toBe(5);
    expect(record.game.session.token).toBe('');
    expect(text).not.toContain('token');
    expect(text).not.toContain('privateReveals');
    expect(publicState).not.toHaveProperty('participants');
    expect(publicState).not.toHaveProperty('answer');
    expect(JSON.stringify(record.game.session.rounds.slice(1).map(r => r.id))).not.toBe('[]');
    for (const round of record.game.session.rounds.slice(1)) expect(text).not.toContain(round.id);
  });
});
