import { loadProModule } from "./pro-module";

type ProModule = Awaited<ReturnType<typeof loadProModule>>;

/** One bootstrap load at a time; failed loads remain retryable. Features are
 * independently coalesced by the Pro bootstrap. Older Pro bundles still work. */
export function createProLoader(
  hooks: NoitamapProHooks,
  importModule: () => Promise<ProModule> = loadProModule,
): (feature?: NoitamapProFeature) => Promise<boolean> {
  let loaded = false;
  let pending: Promise<void> | undefined;

  const ensureBootstrap = (): Promise<void> => {
    if (loaded) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(importModule)
      .then((module) => module.init(hooks))
      .then(() => {
        loaded = true;
        (window as any).noitamap_pro_loaded = true;
        console.log("[Noitamap] Pro bootstrap loaded.");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  return async (feature) => {
    try {
      await ensureBootstrap();
      // A pre-split Pro bundle initializes everything in init(), so the hook
      // is intentionally optional during deployment rollout.
      if (feature) await hooks.loadProFeature?.(feature);
      return true;
    } catch (error) {
      console.error(
        `[Noitamap] Failed to load Pro${feature ? ` ${feature}` : ""}:`,
        error,
      );
      return false;
    }
  };
}
