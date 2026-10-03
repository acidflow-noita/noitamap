import { describe, expect, it } from 'vitest';
import Flatbush from 'flatbush';
import { legacyMimicMarkerData } from '../src/telescope/legacy-mimic-markers';
import { serializeGenerationForBake, hydrateBakedGeneration } from '../src/telescope/baked-generation';
import { createBakedWorldMetadata } from '../build_scripts/baked-world-metadata.mjs';
import type { MarkerData, MarkerItem } from '../src/telescope/poi-spatial-index';
import type { GenerationResult } from '../src/telescope/telescope-adapter';

function fixture() {
  const items: MarkerItem[] = [];
  for (const pw of [-1, 0, 1]) for (const item of ['mimic', 'chest_leggy', 'refresh_mimic', 'heart_mimic', 'mimic_potion', 'heart']) {
    const x = items.length * 100;
    items.push({ poi: { type: 'item', item, x, y: 0 }, pw, spriteKey: `item:${item}`, osdX: x, osdY: 0, w: 16, h: 16 });
  }
  return { items, index: new Flatbush(items.length), originX: -100, originY: -200,
    bboxWidth: 3000, bboxHeight: 500, atlas: {}, spritesheet: {} as HTMLImageElement } satisfies MarkerData;
}

describe('legacy daily mimic artwork compatibility', () => {
  it('overlays only omitted mimics, never the already baked heart or potion disguises or other pickups', () => {
    const data = fixture(), result = legacyMimicMarkerData(data)!;
    expect(result.items.map(item => item.poi.item)).toEqual(Array(3).fill(['mimic', 'chest_leggy', 'refresh_mimic']).flat());
    expect(result.index.search(0, 0, 3000, 500)).toHaveLength(9);
    // Existing heart-mimic and potion-mimic pixels do not gain duplicate sprites.
    expect(result.index.search(395, 195, 405, 205)).toEqual([]);
    expect(result.items[0]).toBe(data.items[0]);
    expect(result.originX).toBe(data.originX);
    expect(result.originY).toBe(data.originY);
    expect(data.items).toHaveLength(18);
  });

  it('uses each world’s bake revision independently and adds no marker layer to complete new bakes', () => {
    const data = fixture();
    expect(legacyMimicMarkerData(data, { '-1': 1, '0': 1, '1': 1 })).toBeNull();
    const partial = legacyMimicMarkerData(data, { '-1': 1, '0': 0, '1': 1 })!;
    expect(partial.items).toHaveLength(3);
    expect(partial.items.every(item => item.pw === 0)).toBe(true);
    expect(legacyMimicMarkerData(data, { '-1': NaN, '0': Infinity, '1': -1 })!.items).toHaveLength(9);
  });

  it('also repairs absent illusion entity sprites without duplicating existing chest bodies', () => {
    const data = fixture();
    data.items = ['dark_alchemist', 'shaman_wind', 'chest_mimic', 'chest_leggy', 'mimic_potion']
      .map((entity, index) => ({ ...data.items[index], poi: { type: 'entity', entity, x: index * 100, y: 0 } }));
    expect(legacyMimicMarkerData(data)!.items.map(item => item.poi.entity)).toEqual(['dark_alchemist', 'shaman_wind']);
  });

  it('preserves a new decoration revision through publication and hydration without upgrading legacy serialization', () => {
    const generation: GenerationResult = {
      seed: 1344443116, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35, parallelWorlds: [-1, 0, 1],
      biomeData: { pixels: new Uint32Array(70 * 48) }, tileLayers: [], eyes: undefined,
      poisByPW: { '-1,0': [], '0,0': [{ type: 'item', item: 'mimic', x: 7435, y: 6847 }], '1,0': [] },
      pixelScenesByPW: { '-1,0': [], '0,0': [], '1,0': [] },
    };
    const metadata = serializeGenerationForBake(generation)!;
    expect(metadata.mimicSpritesVersion).toBeUndefined();
    // The native and image bakers receive this revision from successful
    // prepareDecorationExport, and attach it only to those new pixels.
    metadata.mimicSpritesVersion = 1;
    expect(metadata.mimicSpritesVersion).toBe(1);
    const slices = ['left', 'middle', 'right'].map(world => createBakedWorldMetadata(metadata, world, generation.seed));
    expect(slices.map(slice => slice.mimicSpritesVersion)).toEqual([1, 1, 1]);
    expect(hydrateBakedGeneration(slices).bakedMimicSpritesVersionByPW).toEqual({ '-1': 1, '0': 1, '1': 1 });
    expect(serializeGenerationForBake(hydrateBakedGeneration(slices))!.mimicSpritesVersion).toBe(1);
    delete slices[1].mimicSpritesVersion;
    const legacy = hydrateBakedGeneration(slices);
    expect(legacy.bakedMimicSpritesVersionByPW).toEqual({ '-1': 1, '0': 0, '1': 1 });
    expect(serializeGenerationForBake(legacy)!.mimicSpritesVersion).toBeUndefined();
    expect(serializeGenerationForBake(hydrateBakedGeneration([slices[1]]))!.mimicSpritesVersion).toBeUndefined();
    expect(legacy.poisByPW['0,0'].some(poi => poi.item === 'mimic' && poi.x === 7435)).toBe(true);
  });
});
