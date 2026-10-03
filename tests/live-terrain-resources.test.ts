import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { packHostTerrainTable } from '../src/telescope/live-terrain-resources';
import { hostTerrainShader, hostDecalDetail } from '../build_scripts/telescope-host-rendering';

describe('GPU host policy table', () => {
  it('preserves biome/Wang rows and indexes surfaces on both sides of a chunk seam', () => {
    const data = new Float32Array(512 * 3 * 4).map((_, i) => i);
    const ownership = { width: 2, owners: new Int16Array(96).fill(-1), names: ['mine'], at: () => -1 };
    ownership.owners[2] = 0;
    const surface = { left: -10, right: 10, y: -6656, material: 135 };
    const { table, base } = packHostTerrainTable({ data, width: 512, height: 3 }, ownership, [surface]);
    expect(table.data.subarray(0, base * 4)).toEqual(data.subarray(0, base * 4));
    expect(table.data.subarray((table.height - 1) * 512 * 4)).toEqual(data.subarray(2 * 512 * 4));
    for (const cell of [0, 1, 2, 3]) {
      const offset = (base + cell) * 4;
      expect(table.data[offset]).toBe(cell === 2 ? 1 : 0);
      expect(table.data[offset + 2]).toBe(1);
      const record = table.data[offset + 1] * 4;
      expect([...table.data.subarray(record, record + 4)]).toEqual([-10, 10, -6656, 135]);
    }
    expect(table.data[(base + 4) * 4 + 2]).toBe(0);
  });
  it('applies levelling to both color and material-ID passes, without adding samplers', () => {
    const source = readFileSync(new URL('../lib/noita-telescope-vm/js/gl/shaders.js', import.meta.url), 'utf8');
    const modified = hostTerrainShader(source);
    expect(modified.match(/mat = hostLiquid\(mat, w\);/g)).toHaveLength(2);
    expect(modified.match(/uniform.*sampler/g)?.length).toBe(source.match(/uniform.*sampler/g)?.length);
    expect(modified).toContain('int width = u_mapWidth;');
  });
  it('uses detailZoom for decals while retaining the real camera zoom for positions', () => {
    const source = readFileSync(new URL('../lib/noita-telescope-vm/js/edge_decal_layer.js', import.meta.url), 'utf8');
    const modified = hostDecalDetail(source);
    expect(modified).toContain('(view.detailZoom ?? view.camZ) >= EDGE_DECAL_MIN_ZOOM');
    expect(modified).toContain('zoom: view.camZ');
    expect(modified).toContain('view.detailZoom === Infinity ? 0');
  });
});
