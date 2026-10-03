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
  const masks = (gen.sceneData?.staticMasks ?? []).map(mask => {
    const image = (air: boolean) => {
      const data = new Uint8ClampedArray(mask.width * mask.height * 4);
      const bits = air ? mask.airBits : mask.bits;
      for (let i = 0; i < data.length / 4; i++)
        if (bits && (bits[i >> 3] & (1 << (i & 7)))) data[i * 4 + 3] = 255;
      return rasterCanvas({ data, width: mask.width, height: mask.height });
    };
    return { ...mask, material: image(false), air: image(true) };
  });
  const art = new Map(Object.entries(gen.sceneData?.sources ?? {}).flatMap(([key, source]) =>
    source.backgroundArt ? [[key, rasterCanvas(source.backgroundArt)] as const] : []));
  const air = new Map(Object.entries(gen.sceneData?.sources ?? {}).map(([key, source]) => {
    const data = new Uint8ClampedArray(source.data.length);
    for (let i = 0; i < data.length; i += 4)
      if (source.data[i] === 0 && source.data[i + 1] === 0 && source.data[i + 2] === 66 && source.data[i + 3]) data[i + 3] = 255;
    return [key, rasterCanvas({ ...source, data })] as const;
  }));
  const overlaps = (a: TerrainRect, b: TerrainRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  return (foreground: HTMLCanvasElement, bounds: TerrainRect, scale: number) => {
    const output = document.createElement('canvas');
    output.width = foreground.width; output.height = foreground.height;
    const bg = output.getContext('2d')!, fg = foreground.getContext('2d')!;
    const layer = document.createElement('canvas'); layer.width = output.width; layer.height = output.height;
    const scratch = layer.getContext('2d')!;
    const transform = (ctx: CanvasRenderingContext2D) => ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
    transform(bg); transform(fg);
    bg.imageSmoothingEnabled = fg.imageSmoothingEnabled = false;
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
    for (const scene of scenes) {
      const image = art.get(scene.key);
      if (!overlaps({ ...scene, width: Math.max(scene.width, image?.width ?? 0), height: Math.max(scene.height, image?.height ?? 0) }, bounds)) continue;
      const name = backgroundName(scene), pattern = name && patterns.get(name);
      if (pattern) {
        // A carved room can own air without owning a procedural biome chunk.
        // Reuse one scratch surface, clipped to this room. Allocating a full
        // viewport for each of thousands of scenes made overview GC enormous.
        const clip = (ctx: CanvasRenderingContext2D) => {
          ctx.beginPath(); ctx.rect(scene.x, scene.y, scene.width, scene.height); ctx.clip();
        };
        scratch.save(); transform(scratch); clip(scratch); scratch.imageSmoothingEnabled = false;
        scratch.clearRect(scene.x, scene.y, scene.width, scene.height);
        scratch.drawImage(air.get(scene.key)!, scene.x, scene.y);
        scratch.globalCompositeOperation = 'source-in'; scratch.fillStyle = pattern;
        scratch.fillRect(scene.x, scene.y, scene.width, scene.height); scratch.restore();
        bg.save(); clip(bg); bg.resetTransform(); bg.drawImage(layer, 0, 0); bg.restore();
      }
      if (image) bg.drawImage(image, scene.x, scene.y);
    }
    fg.globalCompositeOperation = 'destination-out';
    for (const mask of masks) if (overlaps(mask, bounds)) fg.drawImage(mask.air, mask.x, mask.y);
    fg.globalCompositeOperation = 'source-over'; fg.resetTransform();
    bg.resetTransform(); bg.drawImage(foreground, 0, 0); transform(bg);
    bg.globalCompositeOperation = 'destination-out';
    for (const mask of masks) if (overlaps(mask, bounds)) bg.drawImage(mask.material, mask.x, mask.y);
    bg.globalCompositeOperation = 'source-over'; bg.resetTransform();
    return output;
  };
}
