import Flatbush from 'flatbush';
import { loadTerrainBackgrounds } from './terrain-backgrounds';
import { createPlaneOwnership, sceneBiomeNames, BIOME_BACKGROUND_MAP } from './terrain-policy';
import type { GLTerrainGeneration, GLTerrainDeps } from './gl-terrain-tile-source';
import type { TerrainRect } from './terrain-viewport';
import type { ScenePixels } from './terrain-scenes';

export function rasterCanvas(image: ScenePixels): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(image.width, image.height);
  pixels.data.set(image.data); context.putImageData(pixels, 0, 0);
  return canvas;
}

/** Host-owned backdrops/static art stay separate from world cells. Work here
 * scales with screen pixels and visible chunks, never native world area. */
export async function createLiveBackground(gen: GLTerrainGeneration, deps: GLTerrainDeps) {
  const width = deps.getWorldSize(gen.isNGP, gen.gameMode);
  const ownership = createPlaneOwnership(gen.tileLayers, gen.biomeData.pixels,
    gen.biomeData.pixels, deps.GENERATOR_CONFIG, width);
  const scenes = gen.sceneData?.scenes ?? [];
  const backgroundName = (scene: typeof scenes[number]) => sceneBiomeNames(scene).find(name => BIOME_BACKGROUND_MAP[name]);
  const textures = await loadTerrainBackgrounds([...ownership.names,
    ...scenes.map(backgroundName).filter((n): n is string => !!n)]);
  const images = new Map([...textures].map(([name, texture]) => [name, rasterCanvas(texture)]));
  const maskImages = new WeakMap<Uint8Array, HTMLCanvasElement>();
  const masks = (gen.sceneData?.staticMasks ?? []).map(mask => {
    const image = (air: boolean) => {
      const bits = air ? mask.airBits : mask.bits;
      if (bits && maskImages.has(bits)) return maskImages.get(bits)!;
      const data = new Uint8ClampedArray(mask.width * mask.height * 4);
      for (let i = 0; i < data.length / 4; i++)
        if (bits && (bits[i >> 3] & (1 << (i & 7)))) data[i * 4 + 3] = 255;
      const value = rasterCanvas({ data, width: mask.width, height: mask.height });
      if (bits) maskImages.set(bits, value);
      return value;
    };
    return { ...mask, material: image(false), air: image(true) };
  });
  const art = new Map(Object.entries(gen.sceneData?.sources ?? {}).flatMap(([key, source]) =>
    source.backgroundArt ? [[key, rasterCanvas(source.backgroundArt)] as const] : []));
  const air = new Map<string, HTMLCanvasElement>();
  const airImage = (key: string) => {
    let value = air.get(key);
    if (value) return value;
    const source = gen.sceneData!.sources[key];
    const data = new Uint8ClampedArray(source.data.length);
    for (let i = 0; i < data.length; i += 4)
      if (source.data[i] === 0 && source.data[i + 1] === 0 && source.data[i + 2] === 66 && source.data[i + 3]) data[i + 3] = 255;
    value = rasterCanvas({ ...source, data }); air.set(key, value); return value;
  };
  const index = scenes.length ? new Flatbush(scenes.length) : null;
  for (const scene of scenes) {
    const image = art.get(scene.key);
    index!.add(scene.x, scene.y, scene.x + Math.max(scene.width, image?.width ?? 0), scene.y + Math.max(scene.height, image?.height ?? 0));
  }
  index?.finish();
  const covered = (scene: typeof scenes[number]) => {
    for (let y = Math.floor((scene.y + 7168) / 512); y <= Math.floor((scene.y + scene.height - 1 + 7168) / 512); y++)
      for (let x = Math.floor((scene.x + width * 256) / 512); x <= Math.floor((scene.x + scene.width - 1 + width * 256) / 512); x++)
        if (!images.has(ownership.names[ownership.at(x * 512 - width * 256, y * 512 - 7168)])) return false;
    return true;
  };
  const needsBackground = new Set(scenes.filter(scene => backgroundName(scene) && !covered(scene)));
  const surface = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  let cached: { key: string; background: HTMLCanvasElement; air: HTMLCanvasElement; material: HTMLCanvasElement } | undefined;
  const overlaps = (a: TerrainRect, b: TerrainRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  return (foreground: HTMLCanvasElement, bounds: TerrainRect, scale: number) => {
    const key = [bounds.x, bounds.y, bounds.width, bounds.height, scale, foreground.width, foreground.height].join('/');
    if (!cached || cached.key !== key) {
      const output = surface(foreground.width, foreground.height);
      const bg = output.getContext('2d')!;
      const layer = surface(output.width, output.height), scratch = layer.getContext('2d')!;
      const transform = (ctx: CanvasRenderingContext2D) => ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
      transform(bg); bg.imageSmoothingEnabled = false;
      const patterns = new Map([...images].map(([name, image]) => {
        const pattern = bg.createPattern(image, 'repeat')!;
        pattern.setTransform(new DOMMatrix().translate(-width * 256, -7168));
        return [name, pattern] as const;
      }));
      for (let cy = Math.max(0, Math.floor((bounds.y + 7168) / 512)); cy <= Math.min(47, Math.floor((bounds.y + bounds.height + 7168) / 512)); cy++)
        for (let cx = Math.floor((bounds.x + width * 256) / 512); cx <= Math.floor((bounds.x + bounds.width + width * 256) / 512); cx++) {
          const x = cx * 512 - width * 256, y = cy * 512 - 7168;
          const owner = ownership.at(x, y), pattern = patterns.get(ownership.names[owner]);
          if (pattern) { bg.fillStyle = pattern; bg.fillRect(x, y, 512, 512); }
        }
      for (const id of (index?.search(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height) ?? []).sort((a, b) => a - b)) {
        const scene = scenes[id];
        const image = art.get(scene.key);
          const name = backgroundName(scene), pattern = name && patterns.get(name);
        if (pattern && needsBackground.has(scene)) {
          // A carved room can own air without owning a procedural biome chunk.
          // Reuse one scratch surface, clipped to this room. Allocating a full
          // viewport for each of thousands of scenes made overview GC enormous.
          const clip = (ctx: CanvasRenderingContext2D) => {
            ctx.beginPath(); ctx.rect(scene.x, scene.y, scene.width, scene.height); ctx.clip();
          };
          scratch.save(); transform(scratch); clip(scratch); scratch.imageSmoothingEnabled = false;
          scratch.clearRect(scene.x, scene.y, scene.width, scene.height);
          scratch.drawImage(airImage(scene.key), scene.x, scene.y);
          scratch.globalCompositeOperation = 'source-in'; scratch.fillStyle = pattern;
          scratch.fillRect(scene.x, scene.y, scene.width, scene.height); scratch.restore();
          bg.save(); clip(bg); bg.resetTransform(); bg.globalCompositeOperation = 'destination-over'; bg.drawImage(layer, 0, 0); bg.restore();
        }
        if (image) bg.drawImage(image, scene.x, scene.y);
      }
      const air = surface(output.width, output.height), material = surface(output.width, output.height);
      const ac = air.getContext('2d')!, mc = material.getContext('2d')!;
      transform(ac); transform(mc); ac.imageSmoothingEnabled = mc.imageSmoothingEnabled = false;
      for (const mask of masks) if (overlaps(mask, bounds)) {
        ac.drawImage(mask.air, mask.x, mask.y); mc.drawImage(mask.material, mask.x, mask.y);
      }
      cached = { key, background: output, air, material };
    }
    const output = surface(foreground.width, foreground.height), bg = output.getContext('2d')!, fg = foreground.getContext('2d')!;
    fg.save(); fg.resetTransform(); fg.globalCompositeOperation = 'destination-out'; fg.drawImage(cached.air, 0, 0); fg.restore();
    bg.drawImage(cached.background, 0, 0); bg.drawImage(foreground, 0, 0);
    bg.globalCompositeOperation = 'destination-out'; bg.drawImage(cached.material, 0, 0);
    bg.globalCompositeOperation = 'source-over';
    return output;
  };
}
