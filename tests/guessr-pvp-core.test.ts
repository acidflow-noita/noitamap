import { expect, it } from 'vitest';
import { StreamService } from '../src/guessr/stream-server';
import { createParallelRecord, joinParallelPlayer, beginParallel, acceptParallelGuess, directGuessMessage,
  nextParallelAlarm, tickParallel, parallelResult } from '../src/guessr/parallel-core';
import { pvpSnapshot } from '../src/guessr/pvp-state';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';

const opponent = { id: '1234', login: 'opponent', name: 'Opponent', color: '#ff4500' };
async function fixture(rounds: 3 | 5 | 10 = 5, streaming = false) {
  const service = new StreamService(streamSource(), streamSecret);
  const session = { ...await service.start(streamHost, streamNow, 'parallel', rounds, { mode: 'pvp', streaming }), live: true as const };
  const record = createParallelRecord({ owner: streamHost.sub, session, seconds: 30,
    reveals: await service.coordinatorReveals(session.token, streamHost, streamNow) }, streamNow);
  joinParallelPlayer(record, opponent);
  record.game.pvp!.ready.push(opponent.id);
  return record;
}
function submit(record: Awaited<ReturnType<typeof fixture>>, id: string, round: number, now: number, nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16)) {
  const player = record.game.participants.find(p => p.id === id)!;
  const message = directGuessMessage(record, player, { roundId: record.game.session.rounds[round].id,
    point: streamAnswer, maximum: 4900, revision: 1, nonce }, now)!;
  return { message, response: acceptParallelGuess(record, message, now) };
}

it('requires the selected opponent to be ready and keeps the roster at two', async () => {
  const record = await fixture();
  expect(() => joinParallelPlayer(record, { ...opponent, id: '999' })).toThrow();
  expect(() => beginParallel(record, 'start', streamNow, '999')).toThrow();
  record.game.pvp!.ready = [];
  expect(() => beginParallel(record, 'start', streamNow, opponent.id)).toThrow();
  record.game.pvp!.ready = [opponent.id];
  beginParallel(record, 'start', streamNow, opponent.id);
  expect(record.game.timing!.phase).toBe('play');
});

it.each([3, 5, 10] as const)('plays %i simultaneous rounds with final locks and early completion', async count => {
  let record = await fixture(count);
  let previousHostNonce: string | undefined;
  beginParallel(record, 'start', streamNow, opponent.id);
  for (let i = 0; i < count; i++) {
    const game = record.game, now = game.timing!.startsAt + 1;
    if (previousHostNonce) expect(submit(record, streamHost.twitchUserId, i, now, previousHostNonce).response.status).toBe('invalid');
    expect(game.round).toBe(i); expect(game.timing!.chatRound).toBe(i);
    const first = submit(record, opponent.id, i, now);
    expect(first.response.status).toBe('accepted');
    expect(submit(record, opponent.id, i, now + 1).response.status).toBe('closed');
    expect(acceptParallelGuess(record, first.message, now + 2).status).toBe('duplicate');
    const hostView = pvpSnapshot(game, streamHost.twitchUserId, '/images');
    expect(hostView.pvp!.opponentLocked).toBe(true);
    const raw = JSON.stringify(hostView);
    expect(raw).not.toContain('maximum'); expect(raw).not.toContain('privateReveals'); expect(raw).not.toContain('guesses');
    for (const round of game.session.rounds.slice(i + 1)) expect(raw).not.toContain(round.id);
    const host = submit(record, streamHost.twitchUserId, i, now + 3);
    expect(host.response.status).toBe('accepted'); previousHostNonce = host.response.command!.nonce;
    tickParallel(record, now + 3);
    expect(game.stage).toBe('reveal'); expect(game.reveals).toHaveLength(i + 1);
    expect(game.timing!.deadline).toBe(now + 3);
    record = JSON.parse(JSON.stringify(record));
    tickParallel(record, nextParallelAlarm(record, now + 3)!);
  }
  expect(record.game.stage).toBe('complete');
  const result = parallelResult(record); expect(result.mode).toBe('pvp');
  expect(result.players).toHaveLength(2); expect(result.players.every(p => p.score === 4900 * count)).toBe(true);
});

it.each([3, 5, 10] as const)('stages %i streamed rounds without exposing future clues or interrupting the opponent', async count => {
  const record = await fixture(count, true), game = record.game;
  beginParallel(record, 'start', streamNow, opponent.id);
  expect(pvpSnapshot(game, streamHost.twitchUserId, '/images').clue).toBeNull();
  expect(submit(record, streamHost.twitchUserId, 0, game.timing!.startsAt + 1).response.status).toBe('closed');
  let now = game.timing!.startsAt + 2;
  expect(submit(record, opponent.id, 0, now).response.status).toBe('accepted'); tickParallel(record, now);
  for (let i = 0; i < count; i++) {
    now = game.timing!.startsAt + 1;
    expect(game.round).toBe(i); expect(game.timing!.chatRound).toBe(i + 1 < count ? i + 1 : null);
    expect(submit(record, streamHost.twitchUserId, i, now).response.status).toBe('accepted');
    tickParallel(record, now);
    if (i + 1 < count) {
      expect(game.reveals).toHaveLength(i); expect(game.stage).toBe('closing');
      expect(submit(record, opponent.id, i + 1, now + 1).response.status).toBe('accepted');
      tickParallel(record, now + 1);
    }
    expect(game.stage).toBe('reveal');
    expect(pvpSnapshot(game, opponent.id, '/images').phase).toBe('reveal');
    tickParallel(record, nextParallelAlarm(record, now + 1)!);
  }
  expect(game.stage).toBe('complete'); expect(game.reveals).toHaveLength(count);
});

it('uses the original grace cutoff after timeout and does not show a solution while a late guess remains eligible', async () => {
  const record = await fixture(); beginParallel(record, 'start', streamNow, opponent.id);
  const game = record.game, deadline = game.timing!.deadline!;
  submit(record, streamHost.twitchUserId, 0, game.timing!.startsAt + 1);
  tickParallel(record, deadline + 2000); expect(game.reveals).toHaveLength(0);
  expect(submit(record, opponent.id, 0, deadline + 2001).response.status).toBe('closed');
  tickParallel(record, deadline + 5000); expect(game.stage).toBe('reveal');
  expect(game.participants[1].guesses[0]).toBeNull();
});
