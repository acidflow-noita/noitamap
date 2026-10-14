/** Worker messages/timer aborts need a macrotask, not merely an await of an
 * already-resolved promise. Bound uninterrupted JS work without one timer per
 * page. This scheduler is per request; concurrent cooks do not share a clock. */
export function cookCheckpoints(
  signal?: AbortSignal,
  yieldControl?: () => Promise<void>,
) {
  let lastYield = performance.now();
  return {
    due() {
      return performance.now() - lastYield >= 8;
    },
    async pause() {
      signal?.throwIfAborted();
      await (yieldControl
        ? yieldControl()
        : new Promise<void>((resolve) => setTimeout(resolve, 0)));
      signal?.throwIfAborted();
      lastYield = performance.now();
    },
  };
}
