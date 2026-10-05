import { initTelescope, generateDynamicMap, prewarmParallelWorlds, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';

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
        return (globalThis as any).__generationSnapshot(result);
      } finally { clearInterval(timer); clearTimeout(input); }
    };
    if (concurrent) snapshots.push(...await Promise.all(cases.map(generate)));
    else for (const options of cases) snapshots.push(await generate(options));
    return { snapshots, stages };
  } finally { releaseParallelWorlds(); }
}
