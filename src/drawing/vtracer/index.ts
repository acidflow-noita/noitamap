/**
 * vtracer WASM Loader
 *
 * Loads the vtracer WASM module (built from visioncortex/vtracer webapp)
 * and exports ColorImageConverter for in-browser image vectorization.
 */

import wasmUrl from "./vtracer_webapp_bg.wasm";
import * as bg from "./vtracer_webapp_bg.js";

let initialized: Promise<void> | null = null;

export async function init(): Promise<void> {
  if (initialized) return initialized;

  initialized = (async () => {
    try {
      // Resolve WASM URL relative to the JS bundle output directory
      const url = new URL(
        `js/${(wasmUrl as string).split("/").pop()}`,
        window.location.origin,
      ).href;
      console.log("[vtracer] Fetching WASM from:", url);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to load WASM: ${response.status} ${response.statusText} at ${url}`,
        );
      }

      const bytes = await response.arrayBuffer();

      const imports = {
        "./vtracer_webapp_bg.js": bg,
      };

      const { instance } = await WebAssembly.instantiate(bytes, imports);

      // Wire up the WASM exports to the JS glue
      bg.__wbg_set_wasm(instance.exports);

      // Run the WASM start function if it exists
      if ((instance.exports as any).__wbindgen_start) {
        (instance.exports as any).__wbindgen_start();
      }

      // Initialize the externref table if available
      if ((instance.exports as any).__wbindgen_init_externref_table) {
        bg.__wbindgen_init_externref_table();
      }
    } catch (e) {
      console.error("[vtracer] Failed to initialize WASM:", e);
      initialized = null; // Allow retrying
      throw e;
    }
  })();

  return initialized;
}

// Re-export the converter classes
export {
  ColorImageConverter,
  BinaryImageConverter,
} from "./vtracer_webapp_bg.js";

/**
 * Reset the WASM module state so it can be re-initialized.
 * Call this after a WASM panic to allow retrying without a page refresh.
 */
export function reset(): void {
  initialized = null;
}
