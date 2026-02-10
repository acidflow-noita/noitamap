// Adapter for vectortracer WASM loading
// This replaces the default bundler-target loading which fails in our setup

import wasmUrl from './vectortracer_bg.wasm';
import * as bg from './vectortracer_bg.js';

let wasm: any;
let initialized: Promise<void> | null = null;

export async function init() {
  if (initialized) return initialized;

  initialized = (async () => {
    try {
      // Tsup outputs the file to 'public/js', but imports just return the filename.
      // We need to resolve it relative to the 'js/' directory from the site root.
      const url = new URL(`js/${wasmUrl.split('/').pop()}`, window.location.origin).href;
      console.log('[VectorTracer] Fetching WASM from:', url);
      const response = await fetch(url).catch(err => {
        console.error('[VectorTracer] Network error fetching WASM:', err);
        throw new Error(`Failed to connect to ${url}. Is your server running?`);
      });
      
      if (!response.ok) {
        throw new Error(`Failed to load WASM: ${response.status} ${response.statusText} at ${url}`);
      }
      
      const bytes = await response.arrayBuffer();
      
      // The imports object must match what the WASM module expects
      // wasm-pack bundler target expects imports from "./vectortracer_bg.js"
      const imports = {
        './vectortracer_bg.js': bg, 
      };

      const { instance } = await WebAssembly.instantiate(bytes, imports);
      wasm = instance.exports;
      
      // Initialize the JS binding with the WASM exports
      bg.__wbg_set_wasm(wasm);
      
      // Run start function if it exists
      if (wasm.__wbindgen_start) {
          wasm.__wbindgen_start();
      }
    } catch (e) {
      console.error('Failed to initialize vectortracer WASM:', e);
      initialized = null; // Allow retrying
      throw e;
    }
  })();

  return initialized;
}

// Re-export everything from the background JS
export * from './vectortracer_bg.js';
