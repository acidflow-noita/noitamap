/** A replacement view may join an obsolete background pass. After it settles,
 * re-check missing keys under the new caller's lifetime instead of treating a
 * cancelled pass as complete. No callers overlap scene composition. */
export function createScenePrefetch(
  run: (isCurrent: () => boolean, beforeScene: () => Promise<boolean>) => Promise<void>,
) {
  let inflight: Promise<void> | undefined;
  const yieldScene = () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 0));
  return function prefetch(isCurrent = () => true, beforeScene = yieldScene): Promise<void> {
    if (!isCurrent()) return Promise.resolve();
    if (inflight)
      return inflight.then(() => {
        if (isCurrent()) return prefetch(isCurrent, beforeScene);
      });
    // Defer execution until after assignment: an empty scene table may return
    // synchronously before Telescope has initialized on the baked daily path.
    const current = Promise.resolve()
      .then(() => run(isCurrent, beforeScene))
      .finally(() => {
        if (inflight === current) inflight = undefined;
      });
    inflight = current;
    return current;
  };
}
