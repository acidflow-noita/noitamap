interface RetirementWork {
  /** Persist at most one bounded snapshot batch; true means fully drained. */
  step(): Promise<boolean>;
  /** Drop optional unsaved pages when rapid switches replace this retirement. */
  discard(): void;
}
interface Retirement {
  work: RetirementWork;
  resolve(): void;
  discarded: boolean;
}

const pending: Retirement[] = [];
let active: Retirement | undefined;
let scheduled = false;
let holds = 0;

/** The outgoing map must not compete with composing its replacement. Releases
 * are idempotent and overlapping handoffs hold the same shared queue. */
export function holdTerrainRetirement(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    schedule();
  };
}

/** Keep at most two outgoing working sets, plus any already copied write in
 * flight. Saved records remain on disk when an older retirement is dropped. */
export function retireTerrain(work: RetirementWork): Promise<void> {
  const done = new Promise<void>(resolve => {
    pending.push({ work, resolve, discarded: false });
  });
  while (pending.length > 2) {
    const oldest = pending.shift()!;
    oldest.discarded = true;
    oldest.work.discard();
    if (oldest !== active) oldest.resolve();
  }
  schedule();
  return done;
}

function schedule() {
  if (holds || active || scheduled || !pending.length) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    if (holds || active || !pending.length) return;
    const retirement = active = pending[0];
    void (async () => {
      let finished = false;
      try {
        finished = await retirement.work.step();
      } catch {
        retirement.work.discard();
        finished = true;
      } finally {
        active = undefined;
        if (finished || retirement.discarded) {
          const index = pending.indexOf(retirement);
          if (index !== -1) pending.splice(index, 1);
          retirement.resolve();
        }
        schedule();
      }
    })();
  };
  // Every batch yields a task, even without requestIdleCallback. This also
  // gives a new selection an opportunity to hold the next batch.
  if (typeof requestIdleCallback === "function") requestIdleCallback(run);
  else setTimeout(run, 0);
}
