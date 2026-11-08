import { describe, expect, it } from 'vitest';
import { areaStartVariants, partitionStarts, startSampler } from '../src/guessr/starting-view';
import { featurelessDifficulty, type AreaDefinition } from '../src/guessr/area-rules';
import { cameraRect } from '../src/guessr/clue-camera';
import type { Bounds } from '../src/guessr/rules';
import type { PrivateImageSet } from '../src/guessr/image-game-server';
import { featurelessCentres, plainCell, type Texture } from '../build_scripts/guessr/featureless-views.mts';

const contains = (rects: readonly Bounds[], x: number, y: number) => rects.some(r => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
function image(width: number, height: number, pixel: (x: number, y: number) => number[]): Texture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { data, width, height };
}
const hell = image(256, 256, (x, y) => (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [32, 16, 14, 255] : [4, 0, 0, 255]);

describe('complete-view difficulty evidence', () => {
  it('rejects water, lava, black holes and bright objects inside otherwise plain EDR', () => {
    const edr = image(32, 32, () => [39, 22, 18, 255]);
    expect(plainCell(edr, 0, 0, 0, 0, 'featureless-edr', hell)).toBe(true);
    for (const pixel of [[0, 0, 0, 255], [39, 67, 64, 255], [255, 96, 0, 255], [255, 220, 0, 255], [39, 22, 18, 0]]) {
      edr.data.set(pixel, (31 * 32 + 31) * 4);
      expect(plainCell(edr, 0, 0, 0, 0, 'featureless-edr', hell)).toBe(false);
    }
  });

  it('matches aligned Hell artwork, tolerates capture noise and rejects a different phase or foreground', () => {
    const source = image(32, 32, (x, y) => {
      const p = (((y + 19) % 256) * 256 + (x + 37) % 256) * 4;
      return [...hell.data.slice(p, p + 3)].map(v => v + (x % 2)).concat(255);
    });
    expect(plainCell(source, 0, 0, 37, 19, 'hell-background-only', hell)).toBe(true);
    expect(plainCell(source, 0, 0, 45, 19, 'hell-background-only', hell)).toBe(false);
    source.data.set([255, 255, 255, 255], (31 * 32 + 31) * 4);
    expect(plainCell(source, 0, 0, 37, 19, 'hell-background-only', hell)).toBe(false);
  });

  it('tests the whole reachable view including the far edge of every centre cell', () => {
    const columns = 90, rows = 50, grid = new Uint8Array(columns * rows).fill(1);
    // Far outside the 27x12 starting view, but inside the widest view.
    grid[25 * columns + 69] = 2;
    const rectangles = featurelessCentres(grid, columns, rows, 1, 0, 0);
    expect(rectangles.length).toBeGreaterThan(0);
    expect(contains(rectangles, 43 * 32 + 31, 25 * 32 + 31)).toBe(false);
    for (const r of rectangles) for (const x of [r.x, r.x + r.width - 1]) for (const y of [r.y, r.y + r.height - 1]) {
      const view = cameraRect({ dx: x, dy: y, level: 6 });
      expect(view.x).toBeGreaterThanOrEqual(0); expect(view.y).toBeGreaterThanOrEqual(0);
      for (let row = Math.floor(view.y / 32); row <= Math.floor((view.y + view.height - 1) / 32); row++)
        for (let column = Math.floor(view.x / 32); column <= Math.floor((view.x + view.width - 1) / 32); column++)
          expect(grid[row * columns + column]).toBe(1);
    }
  });

  it('partitions starts exactly, retaining holes, overlap unions and every eligible native position once', () => {
    const source = [{ x: -5, y: -2, width: 12, height: 4 }, { x: -5, y: 2, width: 4, height: 5 }];
    const mask = [{ x: -2, y: -1, width: 12, height: 6 }, { x: -4, y: 1, width: 5, height: 5 }];
    const { inside, outside } = partitionStarts(source, mask);
    for (let y = -4; y < 10; y++) for (let x = -8; x < 15; x++) {
      expect(contains(inside, x, y)).toBe(contains(source, x, y) && contains(mask, x, y));
      expect(contains(outside, x, y)).toBe(contains(source, x, y) && !contains(mask, x, y));
    }
    expect(startSampler(inside).pixels + startSampler(outside).pixels).toBe(startSampler(source).pixels);
    for (const rects of [inside, outside]) {
      const sampler = startSampler(rects), points = new Set<string>();
      for (let n = 0; n < sampler.pixels; n++) {
        const p = sampler.sample(() => (n + .5) / sampler.pixels);
        expect(contains(rects, p.x, p.y)).toBe(true); points.add(`${p.x},${p.y}`);
      }
      expect(points.size).toBe(sampler.pixels);
    }
  });

  it('preserves EDR scoring, uses the Hard Hell profile and rejects stale evidence', () => {
    const area: AreaDefinition = { id: 'terrain/edr', label: 'EDR', difficultyTier: 'normal', scoring: { area: 1000, position: 4000, maximum: 5000 } };
    const starts = startSampler([{ x: 0, y: 0, width: 100, height: 50 }]);
    const index: PrivateImageSet = { schemaVersion: 1, version: 'fixture', levels: {}, images: {},
      capture: { sha256: 'fixture', originX: 0, originY: 0, width: 2048, height: 1024, tileSize: 512, overlap: 2, maxLevel: 11 },
      viewDifficulty: { schemaVersion: 1, imageVersion: 'fixture', cellSize: 32,
        areas: { [area.id]: [{ x: 0, y: 0, width: 40, height: 50 }] } } };
    const variants = areaStartVariants(index, area, starts);
    expect(variants.map(v => [v.definition.difficultyTier, v.sampler.pixels])).toEqual([['normal', 3000], ['hard', 2000]]);
    expect(variants[1].definition).toMatchObject({ id: area.id, scoring: area.scoring, viewDifficulty: 'featureless-edr' });
    expect(area.difficultyTier).toBe('normal');
    expect(featurelessDifficulty({ ...area, id: 'biome/the-work-hell' })).toMatchObject({ difficultyTier: 'hard',
      scoring: { area: 3000, position: 2000, maximum: 5000 }, viewDifficulty: 'hell-background-only' });
    index.viewDifficulty!.imageVersion = 'different';
    expect(() => areaStartVariants(index, area, starts)).toThrow('does not match');
  });
});
