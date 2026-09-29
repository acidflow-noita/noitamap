import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { decode } from 'fast-png';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createNativeSceneWorkerRenderer } from '../src/telescope/native-scene-worker-core';
import JSZip from 'jszip';
import * as sceneModule from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { renderNativeSceneBitmap } from '../src/telescope/native-scene-bitmap';
import { paintTerrainScene, readRGBA } from '../src/telescope/terrain-scenes';
import { createPixelSceneTileSource } from '../src/telescope/pixel-scene-tile-source';
import { snapshotWorkerScenes, installWorkerScenes } from '../src/telescope/worker-scenes';
import { encodeScenePack, decodeScenePack } from '../src/telescope/scene-pack';
import { decodePngToRgba } from '../src/telescope/png-decode';
import { addStaticPixelScenes } from '../lib/noita-telescope-vm/js/static_spawns.js';
import { loadPixelSceneData, initPixelSceneTextures } from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { updateSettings } from '../lib/noita-telescope-vm/js/settings.js';

// Exercise the production bridge's private selection policy without loading
// its unrelated UI, viewer and asset initialization in a browser environment.
const bridgePath = new URL('../src/telescope/telescope-osd-bridge.ts', import.meta.url);
const bridge = ts.createSourceFile('bridge.ts', readFileSync(bridgePath, 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['pixelSceneConfig', 'getSceneCategory', 'renderableScenes']);
const policy = bridge.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) ? names.has(statement.name?.text ?? '') :
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(bridge))),
).map(statement => statement.getText(bridge).replace(/^export\s+/, '')).join('\n');
const renderableScenes = new Function(`${ts.transpileModule(policy, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText}\nreturn renderableScenes;`)();

let restore = () => {};
let biomeData: { pixels: Uint32Array; heavenPixels: Uint32Array; hellPixels: Uint32Array };
beforeAll(async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), new URL('../lib/noita-telescope-vm/js/', import.meta.url));
    return new Response(await readFile(url));
  });
  restore = () => fetch.mockRestore();
  updateSettings({ enableStaticPixelScenes: 'all', clearSpawnPixels: true });
  await loadPixelSceneData();
  await initPixelSceneTextures();
  // The live app installs the prepared metadata pack before lazily decoding
  // artwork. Cover that boundary too, not only direct library initialization.
  const packed = encodeScenePack(snapshotWorkerScenes(sceneModule, true), 'gold-regression');
  installWorkerScenes(sceneModule, decodeScenePack(packed.buffer as ArrayBuffer, 'gold-regression'), true);
  const png = decode(readFileSync(new URL('../lib/noita-telescope-vm/data/biome_maps/biome_map.png', import.meta.url)));
  const pixels = new Uint32Array(png.width * png.height);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * png.channels;
    pixels[i] = 0xff000000 | (png.data[offset] << 16) | (png.data[offset + 1] << 8) | png.data[offset + 2];
  }
  const heavenPixels = new Uint32Array(pixels.length), hellPixels = new Uint32Array(pixels.length);
  for (let y = 0; y < png.height; y++) {
    heavenPixels.set(pixels.subarray(0, png.width), y * png.width);
    hellPixels.set(pixels.subarray((png.height - 1) * png.width), y * png.width);
  }
  biomeData = { pixels, heavenPixels, hellPixels };
});
afterAll(() => restore());

it.each([
  [2391, -3102, 0],
  [239365546, -3102, 0],
  [1, -3102, 0], // Ancient Laboratory, previously suppressed as static art.
  [4, -3102, 8192],
  [7, 2530, 8704],
  [3, -4126, 11264],
])('keeps the generated hidden gold room for seed %i in every horizontal world', (seed, x, y) => {
  expect(policy).toContain('skipNames');
  for (const pw of [-1, 0, 1]) {
    const { pixelScenes } = addStaticPixelScenes(seed, 0, pw, 0, biomeData, false, {}, false, 'normal');
    const drawn = renderableScenes({ pixelScenesByPW: { [`${pw},0`]: pixelScenes } });
    const stashes = drawn.filter((scene: any) => scene.key === 'general/solid_wall_hidden_cavern');
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toMatchObject({ x: x + pw * 35840, y, width: 512, height: 512 });
  }
});


it.each([false, true])('decodes the packed Ancient Laboratory stash and paints all gold through the live scene source (compressed=%s)', async compressed => {
  const { pixelScenes } = addStaticPixelScenes(2391, 0, 0, 0, biomeData, false, {}, false, 'normal');
  const selected = renderableScenes({ pixelScenesByPW: { '0,0': pixelScenes } });
  const scene = selected.find((scene: any) => scene.key === 'general/solid_wall_hidden_cavern');
  expect(scene).toMatchObject({ x: -3102, y: 0, variantKey: 'biome=general@solid_wall_hidden_cavern' });
  const raw = (sceneModule.PIXEL_SCENE_DATA as Record<string, any>)[scene.key];
  if (!compressed) expect(raw.imgElement).toBeNull();
  await sceneModule.ensureScenePixels(raw);
  const archive = await JSZip.loadAsync(await readFile(new URL('../public/data.zip', import.meta.url)));
  const background = await decodePngToRgba(await archive.file('data/weather_gfx/background_cave_02.png')!.async('arraybuffer'));
  const input = { scene, source: { data: raw.imgElement, width: raw.width, height: raw.height }, worldSize: 70, backdrop: background };
  const paint = (instance: any, source: any) => paintTerrainScene(instance, source, sceneModule);
  const pixels = renderNativeSceneBitmap(scene, input.source, paint, 70, background);
  // The production worker executes this core encoder. Use its actual PNG via
  // the compressed provider, which decodes native intersections per OSD tile.
  const encoded = compressed ? await createNativeSceneWorkerRenderer(async () => paint)(input) : undefined;
  if (compressed) {
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
    vi.stubGlobal('createImageBitmap', async (blob: Blob, sx: number, sy: number, sw: number, sh: number, options: ImageBitmapOptions) => {
      const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
      const bitmap = createCanvas(options.resizeWidth!, options.resizeHeight!) as any;
      const ctx = bitmap.getContext('2d'); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, bitmap.width, bitmap.height);
      bitmap.close = vi.fn(); return bitmap;
    });
  }
  const bitmap: any = createCanvas(512, 512), bitmapContext = bitmap.getContext('2d');
  const upload = bitmapContext.createImageData(512, 512); upload.data.set(pixels); bitmapContext.putImageData(upload, 0, 0);
  bitmap.close = vi.fn();
  vi.stubGlobal('OpenSeadragon', {
    pixelDensityRatio: 1,
    Point: class { constructor(public x: number, public y: number) {} },
    TileSource: class {
      maxLevel: number;
      constructor(options: any) { Object.assign(this, options); this.maxLevel = options.maxLevel; }
      getClosestLevel() { return this.maxLevel; }
      tileExists() { return true; }
    },
  });
  const layer = createPixelSceneTileSource({ items: [{ osdX: scene.x, osdY: scene.y,
    w: scene.width, h: scene.height, sceneKey: scene.key }],
    bitmapByKey: compressed ? new Map() : new Map([[scene.key, bitmap]]),
    blobByKey: encoded ? new Map([[scene.key, { blob: new Blob([encoded.png], {type: 'image/png'}), width: encoded.width, height: encoded.height }]]) : undefined,
    maxBitmapBytes: 512 * 512 * 4, generationId: 1 });
  try {
    const target = createCanvas(512, 512).getContext('2d');
    if (compressed) {
      expect(layer.source.__drawViewport).toBeUndefined();
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        expect(layer.source.tileExists(layer.source.maxLevel, x, y)).toBe(true);
        const tile = await new Promise<any>((resolve, reject) => layer.source.downloadTileStart({
          tile: {level: layer.source.maxLevel, x, y}, finish: resolve, fail: reject,
        }));
        target.drawImage(tile.canvas, x * 512 - 50, y * 512 - 50);
      }
      expect(layer.source.sceneTileStats.bitmapCache.decodes).toBe(4);
      expect(layer.source.sceneTileStats.bitmapCache.peakBytes).toBeLessThanOrEqual(512 * 512 * 4);
    } else layer.source.__drawViewport(target, {
      opacity: 1, imageToViewportCoordinates: (x: number, y: number) => ({ x: layer.originX + x, y: layer.originY + y }),
    }, { pixelFromPoint: (point: { x: number; y: number }) => ({ x: point.x - scene.x, y: point.y - scene.y }) });
    const displayed = target.getImageData(0, 0, 512, 512).data;
    let gold = 0;
    const colors = new Set<number>();
    for (let i = 0; i < raw.imgElement.length; i += 4) if (readRGBA(raw.imgElement, i) === 0xffebcd01) {
      expect(displayed[i + 3]).toBe(255);
      expect(readRGBA(displayed, i)).toBe(readRGBA(pixels, i));
      colors.add(readRGBA(displayed, i)); gold++;
    }
    expect(gold).toBe(628);
    expect(colors.size).toBeGreaterThan(1);
  } finally { layer.source.destroy(); vi.unstubAllGlobals(); }
});
