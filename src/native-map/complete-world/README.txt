Owned completed terrain/scenes page source

createCompleteWorldSource(world, options) accepts an actual NativeWorldDescription,
revision-matched NativeAssets, compiled material/edge WASM, generator config,
explicit empty-topology0 policy and explicit scene policy. It prepares its own
material inputs, scene sources/placement pixels, static masks, liquid runs,
foreground/background ownership, background sprites, edge tables and seams.
No Telescope package, reference callbacks, application state, DOM or implicit
network loader is part of this runtime dependency graph.

The contract is exactly scope:'terrain-scenes-layer'. Completed pages include
the dynamic terrain, scene art, liquid leveling, edge decals and their backdrops.
Static-map/captured-art exclusions stay transparent under the supplied host
policy. This is not the whole visible map: the captured/static base and POI
presentation/binding remain separate inputs. Nothing here invents that artwork.

Typical assembly:
  const source = await createCompleteWorldSource(world, {
    assets, materialModule, edgeModule, generatorConfig,
    hostPolicy: 'legacy-fill',
    scenePolicy: createCurrentMapScenePolicy({
      capturedGold: 'static-capture', mapWidth: world.worldSize,
    }),
  });
  const page = await source.renderPage({
    horizontal: 0, vertical: 0, column: 35, row: 15,
  }, signal);
  // page.pixels is durable completed RGBA; pass it to SharedPixelStore/addPage.
  source.dispose();

renderPage uses zero-based physical-region page coordinates. renderRect takes
absolute world coordinates inside its explicit region. regions supplies exact
bounds; pageAddresses lazily enumerates all addresses. Normal width is 35840px
and NG+ width is 32768px, with Y=-7168+vertical*24576. The source raw/material
paths independently preserve NG+'s 32760px content stride and 32768px biome
pitch. Full aligned pages are suitable for the all-page cooker; custom partial
rectangles do not imply a sealed full map. All nine regions are required unless
requireAllNine:false is explicitly supplied.

Jobs serialize across the shared scalar/edge kernels. Native arrays are consumed
or copied before the next query. Resolver LRU admission reserves the next
context's worst-case allocation before construction; default retained resolver
budget is 128 MiB. Prepared scene and decoded source caches have separate explicit
budgets, and active scene/page work has its own bound. Stats report these classes
separately: the resolver budget is NOT a whole-process/whole-world heap claim.
Shared geometry, atlas, immutable background resources and static-mask/index
inputs exist outside resolver/cache residency. Callers retain final page bytes.

Cancellation is cooperative before/after asset work, per source-item check,
every 64 initialization placements, and between page stages. A single synchronous
WASM/scene/composition call completes before cancellation is observed. The
default checkpoint yields a macrotask; workers can provide yieldControl.
dispose invalidates pending work and drops native/prepared/source caches.

Legitimate raw/legacy/unowned material classes use the owned raw color path;
their source material identity remains -1 for the existing edge policy. Missing
modifier inputs, unsupported material configurations and out-of-carve-table
requests throw UnresolvedWorldMaterialError. An unresolved or cancelled page is
never published. Source/asset/policy setup failures also propagate explicitly.

Validation:
  node node_modules/vitest/vitest.mjs run tests/complete-world-runtime.test.ts
  node src/native-map/complete-world/verify.mjs

The real fixture generates NEW seed 20261014 using the owned world generator,
then compares 11 completed 512px pages across all nine regions plus vault and
shaft against the unchanged CPU/JS-edge reference. It feeds those actual pages
through SharedPixelStore.addPage and addBlock/commitPage and compares all 110
local mip reads against reductions of final reference RGBA. It also checks
page bounds, all 30240 normal-world addresses, cache limits, resolver eviction,
cancellation, queued-call isolation, disposal and the production module boundary.
No full-world raster bake is run. parity-result.json records bytes and timings.

Measured host run: world-generator setup about 291ms, world decisions 649ms,
source setup about 2.1s, page raster 89-244ms, store commit 20-45ms. These are
correctness-fallback measurements, not an instant path and not weak-device
acceptance. This implementation must not be enabled as the user's instant path.

Remaining work for an autonomous instant all-page cook:
  - Reusable authored whole-tile interiors with exact material/absolute-phase
    bindings, and exact boundary/scene/liquid/edge bindings. A prepared result
    must cover every input before avoiding the scalar page.
  - Complete prepared-page coverage and all-page sealing. This source exposes a
    scalar correctness fallback; rendering 8B seed pixels is not the strategy.
  - Explicit captured/static-base preparation and final POI/art presentation
    binding outside this terrain-scenes-layer contract.
  - Keep known inherited material accuracy limits and unresolved domains explicit;
    sampled source parity does not establish all-pixel independent game parity.

Attribution: derived Lymm Telescope MIT algorithms retain license notices in
complete-materials/cook-inputs/composition. Scene host-policy constants are copied
from Noitamap's telescope-osd-bridge/captured-gold-room. provenance.json records
this source, dependencies and validation fixture identity.
