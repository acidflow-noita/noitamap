import { NativeWorldClient } from './client';
import type { NativeRegionDescription, NativeWorldDescription, WorldRequest } from './world';

type Client = Pick<NativeWorldClient, 'prepare' | 'generate' | 'generateRegions' | 'dispose'>;

/** Leave capacity for the UI/terrain worker and cap duplicated rule tables.
 * Unknown and two-core devices keep one worker; Light mode also needs only one. */
export function nativeWorldWorkerLimit(cores?: number, memoryGiB?: number): number {
  if (typeof cores !== 'number' || !Number.isFinite(cores) || cores < 4 || (memoryGiB !== undefined && memoryGiB <= 2)) return 1;
  return cores < 6 || (memoryGiB !== undefined && memoryGiB <= 4) ? 2 : 3;
}

function deviceLimit(): number {
  const device = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { deviceMemory?: number };
  return nativeWorldWorkerLimit(device?.hardwareConcurrency, device?.deviceMemory);
}

/** Persistent independent rule instances. Each owns a contiguous set of
 * horizontal worlds and preserves its original Main/Heaven/Hell scan order. */
export class NativeWorldPool {
  private readonly clients: Client[] = [];
  private disposed = false;

  constructor(private readonly createClient: () => Client = () => new NativeWorldClient(),
    private readonly limit = deviceLimit()) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new RangeError('Native worker limit must be 1..3');
  }

  async prepare(worlds: number[] = [-1, 0, 1]): Promise<void> {
    if (this.disposed) throw new Error('Native generator pool disposed');
    const count = Math.min(this.limit, Math.max(1, worlds.length));
    while (this.clients.length < count) this.clients.push(this.createClient());
    await Promise.all(this.clients.slice(0, count).map(client => client.prepare()));
    if (this.disposed) throw new Error('Native generator pool disposed');
  }

  async generate(request: WorldRequest, signal?: AbortSignal): Promise<NativeWorldDescription> {
    signal?.throwIfAborted();
    const worlds = [...(request.parallelWorlds ?? [-1, 0, 1])];
    if (!worlds.length || worlds.some(pw => !Number.isSafeInteger(pw)) || new Set(worlds).size !== worlds.length)
      throw new Error('Invalid parallel worlds');
    // Copy all mutable inputs before the first await, including the calendar.
    const now = new Date(), snapshot: WorldRequest = { ...request,
      unlocks: request.unlocks?.slice() ?? request.unlocks,
      calendar: request.calendar ? { ...request.calendar } : { month: now.getMonth() + 1, day: now.getDate() } };
    await this.prepare(worlds);
    signal?.throwIfAborted();
    const count = Math.min(this.limit, worlds.length), controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const started = performance.now();
    try {
      const jobs: Promise<NativeRegionDescription>[] = [];
      for (let index = 0; index < count; index++) {
        const parallelWorlds = worlds.slice(Math.floor(index * worlds.length / count), Math.floor((index + 1) * worlds.length / count));
        const input = { ...snapshot, parallelWorlds };
        jobs.push(index === 0 ? this.clients[index].generate(input, controller.signal)
          : this.clients[index].generateRegions(input, controller.signal));
      }
      const results = await Promise.all(jobs);
      controller.signal.throwIfAborted();
      if (this.disposed) throw new Error('Native generator pool disposed');
      const world = results[0] as NativeWorldDescription;
      for (const part of results) {
        if (part.seed !== world.seed || part.revision !== world.revision || part.ngPlus !== world.ngPlus
          || part.gameMode !== world.gameMode || part.calendar.month !== world.calendar.month
          || part.calendar.day !== world.calendar.day || part.worldSize !== world.worldSize || part.worldCenter !== world.worldCenter)
          throw new Error('Native generation worker identity mismatch');
      }
      const regions = results.flatMap(part => part.regions);
      if (regions.length !== worlds.length * 3 || regions.some((region, i) =>
        region.horizontal !== worlds[Math.floor(i / 3)] || region.vertical !== [0, -1, 1][i % 3]))
        throw new Error('Native generation worker region mismatch');
      if (count === 1) return world;
      return { ...world, regions, timings: {
        // Parallel phase durations are maxima, not additive CPU work. Total
        // measures the actual joined request, including worker messaging.
        geometryMs: Math.max(...results.map(part => part.timings.geometryMs)),
        placementsMs: Math.max(...results.map(part => part.timings.placementsMs)),
        totalMs: performance.now() - started, workers: count,
      } };
    } catch (error) {
      controller.abort(error); // Stop siblings at their next region boundary.
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  dispose(): void {
    this.disposed = true;
    for (const client of this.clients) client.dispose();
    this.clients.length = 0;
  }
}
