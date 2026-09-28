/** Selectively retire OSD 6.1 seed work without clearing the shared background. */
type Control = { retired: boolean };
type State = { active: Set<any>; controls: WeakMap<object, Control> };
const states = new WeakMap<object, State>();
const wrappedSources = new WeakSet<object>();
const wrappedJobs = new WeakSet<object>();

/** Install before adding the first seed image. OSD exposes queued jobs, but
 * does not retain a public list of running ImageJobs, so observe their starts. */
export function installMapItemRetirement(input: any): void {
  const viewer = input.viewer ?? input;
  const loader = viewer.imageLoader;
  if (!loader || states.has(loader)) return;
  const state: State = { active: new Set(), controls: new WeakMap() };
  states.set(loader, state);
  const addJob = loader.addJob;
  loader.addJob = function(options: any) {
    const control: Control = { retired: false };
    if (options.tile) state.controls.set(options.tile, control);
    const source = options.source;
    if (source && !wrappedSources.has(source)) {
      wrappedSources.add(source);
      const start = source.downloadTileStart;
      source.downloadTileStart = function(job: any) {
        // A TileSource can be shared by viewers; ownership belongs to its tile.
        const owner = states.get(job.tile?.tiledImage?._imageLoader);
        if (owner) {
          owner.active.add(job);
          if (!wrappedJobs.has(job)) {
            wrappedJobs.add(job);
            const callback = job.callback;
            job.callback = function(...args: any[]) {
              // ImageJob.abort() calls source cancellation and then fail().
              // Some sources also call fail while cancelling; OSD's fail has
              // no completion guard, so protect the loader count per attempt.
              if (!owner.active.has(job)) return;
              owner.active.delete(job);
              return callback.apply(this, args);
            };
          }
        }
        return start.call(this, job);
      };
    }
    return addJob.call(this, { ...options,
      callback: (...args: any[]) => {
        // Aborting a stale request must settle OSD's loader count without
        // reporting a failed tile or painting into an already removed image.
        if (!control.retired) options.callback?.(...args);
      },
      abort: () => { control.retired = true; options.abort?.(); },
    });
  };
  viewer.addOnceHandler?.('before-destroy', () => {
    loader.addJob = addJob;
    states.delete(loader);
  });
}

/** Call synchronously at the replacement boundary, before removing attached
 * images and before adding the incoming seed. The predicate receives either a
 * TileSource or the original pending URL/config passed to addTiledImage.
 * Matching is snapshotted: late results cannot cancel incoming work.
 *
 * OSD does not expose the manifest discovery XHR. Its response may still
 * arrive, but it no longer blocks the queue or attaches an obsolete image. */
export function retireMapItems(input: any, belongsToOutgoingSeed: (source: any) => boolean): void {
  const viewer = input.viewer ?? input;
  const loader = viewer.imageLoader;
  const state = loader && states.get(loader);
  const matches = (source: any) => source && !source.__biomeBg && !source.__simplisticBase
    && belongsToOutgoingSeed(source);
  const pending = (viewer._loadQueue ?? []).filter((entry: any) =>
    matches(entry.tiledImage?.source ?? entry.options.tileSource));
  const queued = (loader?.jobQueue ?? []).filter((job: any) => !Array.isArray(job.jobs) && matches(job.source));
  const failed = (loader?.failedTiles ?? []).filter((job: any) => matches(job.source));
  const running = [...(state?.active ?? [])].filter(job => matches(job.source));
  const batches = [...(loader?._batchBuckets ?? []),
    ...(loader?.jobQueue ?? []).filter((job: any) => Array.isArray(job.jobs))].map((bucket: any) => ({ bucket,
    jobs: bucket.jobs.filter((job: any) => matches(job.source)),
  }));

  // Remove all obsolete FIFO entries before any abort can start another job.
  const cancelledPending = new Set(pending);
  if (viewer._loadQueue) viewer._loadQueue = viewer._loadQueue.filter((entry: any) => !cancelledPending.has(entry));
  for (const entry of pending) {
    entry.options.success = ({ item }: any) => item.destroy();
    entry.options.error = () => {};
    entry.tiledImage?.destroy();
    delete entry.tiledImage;
  }
  const cancelledJobs = new Set([...queued, ...failed]);
  if (loader) {
    loader.jobQueue = loader.jobQueue.filter((job: any) => !cancelledJobs.has(job));
    loader.failedTiles = loader.failedTiles.filter((job: any) => !cancelledJobs.has(job));
  }
  const abort = (job: any) => {
    const control = state?.controls.get(job.tile);
    if (control) control.retired = true;
    // completeJob normally retries failures, including aborts. This job is
    // permanently retired; keeping its callback preserves loader accounting.
    job.tries = Math.max(job.tries, 1 + (loader?.tileRetryMax ?? 0));
    job.abort?.();
  };
  for (const { bucket, jobs } of batches) {
    const removed = new Set(jobs);
    bucket.jobs = bucket.jobs.filter((job: any) => !removed.has(job));
    for (const job of jobs) abort(job);
    if (!bucket.jobs.length) {
      clearTimeout(bucket.timer);
      loader._batchBuckets = loader._batchBuckets.filter((entry: any) => entry !== bucket);
      loader.jobQueue = loader.jobQueue.filter((entry: any) => entry !== bucket);
    }
  }
  for (const job of cancelledJobs) abort(job);
  for (const job of running) abort(job);

  // An unrelated image may already have resolved behind the retired head.
  // Let OSD's own success handler drain the surviving FIFO in original order.
  const ready = viewer._loadQueue?.[0];
  if (ready?.tiledImage) ready.options.success({ item: ready.tiledImage });
}
