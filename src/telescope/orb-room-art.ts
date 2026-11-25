import { ensurePixelSceneData, type PixelScene } from './telescope-adapter';
import { decodePngToRgba } from './png-decode';
import { readTelescopeAsset } from './telescope-assets';
import { compositeTerrain, loadTerrainBackgrounds, textureColor } from './terrain-backgrounds';
import { loadSceneMaterialPainter, readRGBA, writeRGBA, type ScenePixels } from './terrain-scenes';
import { NG_PLUS_ORB_BACKGROUNDS, WORLD_TOP } from './terrain-policy';

const roomKey = 'general/orbroom';
const upperKey = 'general/orbroom#upper';
const floorKey = 'general/orbroom#floor';
const previewKey = 'general/orbroom#preview';

type Layers = { background: boolean; mid: boolean; visual: boolean };
type Placement = Pick<PixelScene, 'key' | 'variantKey' | 'x' | 'y'>;

async function loadArt() {
  const png = async (name: string) => {
    const file = await readTelescopeAsset(`data/biome_impl/${name}.png`);
    if (!file) throw new Error(`Missing orb-room artwork: ${name}`);
    return decodePngToRgba(await file.arrayBuffer());
  };
  const [raw, background, visual] = await Promise.all([
    ensurePixelSceneData(roomKey, { art: false }), png('orbroom_background'), png('orbroom_visual'),
  ]);
  if (!raw?.imgElement || !ArrayBuffer.isView(raw.imgElement)) throw new Error('Missing orb-room material pixels');
  const material = raw.imgElement as Uint8Array;
  const { width, height } = background;
  if (raw.width !== width || raw.height !== height || visual.width !== width || visual.height !== height)
    throw new Error('Orb-room material and artwork dimensions differ');
  // The unoccupied upper rows are the same picture at every placement. Retain
  // one copy even when a bottom-row room repeats throughout the Hell plane.
  const firstMaterial = material.findIndex((alpha, i) => (i & 3) === 3 && alpha !== 0);
  if (firstMaterial < 0) throw new Error('Empty orb-room material template');
  const floorTop = Math.floor(firstMaterial / (4 * width));
  const offset = floorTop * width * 4;
  const crop = (image: ScenePixels) => ({ data: image.data.subarray(offset), width, height: height - floorTop });
  return { width, height, floorTop, background, visual,
    floor: { data: material.subarray(offset), width, height: height - floorTop, skipEdgeTextures: !!raw.skipEdgeTextures },
    floorVisual: crop(visual) };
}

let ready: ReturnType<typeof loadArt> | undefined;
function assets() {
  return ready ??= loadArt().catch(error => { ready = undefined; throw error; });
}

/** These sections are only draw commands. The game scene and POI records keep their original positions. */
export async function splitOrbRoomArt(scenes: PixelScene[]): Promise<PixelScene[]> {
  const { floorTop } = await assets();
  const draws: PixelScene[] = [];
  for (const scene of scenes) {
    if (scene.key === roomKey) {
      if (floorTop) draws.push({ ...scene, key: upperKey, height: floorTop });
      draws.push({ ...scene, key: floorKey, y: scene.y + floorTop, height: scene.height - floorTop });
    } else draws.push(scene);
  }
  return draws;
}

export async function renderOrbRoomArt(scene: Placement, seed: number, layers: Layers) {
  const art = await assets();
  const onlyUpper = scene.key === upperKey, preview = scene.key === previewKey;
  const onlyFloor = scene.key === floorKey || preview;
  const y0 = onlyFloor ? art.floorTop : 0;
  const height = onlyUpper ? art.floorTop : art.height - y0;
  const width = art.width;
  const canvas = new OffscreenCanvas(width, height);
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const out = ctx.createImageData(width, height);
    const offset = y0 * width * 4;
    if (layers.background) out.data.set(art.background.data.subarray(offset, offset + out.data.length));
    if (!onlyUpper && !preview && layers.mid) {
      const placed = { ...scene, key: roomKey, name: 'orbroom', x: scene.x,
        y: onlyFloor ? scene.y : scene.y + art.floorTop, width, height: art.floor.height };
      const source = { ...art.floor, visualArt: layers.visual ? art.floorVisual : null };
      const [paint, { paintSceneEdges }] = await Promise.all([loadSceneMaterialPainter(), import('./scene-material-edges')]);
      const painted = paint(placed, source);
      const material = new Uint8ClampedArray(painted.pixels.buffer, painted.pixels.byteOffset, painted.pixels.byteLength);
      await paintSceneEdges(material, placed, source, seed);
      const biome = (scene.variantKey ?? '').split('&').find(p => p.startsWith('biome='))?.slice(6).split('@').pop();
      const texture = layers.background && biome && NG_PLUS_ORB_BACKGROUNDS[biome]
        ? (await loadTerrainBackgrounds([biome])).get(biome) : undefined;
      const start = (art.floorTop - y0) * width * 4;
      for (let i = 0; i < material.length; i += 4) {
        if (!source.data[i + 3]) continue;
        let bg = readRGBA(out.data, start + i);
        if (texture && material[i + 3] < 255 && (bg >>> 24) < 255) {
          const x = placed.x + (i / 4) % width, y = placed.y + Math.floor(i / 4 / width);
          bg = compositeTerrain(bg, textureColor(texture, x + 32 * 512, y - WORLD_TOP));
        }
        writeRGBA(out.data, start + i, compositeTerrain(readRGBA(material, i), bg));
      }
    } else if (layers.visual) {
      for (let i = 0; i < out.data.length; i += 4)
        if (art.visual.data[offset + i + 3])
          writeRGBA(out.data, i, compositeTerrain(readRGBA(art.visual.data, offset + i), readRGBA(out.data, i)));
    }
    ctx.putImageData(out, 0, 0);
    const bitmap = await createImageBitmap(canvas);
    const blob = await canvas.convertToBlob({ type: 'image/png' }).catch(() => null);
    return { bitmap, blob, width, height, kind: 'composite' as const };
  } finally {
    canvas.width = canvas.height = 0;
  }
}
