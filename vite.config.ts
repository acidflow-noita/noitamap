import { defineConfig } from "vite";
import { telescopeBrowserPlugin } from "./build_scripts/vite-telescope-browser.ts";
import { atlasChunksPlugin } from "./build_scripts/vite-atlas-chunks.ts";
import { resolve } from "node:path";

import fs from "node:fs";

const isProAvailable = fs.existsSync(resolve(import.meta.dirname, "../noitamap-pro/src/pro-entry.ts"));

// Public interactive generation uses the approximate fork and existing build
// override. Only native baking/renderer diagnostics explicitly select the full
// render-perf fork via load-telescope.ts, with matching workers/material data.
// There is no public live full-pixel toggle or saved preference.
const TELESCOPE_DEFAULT = "lib/noita-telescope";
const TELESCOPE_REQUESTED = process.env.NOITAMAP_TELESCOPE || TELESCOPE_DEFAULT;
let TELESCOPE_DIR = TELESCOPE_REQUESTED;
if (!fs.existsSync(resolve(import.meta.dirname, TELESCOPE_DIR, "js"))) {
  // A missing OPT-IN fork must never take the build (and therefore the daily bake)
  // down: fall back to the default, which git submodule update always provides.
  if (TELESCOPE_DIR !== TELESCOPE_DEFAULT && fs.existsSync(resolve(import.meta.dirname, TELESCOPE_DEFAULT, "js"))) {
    console.warn(
      `[vite] telescope fork "${TELESCOPE_DIR}" not checked out — falling back to ${TELESCOPE_DEFAULT}. ` +
        `Run: git submodule update --init --recursive`,
    );
    TELESCOPE_DIR = TELESCOPE_DEFAULT;
  } else {
    throw new Error(
      `Telescope fork not found at ${resolve(import.meta.dirname, TELESCOPE_DIR, "js")}. ` +
        `Run \`git submodule update --init --recursive\`.`,
    );
  }
}
const TELESCOPE_JS = resolve(import.meta.dirname, TELESCOPE_DIR, "js");
console.log(`[vite] telescope fork: ${TELESCOPE_DIR}`);

const shimTelescopePlugin = {
  name: "shim-telescope-app",
  enforce: "pre" as const,
  resolveId(id: string, importer?: string) {
    // Intercept any import of app.js or zip_extraction.js originating from within the telescope library
    // to prevent side-effects (init()) and redundant/broken zip terminal logic.
    const isTelescopeImport = importer && (importer.includes("noita-telescope") || importer.includes("telescope"));

    if (isTelescopeImport || id.includes("noita-telescope/")) {
      if (id.endsWith("app.js") || id.includes("/app.js")) {
        return resolve(import.meta.dirname, "src/telescope/telescope-app-shim.js");
      }
      if (id.endsWith("zip_extraction.js") || id.includes("/zip_extraction.js")) {
        return resolve(import.meta.dirname, "src/telescope/zip-extraction-shim.ts");
      }
    }
  },
};

export default defineConfig({
  worker: {
    format: "es",
    plugins: () => [shimTelescopePlugin, telescopeBrowserPlugin([TELESCOPE_JS, resolve(import.meta.dirname, "lib/noita-telescope-vm/js")]), atlasChunksPlugin(import.meta.dirname)],
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
  plugins: [
    {
      // Native bakers/test harnesses supply their own manualChunks policy.
      // Do not let the client's new grouping override that explicit choice.
      name: "respect-caller-chunking",
      config(config) {
        for (const options of [config.build?.rollupOptions, config.build?.rolldownOptions]) {
          const outputs = options?.output;
          for (const output of Array.isArray(outputs) ? outputs : outputs ? [outputs] : []) {
            if (output.manualChunks) delete output.codeSplitting;
          }
        }
      },
    },
    telescopeBrowserPlugin([TELESCOPE_JS, resolve(import.meta.dirname, "lib/noita-telescope-vm/js")]),
    atlasChunksPlugin(import.meta.dirname),
    {
      name: "og-meta-rewrite",
      transformIndexHtml(html) {
        const domain = process.env.SITE_DOMAIN || "noitamap.com";
        const siteUrl = `https://${domain}/`;
        const ogImageFile = domain.includes("dev.") ? "noitamap-dev-opengraph.png" : "noitamap-opengraph.png";
        const ogImage = `https://${domain}/assets/${ogImageFile}`;

        return html
          .replace(/content="https:\/\/map\.runfast\.stream\/"/g, `content="${siteUrl}"`)
          .replace(/content="https:\/\/map\.runfast\.stream\/assets\/noitamap-opengraph\.png"/g, `content="${ogImage}"`)
          .replace(/content="map\.runfast\.stream"/g, `content="${domain}"`);
      },
    },
    shimTelescopePlugin,
    {
      name: "local-completed-bake",
      configureServer(server) {
        const root = process.env.NOITAMAP_LOCAL_BAKE;
        if (!root) return;
        server.middlewares.use("/__local-bake", (req, res) => {
          const path = (req.url || "").split("?")[0];
          if (!/^\/(left|middle|right)\/(manifest\.json|generation\.json|map\.dzi|map_files\/\d+\/\d+_\d+\.webp)$/.test(path)) {
            res.statusCode = 404; res.end(); return;
          }
          const file = resolve(root, '.' + path);
          const stream = fs.createReadStream(file);
          stream.on("error", () => { if (!res.headersSent) res.statusCode = 404; res.end(); });
          res.setHeader("Content-Type", path.endsWith(".webp") ? "image/webp" : "application/json");
          res.setHeader("Cache-Control", path.endsWith(".webp") ? "public, max-age=3600" : "no-store");
          stream.pipe(res);
        });
      },
    },
    {
      // Development-only, same-origin error capture. No browser automation and
      // no production telemetry: lets us inspect the user's actual GL failure.
      name: "terrain-local-diagnostics",
      configureServer(server) {
        const reports: unknown[] = [];
        server.middlewares.use("/__terrain-diagnostics", (req, res) => {
          res.setHeader("Cache-Control", "no-store");
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(reports));
            return;
          }
          if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
          let body = "";
          req.on("data", chunk => {
            body += chunk;
            if (body.length > 65536) req.destroy();
          });
          req.on("end", () => {
            try {
              const report = { received: new Date().toISOString(), ...JSON.parse(body) };
              reports.push(report);
              if (reports.length > 30) reports.shift();
              if (report.event === "error") console.error("[Browser terrain failure]", report);
              res.statusCode = 204; res.end();
            } catch { res.statusCode = 400; res.end(); }
          });
        });
      },
    },
  ],
  resolve: {
    alias: {
      // Telescope submodule — always available (free feature)
      "noita-telescope": TELESCOPE_JS,
      "noita-telescope-full-pixels": resolve(import.meta.dirname, "lib/noita-telescope-vm/js"),
      // Shim telescope's app.js to remove the app.init() side-effect that crashes library usage.
      // We alias both the module name and the absolute path used by relative imports inside the submodule.
      "noita-telescope/app.js": resolve(import.meta.dirname, "src/telescope/telescope-app-shim.js"),
      [resolve(TELESCOPE_JS, "app.js")]: resolve(import.meta.dirname, "src/telescope/telescope-app-shim.js"),
      // Shim telescope's zip_extraction.js (imports from CDN that Vite can't bundle).
      // Our shim directly reads from our zip archives.
      "noita-telescope/zip_extraction.js": resolve(import.meta.dirname, "src/telescope/zip-extraction-shim.ts"),
      [resolve(TELESCOPE_JS, "zip_extraction.js")]: resolve(
        import.meta.dirname,
        "src/telescope/zip-extraction-shim.ts",
      ),
      // Redirect CDN imports used by telescope to local npm packages so they get bundled.
      "https://cdn.jsdelivr.net/npm/upng-js@2.1.0/+esm": "upng-js",
      "virtual:noitamap-pro": isProAvailable
        ? resolve(import.meta.dirname, "../noitamap-pro/src/pro-entry.ts")
        : resolve(import.meta.dirname, "src/pro-unavailable.ts"),
      "virtual:noitamap-public-report": isProAvailable
        ? resolve(import.meta.dirname, "../noitamap-pro/src/public-report-entry.ts")
        : resolve(import.meta.dirname, "src/public-report-unavailable.ts"),
      ...(isProAvailable
        ? {
            "noitamap/data_sources/tile_data": resolve(import.meta.dirname, "src/data_sources/tile_data.ts"),
            "noitamap/data_sources/map_definitions": resolve(import.meta.dirname, "src/data_sources/map_definitions.ts"),
            "noitamap/data_sources/param-mappings": resolve(import.meta.dirname, "src/data_sources/param-mappings.ts"),
            "noitamap/data_sources/overlays": resolve(import.meta.dirname, "src/data_sources/overlays.ts"),
            "noitamap/data-archive": resolve(import.meta.dirname, "src/data-archive.ts"),
          }
        : {}),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true, // Always start clean — no stale hashed files
    sourcemap: true,
    minify: "esbuild",
    // IMPORTANT: Disable modulepreload injection. Vite injects <link rel="modulepreload">
    // for dynamically-imported chunks, which causes the browser to eagerly evaluate them.
    // The telescope-lib chunk has top-level await (image_processing.js) that MUST only run
    // after interceptors are installed — eager evaluation crashes the app silently.
    modulePreload: false,

    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
      },
      output: {
        // Explicit priorities prevent a recursive "main" or telescope group
        // from swallowing vendor code, engine tables and the lazy sprite atlas.
        codeSplitting: {
          includeDependenciesRecursively: true,
          groups: [
            { name: "terrain-assets", test: /\/lib\/noita-telescope-vm\/data\/.*\?url/, priority: 200 },
            { name: "telescope-data-tables", test: /\/lib\/noita-telescope-vm\/js\/.*(?:enemy_config|engine_data)\.js$/, priority: 140 },
            { name: "telescope-runtime", test: /\/src\/(?:data-archive|renderer_settings|telescope\/(?:telescope-(?:data-bridge|dom-shim|app-shim|assets|asset-paths)|zip-extraction-shim|png-decode|full-pixel-data))\.[jt]s$/, priority: 150 },
            { name: "telescope-full-pixels", test: /\/lib\/noita-telescope-vm\/js\/|\/src\/telescope\/full-pixel-telescope-exports\.ts$/, priority: 80 },
            { name: "telescope-lib", test: (id) => id.startsWith(TELESCOPE_JS + "/") || id.endsWith("/src/telescope/telescope-exports.ts"), priority: 70 },
            { name: "vendor-png", test: /\/node_modules\/(?:fast-png|fflate|iobuffer|pngjs|upng-js|pako)\//, priority: 190 },
            { name: "vendor-osd", test: /\/node_modules\/openseadragon\//, priority: 190 },
            { name: "vendor-pixi", test: /\/node_modules\/pixi\.js\//, priority: 190 },
            { name: "vendor", test: /\/node_modules\//, priority: 160 },
            { name: (id) => "map-data-" + id.split("/").pop()!.replace(/\.json$/, ""), test: /\/src\/data\/[^/]+\.json$/, priority: 40 },
          ],
        },
      },
    },
  },

  assetsInclude: ["**/*.wasm"],

  define: {
    "process.env.NODE_ENV": '"production"',
    // Build stamp used to cache-bust the remotely-fetched pro.js. Changes on
    // every host build so a redeploy breaks browsers off the old bundle URL.
    __BUILD_VERSION__: JSON.stringify(String(Date.now())),
  },
});
