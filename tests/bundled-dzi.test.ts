// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import definitions from '../src/data/tilesources.json';

const settings = vi.hoisted(() => ({ light: false }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => settings.light }));
vi.mock('../src/data_sources/overlays', () => ({ createOverlays: () => [] }));
let OSD: any, AppOSD: any;
const entries = Object.values(definitions).flat();
const descriptors = new Map(entries.map(entry => [entry.url, entry.dziContent]));

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  OSD = (await import('openseadragon')).default;
  vi.stubGlobal('OpenSeadragon', OSD);
  ({ AppOSD } = await import('../src/app_osd'));
  vi.spyOn(OSD, 'makeAjaxRequest').mockImplementation((...args: any[]) => {
    const options = args[0], text = descriptors.get(options.url);
    if (!text) throw new Error(`Unexpected DZI request: ${options.url}`);
    queueMicrotask(() => options.success({ status: 200, responseText: text }));
    return { abort() {} };
  });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fromUrl(url: string) {
  return new Promise<any>((resolve, reject) => {
    const source = new OSD.TileSource(url);
    source.addHandler('ready', (event: any) => resolve(event.tileSource));
    source.addHandler('open-failed', reject);
  });
}

it('matches OSD discovery for every bundled map, including edge tiles, overlaps, URLs and world origins', async () => {
  settings.light = false;
  let compared = 0;
  for (const [mapName, records] of Object.entries(definitions)) {
    const before = vi.mocked(OSD.makeAjaxRequest).mock.calls.length;
    const bundled = AppOSD.getTileSources(mapName);
    expect(OSD.makeAjaxRequest).toHaveBeenCalledTimes(before);
    expect(bundled).toHaveLength(records.length);
    for (let i = 0; i < records.length; i++) {
      const original = await fromUrl(records[i].url), current = bundled[i];
      for (const key of ['width', 'height', 'tileOverlap', 'minLevel', 'maxLevel', 'tilesUrl', 'fileFormat', 'queryParams', 'Image'])
        expect(current[key], `${mapName} ${key}`).toEqual(original[key]);
      for (let level = 0; level <= original.maxLevel; level++) {
        const count = original.getNumTiles(level);
        expect(current.getNumTiles(level)).toEqual(count);
        for (const [x, y] of [[0, 0], [Math.max(0, count.x - 1), Math.max(0, count.y - 1)]]) {
          expect(current.getTileUrl(level, x, y)).toBe(original.getTileUrl(level, x, y));
          expect(current.getTileBounds(level, x, y)).toEqual(original.getTileBounds(level, x, y));
          expect(current.tileExists(level, x, y)).toBe(original.tileExists(level, x, y));
          compared++;
        }
      }
    }
  }
  expect(compared).toBeGreaterThan(500);
});

it('keeps light mode limited to the dynamic middle world', () => {
  settings.light = true;
  const dynamic = AppOSD.getTileSources('dynamic-main-branch');
  expect(dynamic).toHaveLength(1);
  expect(dynamic[0].tilesUrl).toContain('-middle.');
  expect(AppOSD.getTileSources('regular-main-branch')).toHaveLength(definitions['regular-main-branch'].length);
});
