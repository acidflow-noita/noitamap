import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

// Build inputs / duplicate metadata. Runtime translations use locales and
// telescope's data/translations.csv; sprite metadata uses generated JS chunks.
const BUILD_ONLY_PUBLIC_FILES = [
  "game-translations/common.csv",
  "translations.csv",
  "assets/atlas.json",
];
const IMMUTABLE_PATH = "/build/*";

/** Cloudflare Pages already negotiates gzip/Brotli. Keep the deploy small and
 * cache only the separate bucket containing Vite's fingerprinted outputs. */
export function deliveryPlugin(): Plugin {
  let config: ResolvedConfig;
  let enabled = false;
  return {
    name: "production-delivery",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
      const input = config.build.rollupOptions.input;
      const inputs = typeof input === "string" ? [input] : Array.isArray(input) ? input : Object.values(input || {});
      // Native bakers/tests provide TS entries and keep their existing output.
      enabled = !config.isWorker && !config.build.ssr && !config.build.lib &&
        config.build.assetsDir === "build" &&
        inputs.length === 1 && resolve(config.root, inputs[0]) === resolve(config.root, "index.html");
    },
    async writeBundle(options, bundle) {
      if (!enabled || !bundle["index.html"]) return;
      const outDir = resolve(config.root, options.dir || config.build.outDir);
      for (const file of BUILD_ONLY_PUBLIC_FILES) await rm(resolve(outDir, file), { force: true });
      const headersPath = resolve(outDir, "_headers");
      let headers = "";
      try {
        headers = await readFile(headersPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // A user-authored policy takes precedence. Never append a second cache
      // directive: Pages concatenates matching header values rather than
      // applying a most-specific-rule-wins policy.
      if (/^\s*Cache-Control\s*:/im.test(headers)) {
        this.warn("Existing _headers cache policy retained; configure /build/* caching there if desired.");
        return;
      }
      await writeFile(headersPath, `${headers.trimEnd()}${headers.trim() ? "\n\n" : ""}# Vite fingerprinted outputs only; public assets keep Pages revalidation.\n${IMMUTABLE_PATH}\n  Cache-Control: public, max-age=31536000, immutable\n`);
    },
  };
}
