# Loading and payload

Measured on `dynamic-map`, 2026-09-26, against the production build before this
loading/refactor change. Sizes use decimal units. Gzip numbers are local level-6
estimates, not observed network transfers or browser timings.

| Resource | Before | After |
| --- | ---: | ---: |
| Initial local JavaScript, raw | 1,195,161 B | 1,026,173 B |
| Initial local JavaScript, gzip | 323,757 B | 270,462 B |
| Initial local JavaScript, Brotli | 267,063 B | 223,698 B |
| Local stylesheets | 9 requests, 24,433 B gzip | 1 request, 14,468 B gzip |
| Locale downloads, including old idle preload, English session | 16 dictionaries, 1,481,577 B gzip | 1 dictionary, 80,546 B gzip |
| Telescope runtime translations | 1,534,897 B raw / 573,305 B gzip | 175,226 B raw / 52,573 B gzip |
| Entire deploy directory | 81,621,102 B | 64,206,959 B |
| Deployed source maps | 15,517,716 B | 0 by default |

The JavaScript figures include the static import graph only. Runtime data, lazy
imports, images, tiles, and external CDN scripts are separate. FlexSearch now
comes from the installed package and is included in the new local graph; its old
CDN download was outside the baseline. Non-English sessions request the chosen
dictionary plus English fallback. Switching language fetches that complete
dictionary on demand.

The deploy-directory reduction is a publishing/storage improvement; source maps
and unused build inputs were not normal startup downloads. Stable public locale
and CSS copies remain for compatibility alongside the new hashed outputs.

## Changed loading behavior

- Map creation, selected-language loading, and the applicable daily probe start
  together. Failed translations still allow the map to open.
- Concurrent daily identity reads share one request. Manual refresh and UTC
  rollover remain fresh; older requests cannot overwrite newer cache entries.
- Cold archive downloads skip the redundant HEAD request. Warm archives still
  validate freshness, and workers consume the main thread's shared cache.
  ZIP code downloads alongside archive requests instead of at app entry.
- PNG codecs, full-pixel setup, bake exports, and debug console code are lazy.
  Static search builds its index only on the first static-map search.
- Public material hooks and extended cards share one material catalog request,
  parse, and index. Failed loads remain retryable.
- Selected translations and the combined stylesheet use content-hashed URLs.
  Only `/build/*` receives immutable caching. The directory stays one level deep
  because Telescope resolves `../data/` relative to its emitted modules.
- The HTML preloads existing entry dependencies in parallel. It does not preload
  lazy engine, atlas, or Pro code. Deferred OpenSeadragon remains before the
  module entry because overlay modules use that global during evaluation.
- Removed unused CDN plugins, the duplicate portal OpenSeadragon import, the old
  search UI, its exclusive CSS, and the unused public player sprite.

Telescope's compact CSV retains exactly the key/English fields consumed by its
existing parser. This does not change UI dictionaries or translations from the
game. Raw game CSVs remain in source, and runtime archive/asset URLs are retained.

## Compression and caching

[Cloudflare Pages automatically serves gzip/Brotli](https://developers.cloudflare.com/pages/configuration/serving-pages/).
Do not add unused `.gz`/`.br` sidecars to the deploy. The existing ZIP archives are
already compressed: testing maximum DEFLATE made `data.zip`, `pixel_scenes.zip`,
and `wang_tiles.zip` larger by 180,530, 11,477, and 413 bytes respectively.

Source maps remain available for diagnostics:

```sh
NOITAMAP_SOURCEMAPS=1 npm run build
```

That build includes source maps in its output; the normal build excludes them.
Do not apply immutable caching to HTML, stable public filenames, daily seed
pointers, or baked manifests.

## Reproduce and guard the result

```sh
npm run typecheck
npm test
npm run build
npm run audit:build -- --json=/tmp/noitamap-build-audit.json
```

The audit walks emitted static imports, checks local dependencies exist, reports
raw/gzip/Brotli sizes, and fails above 280,000 bytes of initial local gzip JS.
Review new imports before intentionally changing that budget. Tiny compression
differences between builds are expected from the build stamp and chunk hashes.
The build-policy test also prevents PNG/ZIP/GL/bake/dev/engine/atlas code from
reentering the eager graph and checks CSS and script ordering.

No browser automation was run. For manual validation, use a production preview
(`npx vite preview --host 127.0.0.1 --port 4173` after building). Dev mode uses
unbundled modules and does not demonstrate these payload changes.

Check a fresh daily map, yesterday, a generated arbitrary seed, and a static map;
then reload warm. Check language switching, first search, Pro/free reports,
creature/material/wand cards, spawn boundaries, and seed replacement. Use the
Network panel to confirm the chosen locales, one local CSS file, and cold ZIP
GET without HEAD. After deployment, verify `Content-Encoding` and the `/build/`
cache header on actual responses. Capture first visible terrain and usable
search/report times before making latency claims.

Remaining measured candidates are the eagerly built SVG boundary overlays and
the shared card/render bridge. Deferring those needs their own lifecycle work;
the current cleanup does not pretend those large modules are fully split.
See [code organization](code-organization.md) before deleting or moving shared
public/Pro/native-baker code.
