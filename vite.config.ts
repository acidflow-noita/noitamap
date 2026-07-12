import { defineConfig } from "vite";
import { resolve } from "path";

import fs from "fs";

const isProAvailable = fs.existsSync(resolve(__dirname, "../noitamap-pro/src/pro-entry.ts"));

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
  ],
  resolve: {
    alias: {
      // Telescope submodule — always available (free feature)
      "noita-telescope": resolve(__dirname, "lib/noita-telescope/js"),
      // Shim telescope's app.js to remove the app.init() side-effect that crashes library usage.
      // We alias both the module name and the absolute path used by relative imports inside the submodule.
      "noita-telescope/app.js": resolve(__dirname, "src/telescope/telescope-app-shim.js"),
      [resolve(__dirname, "lib/noita-telescope/js/app.js")]: resolve(__dirname, "src/telescope/telescope-app-shim.js"),
      // Shim telescope's zip_extraction.js (imports from CDN that Vite can't bundle).
      // Our shim directly reads from our zip archives.
      "noita-telescope/zip_extraction.js": resolve(__dirname, "src/telescope/zip-extraction-shim.ts"),
      [resolve(__dirname, "lib/noita-telescope/js/zip_extraction.js")]: resolve(
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
