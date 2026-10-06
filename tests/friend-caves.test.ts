import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { Canvas, createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { decodePngToRgba } from '../src/telescope/png-decode';
import * as policy from '../src/telescope/terrain-policy';
import * as backgrounds from '../src/telescope/terrain-backgrounds';
import * as goldRoom from '../src/telescope/captured-gold-room';
import type { PixelScene } from '../src/telescope/telescope-adapter';
import { prepareAssetJobs } from '../src/telescope/background-idle';
import { SceneBitmapCache } from '../src/telescope/scene-bitmap-cache';
import { MATERIAL_COLOR_CONVERSION, MATERIAL_WANG_COLORS } from '../lib/noita-telescope/js/potion_config.js';

const archive = { zip: null as any };

/** Exercise the actual bridge compositor with game PNGs and native Canvas,
 * without booting the browser UI or substituting a scene-rendering mock. */
function functions(path: string, names: string[], dependencies: Record<string, unknown>, setup = '') {
  const source = createSourceFile(path, readFileSync(path, 'utf8'), ScriptTarget.Latest);
  const selected = source.statements.filter(statement =>
    isFunctionDeclaration(statement) ? names.includes(statement.name?.text ?? '') :
      isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(source))));
  expect(selected).toHaveLength(names.length);
  const js = transpileModule(selected.map(statement => statement.getText(source).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${setup}\n${js}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}

let bridge: any;
const raw = new Map<string, ReturnType<typeof decodePngToRgba>>();
const bitmap = async (source: any) => {
  if (source instanceof Blob) source = await loadImage(Buffer.from(await source.arrayBuffer()));
  const result = createCanvas(source.width, source.height);
  const ctx = result.getContext('2d');
  if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
  else ctx.drawImage(source, 0, 0);
  return Object.assign(result, { close: () => { result.width = result.height = 0; } });
};

beforeAll(async () => {
  archive.zip = await JSZip.loadAsync(readFileSync('public/data.zip'));
  const { makeBlackTransparent } = functions('lib/noita-telescope/js/image_processing.js', ['makeBlackTransparent'], {});
  for (const name of ['friendroom', 'cavern', 'solid_wall_hidden_cavern']) {
    const pixels = decodePngToRgba(new Uint8Array(readFileSync(`lib/noita-telescope/data/pixel_scenes/general/${name}.png`)).buffer);
    // Both forks apply this before exposing a material scene to the host.
    makeBlackTransparent(pixels.data);
    raw.set(`general/${name}`, pixels);
  }
  const telescope = functions('lib/noita-telescope/js/pixel_scene_generation.js', ['recolorPixelSceneForBiome', 'recolorPixelScene'], {
    appSettings: { recolorMaterials: true }, TILE_OVERLAY_COLORS: {}, BIOME_BACKGROUND_COLORS: {},
    MATERIAL_COLOR_CONVERSION, PIXEL_SCENE_AIR_TRANSPARENCY_EXCEPTIONS: { friendroom: 255, cavern: 255, solid_wall_hidden_cavern: 255 },
  });
  const terrainBackgrounds = functions('src/telescope/terrain-backgrounds.ts', ['loadTerrainBackgrounds'], {
    decodePngToRgba, BIOME_BACKGROUND_MAP: policy.BIOME_BACKGROUND_MAP,
    require: (path: string) => {
      if (path === '../data-archive') return { getZip: async () => archive.zip };
      throw new Error(`Unexpected background dependency: ${path}`);
    },
  }, 'const textures = new Map();');
  bridge = functions('src/telescope/telescope-osd-bridge.ts', [
    'getScenePngIndex', 'resolveScenePath', 'decodeScenePng', 'imgElementToBitmap',
    'sceneRenderKey', 'recolorSceneVariant', 'compositeSceneBitmap',
  ], {
    ...policy, ...telescope, ...goldRoom, decodePngToRgba, ImageData, HTMLCanvasElement: Canvas,
    OffscreenCanvas: class {
      constructor(width: number, height: number) {
        const canvas = createCanvas(width, height);
        return Object.assign(canvas, { convertToBlob: async () => new Blob([new Uint8Array(await canvas.encode('png'))]) });
      }
    },
    createImageBitmap: bitmap,
    getDataZip: async () => archive.zip,
    ensurePixelSceneData: async (key: string) => ({ ...raw.get(key), imgElement: raw.get(key)?.data }),
    getPixelSceneImgElement: (key: string) => raw.get(key)?.data,
    pixelSceneConfig: { layerOverrides: {}, layers: { background: true, mid: true, visual: true } },
    TEMPLE_SPAWN_STRIP_COLORS: new Set(),
    require: (path: string) => {
      if (path === './terrain-backgrounds') return { ...backgrounds, ...terrainBackgrounds };
      throw new Error(`Unexpected compositor dependency: ${path}`);
    },
  }, 'let _pngIndex = null;');
});
afterEach(() => vi.restoreAllMocks());

it('does not mistake Friend material PNGs for visual artwork', async () => {
  const index = await bridge.getScenePngIndex();
  expect(index.visualByName.get('friendroom')).toBeUndefined();
  expect(index.visualByName.get('cavern')).toBeUndefined();
  expect(index.visualByName.get('solid_wall_hidden_cavern')).toBeUndefined();
  expect(index.bgByName.get('cavern')).toBe('data/biome_impl/cavern_background.png');
});

it.each(['friendroom', 'cavern'])('fills only carved air in %s with correctly phased native background pixels', async name => {
  const key = `general/${name}`, material = raw.get(key)!;
  const cave = decodePngToRgba(await archive.zip.file('data/weather_gfx/background_cave_02.png').async('arraybuffer'));
  const art = name === 'cavern'
    ? decodePngToRgba(await archive.zip.file('data/biome_impl/cavern_background.png').async('arraybuffer')) : null;
  const snapshots: Buffer[] = [];
  for (const position of [{ x: -8231, y: 931 }, { x: 27617, y: 1997 }]) {
    const scene = { key, name, variantKey: 'biome=general', ...position, ...material, imgElement: material.data };
    const result = await bridge.compositeSceneBitmap(key, scene, await bridge.getScenePngIndex());
    expect(result).not.toBeNull();
    try {
      const actual = result.bitmap.getContext('2d').getImageData(0, 0, 512, 512).data;
      const expected = createCanvas(512, 512), ctx = expected.getContext('2d');
      // Independent image composition: tile the game's backdrop in world
      // coordinates, then paint its authored room background at native size.
      const texture = await bitmap(new ImageData(cave.data, cave.width, cave.height));
      const offsetX = ((position.x + 17920) % cave.width + cave.width) % cave.width;
      const offsetY = ((position.y + 7168) % cave.height + cave.height) % cave.height;
      for (let y = -offsetY; y < 512; y += cave.height)
        for (let x = -offsetX; x < 512; x += cave.width) ctx.drawImage(texture, x, y);
      if (art) {
        const foreground = await bitmap(new ImageData(art.data, art.width, art.height));
        ctx.drawImage(foreground, 0, 0); foreground.close();
      }
      texture.close();
      const reference = ctx.getImageData(0, 0, 512, 512).data;
      let compared = 0, mismatches = 0;
      for (let i = 0; i < material.data.length; i += 4) {
        if (material.data[i] || material.data[i + 1] || material.data[i + 2] !== 66 || !material.data[i + 3]) continue;
        compared++;
        for (let c = 0; c < 4; c++) if (Math.abs(actual[i + c] - reference[i + c]) > 1) mismatches++;
      }
      expect(compared).toBeGreaterThan(60_000);
      expect(mismatches).toBe(0);
      expect([...actual.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
      snapshots.push(Buffer.from(actual));
    } finally { result.bitmap.close(); }
  }
  expect(snapshots[0].equals(snapshots[1])).toBe(false);
});

it('isolates corrected, placement-specific room caches without changing unrelated scene keys', () => {
  for (const key of ['general/friendroom', 'general/cavern', 'general/solid_wall_hidden_cavern']) {
    const scene = { key, x: -8231, y: 931, variantKey: 'biome=general' };
    expect(bridge.sceneRenderKey(scene)).not.toBe(key);
    expect(bridge.sceneRenderKey(scene)).not.toBe(bridge.sceneRenderKey({ ...scene, x: scene.x + 1 }));
    expect(bridge.sceneRenderKey(scene)).not.toBe(bridge.sceneRenderKey({ ...scene, y: scene.y + 1 }));
  }
  expect(bridge.sceneRenderKey({ key: 'snowcastle/cavern', x: 2, y: 3 })).toBe('snowcastle/cavern');
  expect(bridge.sceneRenderKey({ key: 'coalmine/oiltank', variantKey: 'biome=coalmine&f0bbee=123456' })).toBe('coalmine/oiltank|f0bbee=123456');
});

it('keeps the gold cavern scene while still excluding baked rooms', () => {
  let simplistic = false;
  const { renderableScenes } = functions('src/telescope/telescope-osd-bridge.ts',
    ['pixelSceneConfig', 'getSceneCategory', 'renderableScenes'], { ...goldRoom, isSimplisticBackground: () => simplistic });
  const cavern = { key: 'general/solid_wall_hidden_cavern', name: 'solid_wall_hidden_cavern', x: -4126, y: 11264, width: 512, height: 512 };
  const baked = { ...cavern, key: 'general/dragoncave', name: 'dragoncave' };
  const captured = { ...cavern, x: -3102, y: 0 };
  expect(renderableScenes({ worldSize: 70, pixelScenesByPW: { '0,0': [cavern, baked, captured] } })).toEqual([cavern]);
  simplistic = true;
  expect(renderableScenes({ worldSize: 70, pixelScenesByPW: { '0,0': [captured] } })).toEqual([captured]);
});

it('keeps sky and hell shop colours separate while sharing each variant across worlds and seeds', () => {
  const key = 'general/the_end_shop';
  const sky = { key, variantKey: 'biome=the_sky', x: 0, y: -13954 };
  const hell = { key, variantKey: 'biome=the_end', x: 0, y: 24576 };
  const skyKey = bridge.sceneRenderKey(sky, 1), hellKey = bridge.sceneRenderKey(hell, 1);
  expect(skyKey).not.toBe(hellKey);
  for (const variant of [sky, hell, { key }]) expect(bridge.sceneRenderKey(variant, 1)).not.toBe(key);
  expect(bridge.sceneRenderKey({ ...sky, x: -35840 }, 42)).toBe(skyKey);
  expect(bridge.sceneRenderKey({ ...hell, x: 35840 }, 99)).toBe(hellKey);
  expect(bridge.sceneRenderKey({ key, variantKey: 'f0bbee=123456&biome=the_sky' }, 1)).not.toBe(skyKey);
  expect(bridge.sceneRenderKey({ key: 'coalmine/oiltank', variantKey: 'biome=coalmine' }, 1)).toBe('coalmine/oiltank');
});

it('paints every authored gold pixel and fills only the carved air of the Ancient Laboratory stash', async () => {
  const key = 'general/solid_wall_hidden_cavern', material = raw.get(key)!;
  const scene = { key, name: 'solid_wall_hidden_cavern', variantKey: 'biome=general@solid_wall_hidden_cavern',
    x: -3102, y: 0, ...material, imgElement: material.data };
  const result = await bridge.compositeSceneBitmap(key, scene, await bridge.getScenePngIndex());
  expect(result).not.toBeNull();
  try {
    const actual = result.bitmap.getContext('2d').getImageData(0, 0, 512, 512).data;
    const goldWang = parseInt((MATERIAL_WANG_COLORS as Record<string, string>).gold.slice(2), 16);
    const gold = (MATERIAL_COLOR_CONVERSION as Record<number, number>)[goldWang];
    expect(gold).toBeTypeOf('number');
    const cave = decodePngToRgba(await archive.zip.file('data/weather_gfx/background_cave_02.png').async('arraybuffer'));
    let goldPixels = 0, airPixels = 0, outsidePixels = 0;
    for (let i = 0; i < material.data.length; i += 4) {
      const color = (material.data[i] << 16) | (material.data[i + 1] << 8) | material.data[i + 2];
      if (material.data[i + 3] && color === goldWang) {
        goldPixels++;
        expect([...actual.subarray(i, i + 4)]).toEqual([(gold >>> 16) & 255, (gold >>> 8) & 255, gold & 255, 255]);
      } else if (material.data[i + 3] && color === 0x42) {
        airPixels++;
        const x = scene.x + (i / 4) % 512 + 17920, y = scene.y + Math.floor(i / 4 / 512) + 7168;
        const at = (((y % cave.height + cave.height) % cave.height) * cave.width + ((x % cave.width + cave.width) % cave.width)) * 4;
        expect([...actual.subarray(i, i + 4)]).toEqual([...cave.data.subarray(at, at + 4)]);
      } else if (!material.data[i + 3]) {
        outsidePixels++;
        expect(actual[i + 3]).toBe(0);
      }
    }
    expect(goldPixels).toBeGreaterThan(100);
    expect(airPixels).toBeGreaterThan(100);
    expect(outsidePixels).toBeGreaterThan(100_000);
  } finally { result.bitmap.close(); }
});

it('repairs only the captured upper gold room when the selected scene moves elsewhere', () => {
  const material = raw.get(goldRoom.GOLD_ROOM_KEY)!;
  const selected = (pw: number, y: number): PixelScene => ({
    key: goldRoom.GOLD_ROOM_KEY, name: 'solid_wall_hidden_cavern',
    x: (y === 22 * 512 ? -4126 : y === 17 * 512 ? 2530 : -3102) + pw * 35840, y,
    width: material.width, height: material.height, imgElement: material.data,
  });
  expect(goldRoom.capturedGoldRepairs([-1, 0, 1].map(pw => selected(pw, 0)), 70)).toEqual([]);
  expect(goldRoom.capturedGoldRepairs([selected(0, 11264)], 64)).toEqual([]);
  expect(goldRoom.capturedGoldRepairs([{ ...selected(0, 11264), key: 'general/cavern' }], 70)).toEqual([]);
  expect(goldRoom.capturedGoldRepairs([{ ...selected(0, 11264), y: 11264 + 24576 }], 70)).toEqual([]);
  for (const y of [8192, 8704, 11264]) {
    const scenes = [-1, 0, 1].map(pw => selected(pw, y));
    const copies = scenes.map(scene => ({ ...scene }));
    const repairs = goldRoom.capturedGoldRepairs([...scenes, scenes[0]], 70);
    expect(repairs.map(({ x, y }) => ({ x, y }))).toEqual([-1, 0, 1].map(pw => ({ x: -3122 + pw * 35840, y: -20 })));
    expect(new Set(repairs.map(scene => bridge.sceneRenderKey(scene))).size).toBe(3);
    expect(scenes.map(({ imgElement, ...scene }) => scene)).toEqual(copies.map(({ imgElement, ...scene }) => scene));
    expect(scenes.every(scene => scene.imgElement === material.data)).toBe(true);
  }
});

it('caches the repair through the real scene builder and omits it with the simplistic background', async () => {
  const warnings = vi.spyOn(console, 'warn');
  const cache = new Map<string, { blob: Blob; width: number; height: number }>();
  let simplistic = false;
  const composite = vi.fn(bridge.compositeSceneBitmap);
  const { buildSceneBitmaps } = functions('src/telescope/telescope-osd-bridge.ts', ['buildSceneBitmaps'], {
    ...goldRoom, isSimplisticBackground: () => simplistic, prepareAssetJobs,
    renderableScenes: (result: any) => Object.values(result.pixelScenesByPW).flat(),
    sceneRenderKey: bridge.sceneRenderKey, getScenePngIndex: bridge.getScenePngIndex,
    compositeSceneBitmap: composite, createImageBitmap: bitmap,
    getCachedSceneBitmapsBulk: async (keys: string[]) => new Map(keys.filter(key => cache.has(key)).map(key => [key, cache.get(key)])),
    cacheSceneBitmap: async (key: string, blob: Blob, width: number, height: number) => { cache.set(key, { blob, width, height }); },
  });
  const material = raw.get(goldRoom.GOLD_ROOM_KEY)!;
  const scenes = [-1, 0, 1].map(pw => ({
    key: goldRoom.GOLD_ROOM_KEY, name: 'solid_wall_hidden_cavern',
    x: -4126 + pw * 35840, y: 11264, width: 512, height: 512, imgElement: material.data,
  }));
  const result = { worldSize: 70, pixelScenesByPW: { '0,0': scenes } };
  for (let pass = 0; pass < 3; pass++) {
    simplistic = pass === 2;
    const built = await buildSceneBitmaps(result, null);
    try {
      expect(built.validScenes).toHaveLength(simplistic ? 3 : 6);
      expect(built.bitmapByKey.size).toBe(simplistic ? 3 : 6);
      expect(composite).toHaveBeenCalledTimes(6); // both subsequent passes decode cached PNGs
      expect(scenes).toHaveLength(3); // never inject repair scenes into generation/POI metadata
    } finally { for (const image of built.bitmapByKey.values()) image.close(); }
  }
  expect(warnings).not.toHaveBeenCalled();
});

it('reuses native room artwork across live seeds without closing the incoming layer or changing export pixels', async () => {
  const memory = new SceneBitmapCache(), disk = new Map<string, { blob: Blob; width: number; height: number }>();
  const composite = vi.fn(bridge.compositeSceneBitmap), decode = vi.fn(bitmap);
  const read = vi.fn(async (keys: string[]) => new Map(keys.filter(key => disk.has(key)).map(key => [key, disk.get(key)])));
  vi.stubGlobal('currentGenerationId', 1);
  const { buildSceneBitmaps } = functions('src/telescope/telescope-osd-bridge.ts', ['buildSceneBitmaps'], {
    ...goldRoom, isSimplisticBackground: () => false, prepareAssetJobs, liveSceneBitmaps: memory,
    renderableScenes: (result: any) => Object.values(result.pixelScenesByPW).flat(),
    sceneRenderKey: bridge.sceneRenderKey, getScenePngIndex: bridge.getScenePngIndex,
    compositeSceneBitmap: composite, createImageBitmap: decode, getCachedSceneBitmapsBulk: read,
    cacheSceneBitmap: async (key: string, blob: Blob, width: number, height: number) => { disk.set(key, { blob, width, height }); },
  });
  const material = raw.get(goldRoom.GOLD_ROOM_KEY)!;
  const scenes = [-1, 0, 1].map(pw => ({ key: goldRoom.GOLD_ROOM_KEY, name: 'solid_wall_hidden_cavern',
    x: -4126 + pw * 35840, y: 11264, width: 512, height: 512, imgElement: material.data }));
  const generation = { worldSize: 70, pixelScenesByPW: { '0,0': scenes } };
  let old: any, next: any, exported: any;
  const pixels = (image: any) => Buffer.from(image.getContext('2d').getImageData(0, 0, image.width, image.height).data);
  try {
    old = await buildSceneBitmaps(generation, 1);
    const images = new Map<string, any>(old.bitmapByKey), expected = new Map([...images].map(([key, image]) => [key, pixels(image)]));
    const closes = [...images.values()].map(image => vi.spyOn(image, 'close'));
    vi.stubGlobal('currentGenerationId', 2);
    next = await buildSceneBitmaps(generation, 2);
    expect(composite).toHaveBeenCalledTimes(6);
    expect(read).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    for (const [key, image] of next.bitmapByKey) expect(image).toBe(images.get(key));
    old.release(); memory.clear();
    for (const [key, image] of next.bitmapByKey) expect(pixels(image).equals(expected.get(key)!)).toBe(true);
    for (const close of closes) expect(close).not.toHaveBeenCalled();
    next.release();
    for (const close of closes) expect(close).toHaveBeenCalledOnce();

    // The offline export still decodes its own images from the disk cache.
    exported = await buildSceneBitmaps(generation, null);
    expect(decode).toHaveBeenCalledTimes(6);
    expect(memory.stats.bytes).toBe(0);
    for (const [key, image] of exported.bitmapByKey) expect(pixels(image).equals(expected.get(key)!)).toBe(true);
  } finally {
    old?.release(); next?.release(); exported?.release(); memory.clear(); vi.unstubAllGlobals();
  }
});

it.each(['cancelled', 'failed'])('releases a late decoded image after its scene preparation is %s', async outcome => {
  const memory = new SceneBitmapCache(), blob = new Blob(['cached scene']);
  const late = await bitmap(new ImageData(4, 4)), close = vi.spyOn(late, 'close');
  let finish!: (image: any) => void, fail!: (error: Error) => void;
  const waiting = new Promise<any>(resolve => { finish = resolve; });
  const broken = new Promise<any>((_resolve, reject) => { fail = reject; });
  // Only the failed case starts a second concurrent decode that rejects.
  void broken.catch(() => {});
  const decode = vi.fn((value: Blob) => value === blob ? waiting : broken);
  const keys = outcome === 'failed' ? ['late', 'broken'] : ['late'];
  vi.stubGlobal('currentGenerationId', 1);
  const { buildSceneBitmaps } = functions('src/telescope/telescope-osd-bridge.ts', ['buildSceneBitmaps'], {
    isSimplisticBackground: () => true, prepareAssetJobs, liveSceneBitmaps: memory,
    renderableScenes: () => keys.map(key => ({ key, name: key, width: 4, height: 4, x: 0, y: 0 })),
    sceneRenderKey: (scene: any) => scene.key, getScenePngIndex: async () => ({}),
    compositeSceneBitmap: async () => { throw new Error('Scene preparation failed'); },
    createImageBitmap: decode,
    getCachedSceneBitmapsBulk: async () => new Map(keys.map(key => [key, { blob: key === 'late' ? blob : new Blob() }])),
    cacheSceneBitmap: vi.fn(),
  });
  try {
    const pending = buildSceneBitmaps({ worldSize: 70 }, 1);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(keys.length));
    if (outcome === 'failed') {
      const rejected = expect(pending).rejects.toThrow('Scene preparation failed');
      fail(new Error('Cannot decode cached PNG')); await rejected;
    } else {
      vi.stubGlobal('currentGenerationId', 2); memory.clear();
    }
    finish(late);
    if (outcome === 'cancelled') expect(await pending).toBeNull();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(memory.stats.bytes).toBe(0);
  } finally { finish(late); memory.clear(); vi.unstubAllGlobals(); }
});

it('releases late scene ownership when the layer module fails to load', async () => {
  let finish!: (value: any) => void;
  const work = new Promise(resolve => { finish = resolve; }), release = vi.fn();
  const { addPixelScenes } = functions('src/telescope/telescope-osd-bridge.ts', ['addPixelScenes'], {
    pixelSceneConfig: { enabled: true }, buildSceneBitmaps: () => work,
    require: () => { throw new Error('Scene layer module unavailable'); },
  });
  await expect(addPixelScenes({}, { pixelScenesByPW: {} }, 1)).rejects.toThrow('Scene layer module unavailable');
  finish({ release });
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
});

it.each([['middle', 0], ['left', -1], ['right', 1]] as const)(
  'removes the captured %s-world cave with matching EDR texels and preserves surrounding map pixels', async (world, pw) => {
    const material = raw.get(goldRoom.GOLD_ROOM_KEY)!;
    const [scene] = goldRoom.capturedGoldRepairs([{
      key: goldRoom.GOLD_ROOM_KEY, name: 'solid_wall_hidden_cavern',
      x: -4126 + pw * 35840, y: 11264, width: 512, height: 512, imgElement: material.data,
    }], 70);
    const result = await bridge.compositeSceneBitmap(scene.key, scene, await bridge.getScenePngIndex());
    try {
      const captured = await loadImage(readFileSync(`tests/fixtures/captured-gold/${world}.webp`));
      const canvas = createCanvas(captured.width, captured.height), ctx = canvas.getContext('2d');
      ctx.drawImage(captured, 0, 0);
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // The published DZI tile is at (-3072,0) plus the PW offset, with 2px overlap.
      const baseX = -3074 + pw * 35840, baseY = -2;
      ctx.drawImage(result.bitmap, scene.x - baseX, scene.y - baseY);
      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const texture = decodePngToRgba(await archive.zip.file('data/materials_gfx/rock_hard_border.png').async('arraybuffer'));
      const patch = result.bitmap.getContext('2d').getImageData(0, 0, scene.width, scene.height).data;
      let painted = 0, changes = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const px = x + baseX - scene.x, py = y + baseY - scene.y;
        const alpha = px >= 0 && py >= 0 && px < scene.width && py < scene.height
          ? patch[(py * scene.width + px) * 4 + 3] : 0;
        if (!alpha) {
          if (!Buffer.from(before.subarray(i, i + 4)).equals(Buffer.from(after.subarray(i, i + 4)))) changes++;
        } else {
          painted++;
          const color = backgrounds.textureColor(texture, baseX + x, baseY + y);
          expect([...after.subarray(i, i + 4)]).toEqual([(color >>> 16) & 255, (color >>> 8) & 255, color & 255, color >>> 24]);
        }
      }
      expect(changes).toBe(0);
      expect(painted).toBeGreaterThan(10_000);
      expect(painted).toBeLessThan(30_000);
      // Includes the captured air pocket, gold and visible rock-edge decals.
      for (let y = 170; y < 280; y++) for (let x = 20; x < 170; x++) {
        const i = ((y + 2) * canvas.width + x + 2) * 4;
        const color = backgrounds.textureColor(texture, baseX + x + 2, y);
        expect([...after.subarray(i, i + 4)]).toEqual([(color >>> 16) & 255, (color >>> 8) & 255, color & 255, 255]);
      }
    } finally { result.bitmap.close(); }
  });
