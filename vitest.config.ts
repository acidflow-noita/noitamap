import { configDefaults, defineConfig } from "vitest/config";
import { resolveLocalPro } from "./build_scripts/local-pro";
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { ...resolveLocalPro(import.meta.dirname).aliases,
    'noita-telescope-full-pixels/spawn_function_config.js': resolve(import.meta.dirname, 'lib/noita-telescope-vm/js/spawn_function_config.js'),
  } },
  server: {
    fs: { allow: [".."] },
  },
  test: {
    globals: true,
    // Nested checkouts/submodules own their test runners (Telescope uses node:test, not Vitest).
    exclude: [...configDefaults.exclude, "task/**", "lib/**"],
  },
});
