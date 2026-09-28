import { reportTerrainStorageUsage } from './terrain-storage-usage';

/** A single native sample runs at a time, independently of OSD's zoom LOD.
 * Only coordinates are queued; pixels belong to the shared retention store. */
export interface CookSource {
  instantRegion: { x: number; y: number; width: number; height: number };
  prepareNativeTile(x: number, y: number): Promise<void>;
}
type Job = { source: CookSource; x: number; y: number };

export function createInstantTerrainCooker(options: {
  signal: AbortSignal;
  priority: (source: CookSource, x: number, y: number) => number;
  viewKey: () => string;
  persistent: () => boolean;
  flush: () => Promise<void>;
  onFailure: (error: unknown) => void;
  /** Start of the seed request, before asset loading and generation. */
  startedAt?: number;
  seed?: number;
}) {
  const startedAt = options.startedAt ?? performance.now();
  const sources = new Set<CookSource>();
  const jobs: Job[] = [];
  const stats = { state: 'waiting', total: 0, completed: 0, active: 0 };
  let started = false, running = false, scheduled = false, rankedFor: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channel: MessageChannel | undefined;
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  const closeChannel = () => {
    if (!channel) return;
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
    channel = undefined;
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    scheduled = false;
    closeChannel();
    jobs.length = 0;
    sources.clear();
    stats.state = 'cancelled';
    document.removeEventListener?.('visibilitychange', schedule);
  };
  function runScheduled() {
    if (!scheduled) return;
    scheduled = false;
    timer = undefined;
    void step();
  }
  function schedule() {
    if (!started || running || scheduled || options.signal.aborted
      || stats.state === 'failed' || stats.state === 'complete') return;
    if (!options.persistent()) {
      if (stats.state !== 'paused-storage') {
        console.warn('[Instant terrain] Background detail paused: persistent terrain storage unavailable');
        void reportTerrainStorageUsage(options.signal, options.seed);
      }
      stats.state = 'paused-storage';
      return;
    }
    if (hidden()) { stats.state = 'paused-hidden'; return; }
    stats.state = 'running';
    scheduled = true;
    // Empty and RAM-ready leaves can finish without any I/O task. Chaining
    // timers across those leaves eventually adds the browser's nested-timer
    // delay to every block. A message task yields and resets that nesting;
    // the foreground queue still decides when the next GPU draw may start.
    if (typeof window !== 'undefined' && typeof window.MessageChannel === 'function') {
      try {
        if (!channel) {
          const created = new window.MessageChannel();
          created.port1.onmessage = () => { if (channel === created) runScheduled(); };
          channel = created;
        }
        channel.port2.postMessage(null);
        return;
      } catch { closeChannel(); }
    }
    timer = setTimeout(runScheduled, 0);
  }
  async function step() {
    if (options.signal.aborted) return;
    if (!options.persistent() || hidden()) { schedule(); return; }
    running = true;
    try {
      // Re-rank remaining coordinates after navigation, never enqueue all
      // renders into the worker. A foreground request can always go first.
      const key = options.viewKey();
      if (key !== rankedFor) {
        const ranked = jobs.map(job => ({ job, rank: options.priority(job.source, job.x, job.y) }));
        ranked.sort((a, b) => b.rank - a.rank);
        jobs.length = 0;
        for (const entry of ranked) jobs.push(entry.job);
        rankedFor = key;
      }
      const job = jobs.pop();
      if (job) {
        stats.active = 1;
        await job.source.prepareNativeTile(job.x, job.y);
        if (!options.signal.aborted) stats.completed++;
      } else {
        // Completion includes persistence, not merely submitted GPU draws.
        await options.flush();
        if (!options.signal.aborted && options.persistent() && !jobs.length) {
          stats.state = 'complete';
          const finishedAt = performance.now();
          console.info(`[Instant terrain] Full map terrain finished in ${((finishedAt - startedAt) / 1000).toFixed(2)} seconds`, {
            ...stats,
            seed: options.seed,
            regions: sources.size,
            elapsedMs: finishedAt - startedAt,
            sinceNavigationMs: finishedAt,
            scope: 'Native terrain and retained reductions, including persistence; scene and POI tile completion is separate',
          });
          void reportTerrainStorageUsage(options.signal, options.seed);
        }
      }
    } catch (error) {
      if (!options.signal.aborted) {
        stats.state = 'failed';
        options.onFailure(error);
      }
    } finally {
      stats.active = 0;
      running = false;
      if (stats.state === 'failed' || stats.state === 'complete') closeChannel();
      schedule();
    }
  }
  if (!options.signal.aborted) {
    document.addEventListener?.('visibilitychange', schedule);
    options.signal.addEventListener('abort', stop, { once: true });
  } else stop();
  return {
    stats,
    add(source: CookSource) {
      if (options.signal.aborted || sources.has(source)) return;
      sources.add(source);
      for (let y = 0; y < Math.ceil(source.instantRegion.height / 512); y++)
        for (let x = 0; x < Math.ceil(source.instantRegion.width / 512); x++)
          jobs.push({ source, x, y });
      stats.total = stats.completed + jobs.length + stats.active;
      rankedFor = undefined;
      if (stats.state === 'complete') stats.state = 'waiting';
      schedule();
    },
    start() { started = true; schedule(); },
  };
}
