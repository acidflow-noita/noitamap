import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { Canvas, createCanvas, ImageData } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { decodePngToRgba } from '../src/telescope/png-decode';
import * as policy from '../src/telescope/terrain-policy';
import * as backgrounds from '../src/telescope/terrain-backgrounds';

const archive = vi.hoisted(() => ({ zip: null as any }));
vi.mock('../src/data-archive', () => ({ getZip: async () => archive.zip }));

/** Exercise the actual bridge compositor with game PNGs and native Canvas,
 * without booting the browser UI or substituting a scene-rendering mock. */
function functions(path: string, names: string[], dependencies: Record<string, unknown>, setup = '') {
  const source = createSourceFile(path, readFileSync(path, 'utf8'), ScriptTarget.Latest);
  const selected = source.statements.filter(statement =>
    isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''));
  expect(selected).toHaveLength(names.length);
  const js = transpileModule(selected.map(statement => statement.getText(source).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${setup}\n${js}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}

let bridge: any;
const raw = new Map<string, ReturnType<typeof decodePngToRgba>>();
const bitmap = async (source: any) => {
  const result = createCanvas(source.width, source.height);
  const ctx = result.getContext('2d');
  if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
  else ctx.drawImage(source, 0, 0);
  return Object.assign(result, { close: () => { result.width = result.height = 0; } });
};

beforeAll(async () => {
  archive.zip = await JSZip.loadAsync(readFileSync('public/data.zip'));
  for (const name of ['friendroom', 'cavern'])
    raw.set(`general/${name}`, decodePngToRgba(new Uint8Array(readFileSync(`lib/noita-telescope/data/pixel_scenes/general/${name}.png`)).buffer));
  const telescope = functions('lib/noita-telescope/js/pixel_scene_generation.js', ['recolorPixelSceneForBiome', 'recolorPixelScene'], {
    appSettings: { recolorMaterials: true }, TILE_OVERLAY_COLORS: {}, BIOME_BACKGROUND_COLORS: {},
    MATERIAL_COLOR_CONVERSION: {}, PIXEL_SCENE_AIR_TRANSPARENCY_EXCEPTIONS: { friendroom: 255, cavern: 255 },
  });
  bridge = functions('src/telescope/telescope-osd-bridge.ts', [
    'getScenePngIndex', 'resolveScenePath', 'decodeScenePng', 'imgElementToBitmap',
    'sceneRenderKey', 'recolorSceneVariant', 'compositeSceneBitmap',
  ], {
    ...policy, ...telescope, decodePngToRgba, ImageData, HTMLCanvasElement: Canvas,
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
      if (path === './terrain-backgrounds') return backgrounds;
      throw new Error(`Unexpected compositor dependency: ${path}`);
    },
  }, 'let _pngIndex = null;');
});
afterEach(() => vi.restoreAllMocks());

it('does not mistake Friend material PNGs for visual artwork', async () => {
  const index = await bridge.getScenePngIndex();
  expect(index.visualByName.get('friendroom')).toBeUndefined();
  expect(index.visualByName.get('cavern')).toBeUndefined();
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
  for (const key of ['general/friendroom', 'general/cavern']) {
    const scene = { key, x: -8231, y: 931, variantKey: 'biome=general' };
    expect(bridge.sceneRenderKey(scene)).not.toBe(key);
    expect(bridge.sceneRenderKey(scene)).not.toBe(bridge.sceneRenderKey({ ...scene, x: scene.x + 1 }));
    expect(bridge.sceneRenderKey(scene)).not.toBe(bridge.sceneRenderKey({ ...scene, y: scene.y + 1 }));
  }
  expect(bridge.sceneRenderKey({ key: 'snowcastle/cavern', x: 2, y: 3 })).toBe('snowcastle/cavern');
  expect(bridge.sceneRenderKey({ key: 'coalmine/oiltank', variantKey: 'biome=coalmine&f0bbee=123456' })).toBe('coalmine/oiltank|f0bbee=123456');
});
