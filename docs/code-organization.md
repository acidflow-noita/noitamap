# Code organization

The public application starts in `src/main.ts`. `src/app.ts` owns map state and
`src/app_osd.ts` wraps OpenSeadragon. Feature directories contain their UI and
supporting logic: `search/`, `auth/`, `drawing/`, `extended-info/`, and `portals/`.

- `src/app/startup.ts` starts translations and map initialization together.
  `src/app/loading-progress.ts` owns progress events and strip state.
  `src/dev/console.ts` installs the local debug/bake console on demand.
- `src/i18n.ts` owns translation initialization. `build_scripts/vite-locales.ts`
  supplies compact, fingerprinted dictionaries; only the selected language and
  English fallback are fetched. `src/styles/map.css` combines the shared public
  styles in their existing cascade order into one fingerprinted stylesheet.
- `src/data/` contains shipped data. `src/data_sources/` adapts it for the map,
  including URLs, map definitions, overlays, and daily seed identities.
  `material-catalog.ts` is the single lazy loader shared by public material
  hooks and extended cards. Consumers retain their existing access checks.
- `src/telescope/` integrates generation, terrain, baked maps, markers, and POI
  cards. These modules also serve workers, native baking, and test harnesses.
  `bake-export.ts` owns biome-region and decoration bitmap exports. The bridge
  loads it on demand and supplies its shared scene builder and tile renderer;
  decoration cell export remains synchronous after preparation completes.
- `src/sage/` and `src/report-inventory.ts` define report data shared with the
  private application and the baker. Package exports in `package.json` are
  consumed outside the public application's import graph.
- `build_scripts/` owns build plugins, generated data, and baking commands.
  `npm run generate` runs `map-definitions/generate-tilesources.cjs`, which reads
  `src/data/map_definitions.json`, fetches DZI metadata, and updates
  `src/data/tilesources.json`, preserving existing entries when fetches fail.
- `scripts/` contains standalone maintenance tools. `tests/` covers public code
  and the shared renderer, including native bake execution.
- `task/noitamap-pro/` contains the private feature package and its tests.
  `task/biome-baker/` contains the CI bake pipeline. Each has its own repository.

`search/unifiedsearch.ts` and `search/unifiedsearchresults.ts` implement the active
search UI. `search/static-index.ts` supplies its static-map index. Both indexes
import FlexSearch from the installed package. The previous
`searchbox.ts` / `searchresults.ts` implementation has been removed. The player
sprite is implemented by the private package; the unused public copy is removed.

OpenSeadragon remains the shared browser runtime loaded by `index.html`. Portal
presentation uses that same instance; its imports are type-only. The native bake
entry installs its own OpenSeadragon global before loading the renderer.

Production delivery is configured in `build_scripts/vite-delivery.ts` and
`vite.config.ts`. Only fingerprinted `/build/` outputs get immutable caching;
daily identities and manifests keep their freshness rules. `scripts/audit-build.mjs`
reports the static entry graph separately from lazy code and runtime fetches.
See [loading and payload measurements](loading-performance.md) for the baseline,
validation commands, and remaining work to measure.

Before deleting code, check package exports, tests, workers, `build_scripts/`,
`scripts/`, and both task repositories as well as browser imports. The full-pixel
terrain modules remain active in the native baker even though public maps use
baked tiles or approximate generation.
