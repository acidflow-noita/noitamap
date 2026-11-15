import { expect, it } from 'vitest';
import { newPlayerReview, networkTag, roundNetworkFlags } from '../src/guessr/network-review';
import { StreamService } from '../src/guessr/stream-server';
import { newStreamGame, streamResult } from '../src/guessr/stream-state';
import { hostSnapshot } from '../src/guessr/host-snapshot';
import { streamSource, streamHost, streamSecret, streamNow, streamAnswer } from './helpers/guessr-stream';

it('uses private per-game keyed tags with normalized addresses and no shared unknown/proxy group', async () => {
  const key = 'a'.repeat(64);
  const tag = await networkTag(key, 'game-one', '192.0.2.1');
  expect(tag).toMatch(/^[a-f0-9]{32}$/);
  expect(await networkTag(key, 'game-one', '::ffff:192.0.2.1')).toBe(tag);
  expect(await networkTag(key, 'game-two', '192.0.2.1')).not.toBe(tag);
  expect(await networkTag('b'.repeat(64), 'game-one', '192.0.2.1')).not.toBe(tag);
  for (const address of [null, '', '999.0.2.1', 'unknown', '2a06:98c0:3600::103']) expect(await networkTag(key, 'game-one', address)).toBeUndefined();
});

it('finds nonsubmitting scouts, retains scores, and exposes evidence without private identifiers', async () => {
  const service = new StreamService(streamSource(), streamSecret), session = await service.start(streamHost, streamNow, 'parallel', 3);
  const game = newStreamGame(session, streamNow), reveal = await service.reveal(session.rounds[0].token, streamHost, streamNow);
  game.reveals = [reveal];
  const guess = { point: streamAnswer, maximum: 5000, messageId: 'one', sentAt: streamNow };
  game.participants.push({ id: '200', login: 'player', name: 'Player', guesses: [guess, null, null] },
    { id: '201', login: 'scout', name: 'Scout', guesses: [null, null, null] });
  const high = newPlayerReview(), scout = newPlayerReview(), tag = 'c'.repeat(32);
  high.submitted[0] = tag; scout.explored[0] = tag;
  const reviews = new Map([['200', high], ['201', scout]]);
  const before = JSON.stringify(game.participants);
  game.reviewFlags = roundNetworkFlags(game, 0, reviews);
  expect(game.reviewFlags).toEqual([{ round: 1, highScorers: ['200'], explorers: ['201'], nonSubmitting: ['201'] }]);
  expect(JSON.stringify(game.reviewFlags)).not.toContain(tag); expect(JSON.stringify(game.participants)).toBe(before);
  game.stage = 'complete'; game.finishedAt = streamNow + 100;
  // A partial concession lets this fixture inspect the public result without inventing more rounds.
  game.pvp = { ready: [], declined: [], concededBy: game.session.host.id };
  const result = streamResult(game); expect(result.players.find(p => p.id === '200')!.score).toBe(5000);
  expect(JSON.stringify(result)).not.toContain(tag);
  delete game.pvp;
  game.participants[2].guesses[0] = { ...guess, point: { x: 9999, y: 9999 } };
  expect(roundNetworkFlags(game, 0, reviews)[0].nonSubmitting).toEqual([]);
  high.submitted[0] = 'd'.repeat(32); expect(roundNetworkFlags(game, 0, reviews)).toEqual([]);
});

it('keeps the host counter while withholding other pins and future clue pixels', async () => {
  const session = await new StreamService(streamSource(), streamSecret).start(streamHost, streamNow, 'parallel', 3);
  const game = newStreamGame(session, streamNow);
  game.participants.push({ id: '200', name: 'Player', login: 'player', guesses: [{ point: streamAnswer, maximum: 5000, messageId: 'private', sentAt: streamNow }, null, null] });
  const view = hostSnapshot(game);
  expect(view.submittedCounts).toEqual([1, 0, 0]); expect(view.participants[1].guesses).toEqual([null, null, null]);
  expect(view.session.rounds.every(round => !round.clue.frames?.length && !round.token)).toBe(true);
  expect(JSON.stringify(view)).not.toContain('private');
});
