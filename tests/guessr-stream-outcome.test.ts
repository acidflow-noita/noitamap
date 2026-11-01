import { describe, expect, it } from 'vitest';
import { prepareAreaScorer } from '../src/guessr/area-rules';
import { prepareStreamRoundOutcome } from '../src/guessr/stream-outcome';
import { STREAM_MAX_PLAYERS, type StreamRoundSubmission } from '../src/guessr/stream-types';
import { streamAnswer, streamArea } from './helpers/guessr-stream';

const reveal = { roundId: 'current-round', answer: streamAnswer, area: streamArea };
const submission = (id = '101'): StreamRoundSubmission => ({
  player: { id, login: 'chatter' + id, name: 'Chatter' }, guess: { ...streamAnswer }, maximum: 4600,
});
describe('stream round outcomes', () => {
  it('uses the same exact scorer and preserves capped scores, distance and missed guesses', () => {
    const one = submission(), two = { ...submission('102'), guess: { x: -17920, y: 1000 }, maximum: 2300 },
      missed = { ...submission('103'), guess: null };
    const outcome = prepareStreamRoundOutcome(reveal, [one, two, missed], streamArea.bounds!);
    const scorer = prepareAreaScorer(streamArea, streamAnswer);
    for (const [index, entry] of [one, two, missed].entries()) {
      const expected = scorer(entry.guess, entry.maximum);
      expect(outcome.players[index]).toMatchObject({ id: entry.player.id, guess: entry.guess,
        score: expected.score, areaScore: expected.areaScore, positionScore: expected.positionScore, distance: expected.distance });
    }
    expect(outcome).toMatchObject({ answer: streamAnswer, label: streamArea.label, difficultyTier: 'normal' });
    expect(JSON.stringify(outcome)).not.toContain('runs');
    expect(JSON.stringify(outcome)).not.toContain('token');
  });
  it('rejects duplicate identities, malformed participants, out-of-bounds pins and invalid caps', () => {
    const one = submission();
    const invalid = [
      [one, one], [{ ...one, player: { ...one.player, id: 'not-twitch-id' } }],
      [{ ...one, guess: { x: 100_000, y: 0 } }], [{ ...one, maximum: 5001 }],
      [{ ...one, maximum: -1 }], [{ ...one, maximum: 1.5 }], [{ ...one, guess: undefined }],
    ];
    for (const roster of invalid) expect(() => prepareStreamRoundOutcome(reveal, roster, streamArea.bounds!)).toThrow();
    expect(() => prepareStreamRoundOutcome(reveal, Array(STREAM_MAX_PLAYERS + 1).fill(one), streamArea.bounds!)).toThrow(/up to/);
  });
  it('accepts older empty rosters and copies only the public fields of supplied objects', () => {
    expect(prepareStreamRoundOutcome(reveal, undefined, streamArea.bounds!).players).toEqual([]);
    const one = { ...submission(), token: 'do-not-send', guess: { ...streamAnswer, secret: 'do-not-send' } };
    const outcome = prepareStreamRoundOutcome(reveal, [one], streamArea.bounds!);
    one.guess.x = -100;
    expect(outcome.players[0].guess).toEqual(streamAnswer);
    expect(JSON.stringify(outcome)).not.toContain('do-not-send');
  });
});
