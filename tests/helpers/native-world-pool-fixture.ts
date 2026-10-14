import { NativeWorldPool } from '../../src/native-map/world-pool';
import type { NativeWorldDescription, WorldRequest } from '../../src/native-map/world';

async function digest(world: NativeWorldDescription) {
  const { timings, ...content } = world;
  const text = JSON.stringify(content, (key, value) => {
    if (['imgElement', 'id', 'uuid', 'debugRngInfo'].includes(key)) return undefined;
    if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value instanceof Set) return [...value];
    return value;
  });
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function run() {
  const serial = new NativeWorldPool(undefined, 1), parallel = new NativeWorldPool(undefined, 3);
  const rows = [], prepareStarted = performance.now();
  try {
    await Promise.all([serial.prepare(), parallel.prepare()]);
    const prepareMs = performance.now() - prepareStarted;
    const requests: WorldRequest[] = [{ seed: 618 }, { seed: 11033, unlocks: [] },
      { seed: 1337, ngPlus: 1, calendar: { month: 2, day: 14 } }, { seed: 333, gameMode: 'nightmare' },
      { seed: 786433191, parallelWorlds: [1, 0, -1] }, { seed: 1103, parallelWorlds: [0] }];
    for (const [index, request] of requests.entries()) {
      const measured: any[] = [];
      for (const [name, pool] of (index % 2 ? [['parallel', parallel], ['serial', serial]] : [['serial', serial], ['parallel', parallel]]) as [string, NativeWorldPool][]) {
        const start = performance.now(), world = await pool.generate(request), elapsedMs = performance.now() - start;
        measured.push({ name, elapsedMs, timings: world.timings, hash: await digest(world),
          regions: world.regions.map(r => [r.horizontal, r.vertical, r.pois.length, r.scenes.length]) });
      }
      rows.push({ request, measured });
    }
    return { prepareMs, rows };
  } finally { serial.dispose(); parallel.dispose(); }
}
