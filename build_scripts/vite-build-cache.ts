/** Coalesce main/worker preparation for one compilation. The root build and
 * watched input changes explicitly invalidate it; no timestamp-based freshness. */
export function createBuildCache<T>(prepare: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return {
    read(): Promise<T> {
      if (!pending) {
        const current = prepare().catch(error => {
          if (pending === current) pending = undefined;
          throw error;
        });
        pending = current;
      }
      return pending;
    },
    invalidate() { pending = undefined; },
  };
}
