import { defineConfig } from "vite";
import { resolve } from "path";

import fs from "fs";

const isProAvailable = fs.existsSync(resolve(__dirname, "../noitamap-pro/src/pro-entry.ts"));

// Public interactive generation uses the approximate fork and existing build
// override. Only native baking/renderer diagnostics explicitly select the full
// render-perf fork via load-telescope.ts, with matching workers/material data.
// There is no public live full-pixel toggle or saved preference.
const TELESCOPE_DEFAULT = "lib/noita-telescope";
const TELESCOPE_REQUESTED = process.env.NOITAMAP_TELESCOPE || TELESCOPE_DEFAULT;
let TELESCOPE_DIR = TELESCOPE_REQUESTED;
if (!fs.existsSync(resolve(__dirname, TELESCOPE_DIR, "js"))) {
  // A missing OPT-IN fork must never take the build (and therefore the daily bake)
  // down: fall back to the default, which git submodule update always provides.
  if (TELESCOPE_DIR !== TELESCOPE_DEFAULT && fs.existsSync(resolve(__dirname, TELESCOPE_DEFAULT, "js"))) {
    console.warn(
      `[vite] telescope fork "${TELESCOPE_DIR}" not checked out — falling back to ${TELESCOPE_DEFAULT}. ` +
        `Run: git submodule update --init --recursive`,
    );
    TELESCOPE_DIR = TELESCOPE_DEFAULT;
  } else {
    throw new Error(
      `Telescope fork not found at ${resolve(__dirname, TELESCOPE_DIR, "js")}. ` +
        `Run \`git submodule update --init --recursive\`.`,
    );
  }
}
const TELESCOPE_JS = resolve(__dirname, TELESCOPE_DIR, "js");
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
        return resolve(__dirname, "src/telescope/telescope-app-shim.js");
      }
      if (id.endsWith("zip_extraction.js") || id.includes("/zip_extraction.js")) {
        return resolve(__dirname, "src/telescope/zip-extraction-shim.ts");
      }
    }
  },
};

export default defineConfig({
  worker: {
    format: "es",
    plugins: () => [shimTelescopePlugin],
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
  plugins: [
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
      "noita-telescope-full-pixels": resolve(__dirname, "lib/noita-telescope-vm/js"),
      // Shim telescope's app.js to remove the app.init() side-effect that crashes library usage.
      // We alias both the module name and the absolute path used by relative imports inside the submodule.
      "noita-telescope/app.js": resolve(__dirname, "src/telescope/telescope-app-shim.js"),
      [resolve(TELESCOPE_JS, "app.js")]: resolve(__dirname, "src/telescope/telescope-app-shim.js"),
      // Shim telescope's zip_extraction.js (imports from CDN that Vite can't bundle).
      // Our shim directly reads from our zip archives.
      "noita-telescope/zip_extraction.js": resolve(__dirname, "src/telescope/zip-extraction-shim.ts"),
      [resolve(TELESCOPE_JS, "zip_extraction.js")]: resolve(
        __dirname,
        "src/telescope/zip-extraction-shim.ts",
      ),
      // Redirect CDN imports used by telescope to local npm packages so they get bundled.
      "https://cdn.jsdelivr.net/npm/upng-js@2.1.0/+esm": "upng-js",
      "virtual:noitamap-pro": isProAvailable
        ? resolve(__dirname, "../noitamap-pro/src/pro-entry.ts")
        : resolve(__dirname, "src/pro-unavailable.ts"),
      "virtual:noitamap-public-report": isProAvailable
        ? resolve(__dirname, "../noitamap-pro/src/public-report-entry.ts")
        : resolve(__dirname, "src/public-report-unavailable.ts"),
      ...(isProAvailable
        ? {
            "noitamap/data_sources/tile_data": resolve(__dirname, "src/data_sources/tile_data.ts"),
            "noitamap/data_sources/map_definitions": resolve(__dirname, "src/data_sources/map_definitions.ts"),
            "noitamap/data_sources/param-mappings": resolve(__dirname, "src/data_sources/param-mappings.ts"),
            "noitamap/data_sources/overlays": resolve(__dirname, "src/data_sources/overlays.ts"),
            "noitamap/data-archive": resolve(__dirname, "src/data-archive.ts"),
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
        main: resolve(__dirname, "index.html"),
      },
      output: {
        // Force manual chunking for vendor dependencies
        manualChunks: (id) => {
          // noita-telescope library code gets its own lazy chunk.
          // IMPORTANT: this MUST be separate from src/telescope/ adapter code.
          // The library has top-level `await` in image_processing.js that would
          // block the entire app if loaded eagerly with the adapter chunk.
          if (id.includes("/lib/noita-telescope-vm/data/") && id.includes("?url")) return "terrain-assets";
          if (id.includes("src/telescope/full-pixel-telescope-exports.ts") || id.includes("/lib/noita-telescope-vm/js/")) {
            return "telescope-full-pixels";
          }
          if (id.includes("src/telescope/telescope-exports.ts")) {
            return "telescope-lib";
          }
          if (id.includes("src/")) {
            return "main";
          }
          if (id.includes("noita-telescope")) {
            return "telescope-lib";
          }
          // src/telescope/ adapter code stays in main (no forced chunk).
          // This lets it load at startup without triggering the library's
          // top-level await — the library only loads when initTelescope()
          // calls `await import("./telescope-exports")`.
          if (id.includes("node_modules")) {
            if (id.includes("openseadragon")) return "vendor-osd";
            if (id.includes("pixi.js")) return "vendor-pixi";
            if (id.includes("doodle")) return "vendor-doodle";
            return "vendor";
          }
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
