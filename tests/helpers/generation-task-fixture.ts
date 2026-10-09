import { initTelescope, generateDynamicMap, prewarmParallelWorlds, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';
import { loadTelescopeModules } from '../../src/telescope/load-telescope';
import { createGenerationCheckpoint } from '../../src/telescope/generation-task';

export async function run(concurrent: boolean) {
  window.location.search = '?terrain=gpu';
  const cases = [
    { seed: 74803, unlocks: null },
    { seed: 74804, unlocks: [] },
    { seed: 12726363, dailySeed: true, unlocks: [] },
    { seed: 92, ngPlus: 1, unlocks: null },
    { seed: 1, gameMode: 'nightmare', unlocks: null },
    { seed: 74803, unlocks: null },
  ];
  const snapshots: any[] = [], stages: any[] = [];
  let firstBiomeData: any;
  try {
    prewarmParallelWorlds();
    await initTelescope();
    const generate = async (options: typeof cases[number]) => {
      let ticks = 0;
      let inputBeforeComplete = false;
      let input: ReturnType<typeof setTimeout> | undefined;
      const timer = setInterval(() => { ticks++; }, 1);
      const begin = performance.now();
      try {
        const result = await generateDynamicMap({ ...options, parallelWorlds: [-1, 0, 1],
          onTerrainReady() {
            // Queue an input-like task after this seed actually acquires the
            // generator, excluding any ticks spent waiting behind other seeds.
            input = setTimeout(() => { inputBeforeComplete = true; }, 0);
          },
        });
        stages.push({ seed: options.seed, ticks, inputBeforeComplete, elapsedMs: performance.now() - begin });
        firstBiomeData ??= result.biomeData;
        return (globalThis as any).__generationSnapshot(result);
      } finally { clearInterval(timer); clearTimeout(input); }
    };
    if (concurrent) snapshots.push(...await Promise.all(cases.map(generate)));
    else for (const options of cases) snapshots.push(await generate(options));
    const { tileGenMod, genConfigMod } = await loadTelescopeModules();
    let inputDuringTiles = false;
    const queuedInput = setTimeout(() => { inputDuringTiles = true; }, 0);
    let tileSnapshot;
    try {
      const layers = await tileGenMod.generateBiomeTiles(firstBiomeData.pixels, 70, 48,
        genConfigMod.GENERATOR_CONFIG, 74803, 0, 0, 'normal', createGenerationCheckpoint());
      tileSnapshot = (globalThis as any).__generationSnapshot({ seed: 74803,
        tileLayers: layers, poisByPW: {}, pixelScenesByPW: {} });
    } finally { clearTimeout(queuedInput); }
    let cancelledBeforeTerrain: boolean | undefined, recoverySnapshot: any;
    if (concurrent) {
      const controller = new AbortController();
      let terrainReady = false, aborted = false;
      const cancellation = setTimeout(() => controller.abort(), 0);
      try {
        await generateDynamicMap({ seed: 74899, unlocks: [], parallelWorlds: [0], signal: controller.signal,
          onTerrainReady() { terrainReady = true; } });
      } catch (error) { aborted = (error as Error).name === 'AbortError'; }
      finally { clearTimeout(cancellation); }
      cancelledBeforeTerrain = aborted && !terrainReady;
      recoverySnapshot = (globalThis as any).__generationSnapshot(await generateDynamicMap({
        seed: 74803, unlocks: null, parallelWorlds: [-1, 0, 1],
      }));
    }
    return { snapshots, stages, tileSnapshot, inputDuringTiles, cancelledBeforeTerrain, recoverySnapshot };
  } finally { releaseParallelWorlds(); }
}
