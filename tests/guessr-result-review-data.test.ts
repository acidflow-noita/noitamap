import { expect, it } from 'vitest';
import { resultClue, resultMapConfig, resultRoundView } from '../src/guessr/result-review-data';
import { cameraRect, supportedCamera } from '../src/guessr/clue-camera';
import type { ImageGameConfig } from '../src/guessr/image-game';
import type { StreamResult } from '../src/guessr/stream-types';
const config: ImageGameConfig = { version: 'test', bounds: { x: -17920, y: -31744, width: 36352, height: 73728 }, overview: '',
  map: { width: 36352, height: 73728, tileSize: 512, overlap: 2, maxLevel: 17, tiles: 'https://guessr-map.sage-data.xyz/map_files/' } };
it.each([{ x: -2385, y: 9161 }, { x: -17408, y: -31232 }, { x: 0, y: 0 }])('reconstructs the exact initial clue across reference-tile seams at %j', answer => {
  const source = resultClue(config, answer)!;
  expect(supportedCamera(source, { dx: 0, dy: 0, level: 0 })).toBe(true);
  const view = cameraRect({ dx: 0, dy: 0, level: 0 });
  for (let y = view.y; y < view.y + view.height; y++) for (let x = view.x; x < view.x + view.width; x++)
    expect(source.frames!.some(f => x >= f.x && y >= f.y && x < f.x + f.width && y < f.y + f.height)).toBe(true);
  for (const frame of source.frames!) {
    expect(frame.image).toMatch(/^https:\/\/guessr-map\.sage-data\.xyz\/map_files\/17\/\d+_\d+\.webp$/);
    const [column, row] = frame.image.match(/(\d+)_(\d+)\.webp$/)!.slice(1).map(Number);
    expect(frame.x + answer.x - config.bounds.x).toBe(Math.max(0, column * 512 - 2));
    expect(frame.y + answer.y - config.bounds.y).toBe(Math.max(0, row * 512 - 2));
  }
});
it('does not substitute a different dataset and keeps old recorded scores when coordinates were not stored', () => {
  const result = { schema: 1, id: 'game', version: 'test', createdAt: 0, finishedAt: 1,
    host: { id: '1', name: 'Host', login: 'host' }, rounds: [{ id: 'round', name: 'Mines', answer: { x: 0, y: 0 }, difficultyTier: 'easy' }],
    players: [{ id: '1', name: 'Host', login: 'host', score: 3000, rank: 1, rounds: [{ score: 3000, areaScore: 1000, positionScore: 2000 }] }] } as StreamResult;
  expect(resultMapConfig(result, config)).toBe(config);
  expect(resultMapConfig(result, { ...config, version: 'different' })).toBeUndefined();
  expect(resultRoundView(result, 0).players[0]).toMatchObject({ guess: null, recorded: true, score: 3000, total: 3000 });
  result.positions = { '1': [[12, 24]] }; result.config = config;
  expect(resultRoundView(result, 0).players[0].guess).toEqual({ x: 12, y: 24 });
  expect(resultMapConfig(result)).toBe(config);
});
