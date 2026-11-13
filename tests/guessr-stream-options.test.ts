import { expect, it } from 'vitest';
import { StreamService } from '../src/guessr/stream-server';
import { streamPlayerName, streamResultNames } from '../src/guessr/stream-display-name';
import { streamHost, streamNow, streamSecret, streamSource } from './helpers/guessr-stream';

it('defaults stream games to five rounds and supports exactly three, five and ten', async () => {
  const service = new StreamService(streamSource(), streamSecret);
  expect((await service.start(streamHost, streamNow)).rounds).toHaveLength(5);
  for (const count of [3, 5, 10]) expect((await service.start(streamHost, streamNow, 'twitch', count)).rounds).toHaveLength(count);
  for (const count of [0, 4, 6, 11, NaN]) await expect(service.start(streamHost, streamNow, 'twitch', count)).rejects.toThrow('Choose 3, 5 or 10 rounds.');
});
it('publishes every score when a Twitch display name contains invisible direction marks', async () => {
  const service = new StreamService(streamSource(), streamSecret);
  const session = await service.start(streamHost, streamNow, 'twitch', 5);
  const player = (id: string, login: string, name: string) => ({ id, login, name, score: 25000, rounds: Array.from({ length: 5 }, () => [1000, 4000] as [number, number]) });
  const { result } = await service.result({ token: session.token, finishedAt: streamNow + 1000, players: [
    player(streamHost.twitchUserId, streamHost.twitchLogin, streamHost.name), player('200', 'omicron', '\u061c\u061c007'),
  ] }, streamHost, streamNow + 1001);
  expect(result.players).toHaveLength(2);
  expect(result.players[1]).toMatchObject({ id: '200', login: 'omicron', name: '007', score: 25000 });
  const dirty = { ...result, players: result.players.map(p => ({ ...p, rounds: p.rounds.map(([areaScore, positionScore]) => ({ areaScore, positionScore, score: areaScore + positionScore })) })) };
  dirty.players[1].name = '\u061c\u061c007';
  expect(streamResultNames(dirty).players[1]).toMatchObject({ name: '007', score: 25000 });
  expect(dirty.players[1].name).toBe('\u061c\u061c007');
});
it('keeps display names safe without truncating a Unicode surrogate pair', () => {
  expect(streamPlayerName('\u061c\u200d<>', 'omicron')).toBe('omicron');
  const value = streamPlayerName('x' + '𐐀'.repeat(40), 'name');
  expect(value.length).toBeLessThanOrEqual(48);
  expect(value).not.toMatch(/\p{Cs}/u);
});
