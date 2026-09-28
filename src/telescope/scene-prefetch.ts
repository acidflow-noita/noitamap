/** A replacement view may join an obsolete background pass. After it settles,
 * re-check missing keys under the new caller's lifetime instead of treating a
 * cancelled pass as complete. No callers overlap scene composition. */
export function createScenePrefetch(
  run: (isCurrent: () => boolean) => Promise<void>,
) {
  let inflight: Promise<void> | undefined;
  return function prefetch(isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return Promise.resolve();
    if (inflight)
      return inflight.then(() => {
        if (isCurrent()) return prefetch(isCurrent);
      });
    // Defer execution until after assignment: an empty scene table may return
    // synchronously before Telescope has initialized on the baked daily path.
    const current = Promise.resolve()
      .then(() => run(isCurrent))
      .finally(() => {
        if (inflight === current) inflight = undefined;
      });
    inflight = current;
    return current;
  };
}
