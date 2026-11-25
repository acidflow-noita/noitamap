import { generateDynamicMap } from '../../src/telescope/telescope-adapter';
import { getDataZip } from '../../src/data-archive';
import { decodePngToRgba } from '../../src/telescope/png-decode';
// @ts-ignore -- the fixture build exposes the real scene batch and cache keys.
import { __warmSceneBuild, sceneRenderKey } from '../../src/telescope/telescope-osd-bridge';

async function patchHash(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const bytes = ctx.getImageData(x, y, w, h).data;
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function checkOrbRoomFloors() {
  const seed = 1195917350;
  const gen = await generateDynamicMap({ seed, ngPlus: 1, parallelWorlds: [-1, 0, 1], unlocks: null });
  const room = 'general/orbroom';
  const selected = { ...gen, pixelScenesByPW: Object.fromEntries(Object.entries(gen.pixelScenesByPW)
    .map(([world, scenes]) => [world, scenes.filter(scene => scene.key === room)])) };
  const zip = (await getDataZip())!;
  const png = async (suffix: string) => decodePngToRgba(
    await zip.file('data/biome_impl/orbroom' + suffix + '.png')!.async('arraybuffer')).data;
  const [material, bg, visual] = await Promise.all(['', '_background', '_visual'].map(png));
  const built = await __warmSceneBuild(selected);
  try {
    const initialImages = built.bitmapByKey.size, samples = [];
    for (const pw of [-1, 0, 1]) {
      const original = selected.pixelScenesByPW[pw + ',0'].find(s => s.x === -10752 + pw * 32768 && s.y === 2560)!;
      const upper = built.validScenes.find((s: any) => s.x === original.x && s.y === original.y && s.key === room + '#upper');
      const lower = built.validScenes.find((s: any) => s.x === original.x && s.y === original.y + upper.height && s.key === room + '#floor');
      const key = sceneRenderKey(lower, seed), pending = built.loadFloor(key);
      if (built.loadFloor(key) !== pending) throw new Error('Duplicated an in-flight floor request');
      const floor = await pending;
      const ctx = new OffscreenCanvas(512, 512).getContext('2d')!;
      ctx.drawImage(built.bitmapByKey.get(sceneRenderKey(upper, seed)), 0, 0);
      ctx.drawImage(floor, 0, upper.height);
      const actual = ctx.getImageData(0, 0, 512, 512).data;
      const colors = new Set<number>();
      let exposed = 0, stairs = 0, artworkErrors = 0;
      for (let i = 0; i < actual.length; i += 4) {
        if (material[i] === 255 && material[i+1] === 255 && material[i+2] === 255)
          colors.add((actual[i] << 16) | (actual[i+1] << 8) | actual[i+2]);
        const empty = !material[i] && !material[i+1] && !material[i+2];
        const reference = visual[i+3] === 255 ? visual : empty && bg[i+3] === 255 ? bg : null;
        if (!reference) continue;
        if (reference === visual) stairs++; else exposed++;
        if (actual[i] !== reference[i] || actual[i+1] !== reference[i+1] ||
            actual[i+2] !== reference[i+2] || actual[i+3] !== 255) artworkErrors++;
      }
      samples.push({ pw, biome: lower.variantKey, colors: colors.size, exposed, stairs, artworkErrors,
        rock: await patchHash(ctx, 264, 456, 64, 32), pool: await patchHash(ctx, 40, 316, 36, 12) });
    }
    const remaining = built.validScenes.find((s: any) => s.key === room + '#floor' && !built.bitmapByKey.has(sceneRenderKey(s, seed)));
    const obsolete = built.loadFloor(sceneRenderKey(remaining, seed));
    built.release();
    return { initialImages, samples, cancelled: await obsolete === undefined };
  } finally { built.release(); }
}
