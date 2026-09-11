import { configDefaults, defineConfig } from "vitest/config";
import { resolveLocalPro } from "./build_scripts/local-pro";

export default defineConfig({
  resolve: { alias: resolveLocalPro(import.meta.dirname).aliases },
  server: {
    fs: { allow: [".."] },
  },
  test: {
    globals: true,
    // Nested checkouts have independent dependencies/configs and test suites.
    exclude: [...configDefaults.exclude, "task/**"],
  },
});
