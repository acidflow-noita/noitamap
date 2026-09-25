import { clearCache } from "./tile-cache";

const LIB_VERSION = "2026-09-12-telescope-7fce46b-render-perf-386ee75";
let pending: Promise<void> | undefined;

/** Share this barrier between asset initialization and generation-cache reads.
 * A failed/blocked optional cache never marks the new revision as invalidated. */
export function ensureTelescopeCacheVersion(): Promise<void> {
  return (pending ??= (async () => {
    try {
      if (localStorage.getItem("noitamap-telescope-version") === LIB_VERSION)
        return;
    } catch {
      /* Privacy settings can deny optional localStorage. */
    }
    console.log(
      "[Telescope] Library version updated, clearing generation cache...",
    );
    if (typeof indexedDB !== "undefined" && (await clearCache())) {
      try {
        localStorage.setItem("noitamap-telescope-version", LIB_VERSION);
      } catch {
        /* Generation works without a persistent cache-version marker. */
      }
    }
  })());
}
