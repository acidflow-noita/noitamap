Prepared material sampling

material-edge-plan.h prepares exact sample addresses and cross-stencil predicates
for the f32(.33), threshold .5, type-2 material sampler. Preparation reads no seed,
coverage lattice or material labels. The same codes can bind multiple seeds.
Current coverage and material-label equality still determine the result.

The common 16 decisions can also bind to a two-byte mask per nominal lattice
cell. bind_material_edge_groups clears and regenerates masks from the current
coverage, labels and exact sampler parameters. Call it after any input changes;
these masks belong to one seed. Only coordinate plans are reusable across seeds.
Rare coordinate codes use the exact direct-stencil resolver instead.

Two-byte codes preserve separate nearest-material rounding, strict/non-strict
coverage comparisons and toroidal grid addressing. Coordinate frames include the
world X offset, vertical translation and optional local shaft origin. Unsupported
codes require the original exact resolver. Full colors, liquids, scene overlays,
edge decals and mip reductions remain separate dependencies.

This is a building block for reusable preparation, not an instant full-map claim.
The standalone prototype validates its footprint before any map-sized promotion.
There is currently no application import or change to live map generation.
Arithmetic derives from the MIT-attributed owned materials code; see
../materials/NOTICE.txt and ../materials/LICENSE-telescope.txt.

Build and validation
- WASI_SDK_PATH=/path/to/wasi-sdk node build_scripts/build-native-stencils.mjs
- node build_scripts/build-native-stencils.mjs --check
- npm test -- tests/prepared-material-compiler.test.ts tests/prepared-stencil-codec.test.ts
- npm run typecheck
The checked-in WASM is 9,362 bytes. The compiler reuses 917,504 bytes of scratch
memory and returns self-contained packed fields. Persistent field identities
include both the arithmetic module and codec; the key excludes the seed and
includes the rectangle, map width, plane translation and optional shaft origin.
The module accepts an explicit byte buffer or a Vite-resolved asset URL.

Bounded experiment (task/native-type2-recipes, 2026-10-14)
- Six 554x554 main-plane rectangles, including both parallel worlds. This is not
  a nine-region pack. Stored coordinates use 16 symbols at four bits per pixel.
- Direct field data: 921,248 bytes resident / 168,010 bytes gzip.
- Optional group-selector data: 1,061,856 bytes total resident / 276,914 gzip,
  plus 31,578 bytes mutable masks per seed. It does not expand fields on restore.
- Four actual seeds match material outputs; NG+ exercises exact fallback.
- 341,038 independent sampler/coordinate comparisons; coverage ties, negative
  wrapping, both map widths, vertical planes, shaft origins and changed inputs.
- 42 completed 512x512 first/cached tile comparisons match 44,040,192 RGBA bytes.
  This fixture includes ordinary finishing and one synthetic force-air scene;
  it is not a full world with all actual scenes/POIs or Noita capture validation.
- The incremental material-stage gain is small. Full-color cooking, source-pack
  locality, unsupported material families and all-nine readiness remain open.
