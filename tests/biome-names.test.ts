import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import en from '../src/locales/en/translation.json';
import ja from '../src/locales/ja/translation.json';
import boundaries from '../src/data/biome_boundries_py.json';
import styledBoundaries from '../src/data/biome_boundries_py.tailwind.json';
import metadata from '../src/data/biome-names.json';

const { instance } = vi.hoisted(() => ({ instance: { current: null as any } }));
vi.mock('../src/i18n', () => ({ default: {
  t: (...args: any[]) => instance.current.t(...args),
} }));
import { describeBiome, getPOIBiomeDescription } from '../src/data_sources/biome-names';

beforeAll(async () => {
  instance.current = createInstance();
  await instance.current.init({ lng: 'en', fallbackLng: false, showSupportNotice: false,
    resources: { en: { translation: en }, ja: { translation: ja } } });
});
beforeEach(async () => { await instance.current.changeLanguage('en'); });

const color = (name: string) => Number(metadata.find(row => row[0] === name)![2]) | 0xff000000;
function generation(width = 70) {
  return { worldSize: width, worldCenter: width / 2,
    biomeData: { pixels: new Uint32Array(width * 48).fill(color('coalmine')), w: width, h: 48 } };
}

describe('shared boundary and report biome names', () => {
  it('keeps the compact synchronous metadata identical to the real boundary sources', () => {
    expect(metadata).toEqual(boundaries.biomes.map(b => [b.filename, b.name, parseInt(b.biome_color.slice(1), 16)]));
    expect(metadata.map(row => row.slice(0, 2))).toEqual(styledBoundaries.biomes.map(b => [b.filename, b.name]));
  });

  it.each([
    ['rainforest_open', 'biome_rainforest', true],
    ['fungiforest', 'biome_fun', false],
    ['solid_wall_tower_9', 'biome_tower', false],
    ['temple_altar_left', 'biome_holymountain', true],
    ['the_sky', 'biome_boss_victoryroom', false],
    ['the_end', 'biome_boss_victoryroom', false],
  ])('uses the authored name for %s while preserving its internal ID', (internalName, key, mainPath) => {
    expect(describeBiome(internalName)).toEqual({ internalName, mainPath,
      displayName: (en.gameContent.biomes as Record<string, string>)[key] });
  });

  it.each(['solid_wall_tower_10', 'song_room', 'snowcave_secret_chamber', 'friend_5'])(
    'retains the boundary overlay’s intentionally unnamed room %s', internalName => {
      expect(describeBiome(internalName)).toEqual({ internalName, mainPath: false, displayName: en.noInGameName });
    });

  it('translates at render time and handles the explicit unnamed sentinel', async () => {
    await instance.current.changeLanguage('ja');
    expect(describeBiome('rainforest_open').displayName).toBe(ja.gameContent.biomes.biome_rainforest);
    expect(describeBiome('custom_room', '_EMPTY_').displayName).toBe(ja.noInGameName);
  });

  it('resolves the loaded seed’s actual cell instead of a misleading source variant', () => {
    const gen = generation();
    gen.biomeData.pixels[14 * 70 + 35] = color('fungiforest');
    const poi = { worldX: 10, worldY: 10, pw: 0, biome: 'coalmine' };
    expect(getPOIBiomeDescription(poi, gen)).toEqual(describeBiome('fungiforest'));
    expect(poi.biome).toBe('coalmine');
  });

  it.each([70, 64])('wraps absolute parallel-world coordinates once at width %i', width => {
    const gen = generation(width);
    gen.biomeData.pixels[14 * width + width / 2] = color('temple_altar');
    for (const pw of [-2, -1, 0, 1, 2]) {
      expect(getPOIBiomeDescription({ worldX: pw * width * 512 + 20, worldY: 10, pw }, gen))
        .toEqual(describeBiome('temple_altar'));
    }
  });

  it('resolves sky and hell from their repeated edge rows without wrapping into the main map', () => {
    const gen = generation();
    gen.biomeData.pixels[35] = color('the_sky');
    gen.biomeData.pixels[47 * 70 + 35] = color('the_end');
    expect(getPOIBiomeDescription({ worldX: 0, worldY: -20000 }, gen)?.internalName).toBe('the_sky');
    expect(getPOIBiomeDescription({ worldX: 0, worldY: 45000 }, gen)?.internalName).toBe('the_end');
  });

  it('uses provided vertical-plane pixels when available', () => {
    const gen = generation();
    const data = { ...gen.biomeData, heavenPixels: new Uint32Array(70 * 48).fill(color('winter')) };
    expect(getPOIBiomeDescription({ worldX: 0, worldY: -20000 }, { ...gen, biomeData: data })?.internalName).toBe('winter');
  });

  it('falls back to known source metadata when coordinates/grid are unavailable, otherwise returns null', () => {
    expect(getPOIBiomeDescription({ biome: '$biome_rainforest_open' })).toEqual(describeBiome('rainforest_open'));
    expect(getPOIBiomeDescription({ biome: 'song_room', worldX: NaN, worldY: 0 }, generation()))
      .toEqual(describeBiome('song_room'));
    expect(getPOIBiomeDescription({})).toBeNull();
    expect(getPOIBiomeDescription({ biome: 'Unknown' })).toBeNull();
  });
});
