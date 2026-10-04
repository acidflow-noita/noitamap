/** Yield optional asset preparation. Promotion to foreground resolves an
 * outstanding idle wait immediately instead of making the user await idle. */
export function backgroundAssetYield(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let idle: number | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (idle !== undefined) globalThis.cancelIdleCallback?.(idle);
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    if (typeof globalThis.requestIdleCallback === "function")
      idle = globalThis.requestIdleCallback(finish, { timeout: 1000 });
    else timer = setTimeout(finish, 0);
  });
}

/** One decode at a time while optional; expand to normal foreground capacity
 * as soon as a live caller promotes the same initialization. */
export function prepareAssetJobs<T>(
  jobs: readonly T[],
  load: (job: T) => Promise<void>,
  background?: AbortSignal,
  yieldTask = backgroundAssetYield,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let next = 0,
      active = 0,
      settled = false;
    let sliceStarted = performance.now();
    let foregroundYield: Promise<void> | undefined;
    const yieldForeground = () => foregroundYield ??= new Promise<void>(resume => setTimeout(resume, 0))
      .then(() => { sliceStarted = performance.now(); foregroundYield = undefined; });
    const finish = (error?: unknown, failed = false) => {
      if (settled) return;
      settled = true;
      background?.removeEventListener("abort", promote);
      failed ? reject(error) : resolve();
    };
    const worker = async () => {
      while (!settled && next < jobs.length) {
        if (background && !background.aborted) await yieldTask(background);
        // Cached loads can resolve entirely as microtasks. Bound that chain so
        // input handlers and modal painting run during foreground preparation.
        else while (!settled && next < jobs.length && performance.now() - sliceStarted >= 8)
          await yieldForeground();
        if (settled || next >= jobs.length) return;
        await load(jobs[next++]);
      }
    };
    const launch = (count: number) => {
      for (let i = 0; i < count && next < jobs.length; i++) {
        active++;
        void worker().then(
          () => {
            if (--active === 0) finish();
          },
          (error) => finish(error, true),
        );
      }
      if (!active) finish();
    };
    const promote = () => {
      if (!settled) launch(8 - active);
    };
    background?.addEventListener("abort", promote, { once: true });
    launch(background && !background.aborted ? 1 : 8);
  });
}
