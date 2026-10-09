import PwWorker from '../../src/telescope/pw-worker?worker';
import { ParallelWorldWorkerPool } from '../../src/telescope/pw-worker-pool';
import { generateFixture } from './generate-worker-fixture';

export async function verifyPersistentPwPool(fullPixels: boolean, hash: (value: unknown) => string) {
  const first = await generateFixture(fullPixels, 42);
  const next = await generateFixture(fullPixels, 43);
  const scenes = () => first.workerScenes;
  const pool = new ParallelWorldWorkerPool(() => new PwWorker());
  const metrics = [];
  try {
    const prepareStarted = performance.now();
    await pool.prewarm(fullPixels);
    const preparationMs = performance.now() - prepareStarted;
    const cases = [
      { ...first, seed: 42, unlocks: null },
      { ...next, seed: 43, unlocks: [] },
      { ...first, seed: 42, unlocks: null },
    ];
    for (let i = 0; i < cases.length; i++) {
      const { workerScenes: _omit, ...input } = cases[i];
      const started = performance.now();
      const reused = await Promise.all([-1, 1].map(pw => pool.run({ ...input, pw })));
      const pooledMs = performance.now() - started;
      const freshPool = new ParallelWorldWorkerPool(() => new PwWorker());
      let fresh;
      const freshStart = performance.now();
      try { fresh = await Promise.all([-1, 1].map(pw => freshPool.run({ ...input, pw }, scenes))); }
      finally { freshPool.dispose(); }
      const freshMs = performance.now() - freshStart;
      const fingerprint = (result: any) => hash({ pw: result.pw, pois: result.pois, pixelScenes: result.pixelScenes });
      const actual = reused.map(fingerprint), expected = fresh!.map(fingerprint);
      if (actual.some((value, index) => value !== expected[index])) throw new Error(`Persistent worker changed seed ${input.seed}, case ${i}`);
      metrics.push({ seed: input.seed, unlocks: input.unlocks === null ? 'all' : 'none',
        pooledMs, freshMs, pois: reused.map(result => result.pois.length), scenes: reused.map(result => result.pixelScenes.length), hashes: actual });
    }
    if (JSON.stringify(metrics[0].hashes) !== JSON.stringify(metrics[2].hashes)) throw new Error('Unlock/seed round trip changed worker results');
    if (pool.stats.sceneSnapshots !== 0 || pool.stats.completed !== 6) throw new Error(`Unexpected pool activity: ${JSON.stringify(pool.stats)}`);
    return { fullPixels, preparationMs, metrics, stats: pool.stats };
  } finally { pool.dispose(); }
}
