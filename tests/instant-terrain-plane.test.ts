import { describe, expect, it } from 'vitest';
import { instantTileView } from '../src/telescope/instant-terrain';
import { WORLD_HEIGHT, WORLD_TOP } from '../src/telescope/terrain-policy';

describe('vertical terrain camera coordinates', () => {
  it('feeds absolute world pixels to every plane at coarse and detail LODs', () => {
    for (const plane of [-1, 0, 1]) for (const pw of [-1, 0, 1]) {
      const region = { x: -17920 + pw * 35840, y: WORLD_TOP + plane * WORLD_HEIGHT,
        width: 35840, height: WORLD_HEIGHT, pw };
      for (const level of [8, 12, 16]) {
        const tile = { level, x: level === 8 ? 0 : 1, y: level === 8 ? 0 : 2 };
        const view = instantTileView(region, tile, 35, 70)!;
        // Evaluate the upstream camera transform, then sample a screen pixel
        // center. Plane coordinates must not be subtracted before the shader
        // evaluates absolute-coordinate noise and material bands.
        const originX = view.camX - view.width / (2 * view.camZ) - 17920 + pw * 35840;
        const originY = view.camY - view.height / (2 * view.camZ) - 7168 + view.pwVertical * WORLD_HEIGHT;
        const scale = 2 ** (16 - level);
        expect(originX).toBe(region.x + tile.x * 256 * scale);
        expect(originY).toBe(region.y + tile.y * 256 * scale);
        expect(Math.floor(originY + 0.5 / view.camZ)).toBe(
          region.y + tile.y * 256 * scale + Math.floor(scale / 2));
      }
    }
  });
});
