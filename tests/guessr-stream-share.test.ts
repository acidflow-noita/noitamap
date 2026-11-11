import { describe, expect, it } from 'vitest';
import type { StreamResult } from '../src/guessr/stream-types';
import { streamShareData } from '../src/guessr/stream-share-data';
import { streamShareLabels } from '../src/guessr/stream-share-image';

function game(scores = [36880, 38120, 38120, 50000, 32000]): StreamResult {
  return { schema: 1, id: 'private-session', version: 'captured', createdAt: 1, finishedAt: Date.UTC(2026, 10, 11, 17),
    host: { id: '0', name: 'dunkorslam', login: 'dunkorslam' },
    rounds: Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: 'Private place', answer: { x: 123, y: 456 }, difficultyTier: 'normal' })),
    players: scores.map((score, index) => ({ id: String(index), login: index ? 'chatter' + index : 'dunkorslam',
      name: index ? 'Chatter' + index : 'dunkorslam', color: '#FF4500', score, rank: 999,
      rounds: Array.from({ length: 10 }, () => ({ score: score / 10, areaScore: 1000, positionScore: score / 10 - 1000 })),
    })),
  };
}
const t = (source: string, values: Record<string, string | number> = {}) => source.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key]));

it('compares the selected chatter with the streamer and preserves competition ranks and username colors', () => {
  const data = streamShareData(game(), '1')!;
  expect(data).toMatchObject({ kind: 'chatter', players: 5, gap: 1240, chatters: 4, outscored: 1,
    player: { name: 'Chatter1', rank: 2, color: '#FF4500', score: 38120 },
    streamer: { name: 'dunkorslam', rank: 4, color: '#9146FF', score: 36880 } });
  expect(data.player.rounds).toEqual(Array(10).fill(3812));
  expect(Object.isFrozen(data.player.rounds)).toBe(true);
});
it('handles ties, losses and an empty chat without inventing a win or counting tied chatters as beaten', () => {
  const tied = streamShareData(game([40000, 40000, 50000]), '1')!;
  expect(tied.gap).toBe(0); expect(tied.player.rank).toBe(2); expect(tied.streamer.rank).toBe(2); expect(tied.outscored).toBe(0);
  const labels = streamShareLabels(tied, 'en', t);
  expect(labels.headline).toBe('Same score as dunkorslam');
  expect(labels.rounds.every(round => round.winner === 0)).toBe(true);
  const loss = streamShareLabels(streamShareData(game([50000, 40000]), '1')!, 'de', t);
  expect(loss.headline).toBe('You scored fewer points than dunkorslam (difference: 10.000 points)');
  expect(loss.rounds.every(round => round.winner === -1)).toBe(true);
  const solo = streamShareData(game([0]))!;
  expect(solo).toMatchObject({ kind: 'streamer', outscored: 0, chatters: 0, player: { rank: 1 } });
});
it('exports only allowed display and scoring data and repairs legacy host names', () => {
  const result = game();
  result.host.name = 'Patron'; result.players[0].name = 'Patron';
  for (const key of ['id', 'version', 'createdAt', 'token']) Object.defineProperty(result, key, { get: () => { throw Error('Private field accessed'); } });
  for (const row of result.rounds) for (const key of ['id', 'name', 'answer', 'clue'])
    Object.defineProperty(row, key, { get: () => { throw Error('Clue accessed'); } });
  const data = streamShareData(result)!;
  expect(data.player.name).toBe('dunkorslam');
  expect(JSON.stringify(data)).not.toMatch(/private-session|Private place|answer|token|version|123|456/);
  expect(data.filename).toBe('noitaguessr-dunkorslam-dunkorslam-2026-11-11.png');
  result.players[0].rounds[0].score = 1;
  expect(data.player.rounds[0]).toBe(3688);
});
describe('invalid exports', () => {
  it('rejects partial, inconsistent and ambiguous saved results', () => {
    const incomplete = game(); incomplete.rounds.pop(); expect(streamShareData(incomplete)).toBeNull();
    const pending = game(); pending.finishedAt = 0; expect(streamShareData(pending)).toBeNull();
    const date = game(); date.finishedAt = 10 ** 16; expect(streamShareData(date)).toBeNull();
    const bad = game(); bad.players[1].rounds[0].score = 5001; expect(streamShareData(bad)).toBeNull();
    const total = game(); total.players[1].score++; expect(streamShareData(total)).toBeNull();
    const duplicate = game(); duplicate.players[1].id = '0'; expect(streamShareData(duplicate)).toBeNull();
    expect(streamShareData(game(), 'absent')).toBeNull();
    const host = game(); host.players.shift(); expect(streamShareData(host)).toBeNull();
  });
});
