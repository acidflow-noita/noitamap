import { generateDynamicMap, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';
// @ts-ignore -- the test build exposes the real compositor/cache orchestration.
import { sceneRenderKey, compositeSceneBitmap, getScenePngIndex, __warmSceneBuild, __clearSceneMemory } from '../../src/telescope/telescope-osd-bridge';
const pixels = (bitmap: any): Uint8ClampedArray => bitmap.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
const digest = async (bitmap: any) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels(bitmap) as any))).map(v => v.toString(16).padStart(2, '0')).join('');
export async function run() {
  window.location.search = (globalThis as any).__watercaveFullPixels ? '?terrain=gpu' : '?terrain=approx';
  const leases: any[] = [];
  try {
    const generation = await generateDynamicMap({ seed: 1, parallelWorlds: [-1, 0, 1], unlocks: null });
    const sceneKey = 'general/the_end_shop';
    const scenes = Object.values(generation.pixelScenesByPW).flat().filter(scene => scene.key === sceneKey);
    const sky = scenes.find(scene => scene.variantKey === 'biome=the_sky');
    const hell = scenes.find(scene => scene.variantKey === 'biome=the_end');
    if (!sky || !hell) throw new Error('Generated sky/hell shop fixtures missing');
    const index = await getScenePngIndex(), references: Record<string, string> = {};
    let skyPixels: Uint8ClampedArray | undefined, differentPixels = 0;
    for (const scene of [sky, hell]) {
      const composed = await compositeSceneBitmap(scene.key, scene, index, generation.seed);
      if (!composed?.blob) throw new Error('Shop artwork not available');
      references[scene.variantKey!] = await digest(composed.bitmap);
      if (scene === sky) {
        skyPixels = pixels(composed.bitmap).slice();
        // A valid PNG under the old shared key must not override either variant.
        (globalThis as any).__warmSceneStore.set(sceneKey, { blob: composed.blob, width: composed.width, height: composed.height });
      } else {
        const actual = pixels(composed.bitmap);
        for (let i = 0; i < actual.length; i += 4)
          if (actual.slice(i, i + 4).some((value, channel) => value !== skyPixels![i + channel])) differentPixels++;
      }
      composed.bitmap.close();
    }
    const selected = { ...generation, pixelScenesByPW: Object.fromEntries(Object.entries(generation.pixelScenesByPW)
      .map(([world, items]) => [world, items.filter(scene => scene.key === sceneKey)])) };
    const inspect = async (built: any) => {
      let matching = 0;
      for (const scene of scenes) if (await digest(built.bitmapByKey.get(sceneRenderKey(scene, generation.seed))) === references[scene.variantKey!]) matching++;
      return { entries: built.bitmapByKey.size, matching, total: scenes.length };
    };
    (globalThis as any).__sceneComposites = 0;
    const first = await __warmSceneBuild(selected); leases.push(first);
    const cold = await inspect(first), coldComposites = (globalThis as any).__sceneComposites;
    const second = await __warmSceneBuild({ ...selected, seed: 2 }); leases.push(second);
    const warm = await inspect(second), warmComposites = (globalThis as any).__sceneComposites - coldComposites;
    const shared = [...first.bitmapByKey].every(([key, image]: any) => second.bitmapByKey.get(key) === image);
    first.release(); second.release(); leases.length = 0;
    __clearSceneMemory();
    const third = await __warmSceneBuild(selected); leases.push(third);
    const disk = await inspect(third), diskComposites = (globalThis as any).__sceneComposites - coldComposites;
    return { references, differentPixels, cold, coldComposites, warm, warmComposites, shared, disk, diskComposites,
      legacyEntryKept: (globalThis as any).__warmSceneStore.has(sceneKey) };
  } finally { for (const lease of leases) lease.release(); releaseParallelWorlds(); }
}
