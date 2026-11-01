import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { prepareCapturedMap } from '../build_scripts/guessr/prepare-captured-map.mjs';
import { composeDailyWorld, loadDailyBackground, type PyramidGeometry } from '../build_scripts/guessr/daily-background.mts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'guessr-background-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('preserves exact native terrain, restores static scenery through transparency and retains the background edge', async () => {
  const capture: PyramidGeometry = { width: 1536, height: 2048, originX: 0, originY: 0, tileSize: 512, overlap: 2, maxLevel: 11 };
  const native = { ...capture, width: 1024 };
  const base = join(directory, 'base'), bake = join(directory, 'bake'), output = join(directory, 'composed');
  const staticPng = join(directory, 'static.png'), terrainPng = join(directory, 'terrain.png');
  await sharp({ create: { width: capture.width, height: capture.height, channels: 4, background: '#112233' } }).png().toFile(staticPng);
  await sharp({ create: { width: native.width, height: native.height, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 8, height: 8, channels: 4, background: '#cc8800' } }).png().toBuffer(), left: 100, top: 100 }])
    .png().toFile(terrainPng);
  await prepareCapturedMap(staticPng, base, { originX: 0, originY: 0 });
  await prepareCapturedMap(terrainPng, bake, { originX: 0, originY: 0 });
  await writeFile(join(base, 'background.json'), JSON.stringify({ schemaVersion: 1, kind: 'dynamic-map-background', identity: 'a'.repeat(64), source: 'fixture', capture }));
  const tile = join(bake, 'map_files/11/0_0.webp'), original = await readFile(tile);
  const background = await loadDailyBackground({ manifest: join(base, 'background.json'), cacheDirectory: join(directory, 'cache') });
  const result = await composeDailyWorld(bake, native, output, background);
  expect(result.capture).toEqual(capture);
  const pixels = await sharp(join(output, 'map_files/11/0_0.webp')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => [...pixels.data.subarray((y * pixels.info.width + x) * 4, (y * pixels.info.width + x) * 4 + 4)];
  expect(at(100, 100)).toEqual([204, 136, 0, 255]);
  expect(at(200, 200)).toEqual([17, 34, 51, 255]);
  expect(await readFile(join(output, 'map_files/11/2_0.webp'))).toEqual(await readFile(join(base, 'map_files/11/2_0.webp')));
  expect(await readFile(tile)).toEqual(original);
});

it('normalizes legacy low-level padding but refuses a wrong native-size tile', async () => {
  const manifest = { schemaVersion: 1, kind: 'dynamic-map-background', identity: 'b'.repeat(64), source: 'fixture',
    capture: { width: 1024, height: 1024, originX: 0, originY: 0, tileSize: 512, overlap: 2, maxLevel: 10 } };
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#556677' } }).webp({ lossless: true }).toBuffer();
  let downloads = 0;
  const network: typeof fetch = async input => {
    if (String(input).endsWith('/background.json')) return Response.json(manifest);
    downloads++; return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp' } });
  };
  const background = await loadDailyBackground({ manifest: 'https://example.test/background.json', cacheDirectory: join(directory, 'cache'), fetch: network });
  const tile = await background.tile(0, 0, 0);
  expect(await sharp(tile).metadata()).toMatchObject({ width: 1, height: 1 });
  expect([...(await sharp(tile).removeAlpha().raw().toBuffer())]).toEqual([85, 102, 119]);
  expect(await background.tile(0, 0, 0)).toBe(tile); expect(downloads).toBe(1);
  await expect(background.tile(10, 0, 0)).rejects.toThrow('descriptor expects');
});
