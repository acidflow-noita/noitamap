# Terrain performance review

The main cost is the amount of pixel work, readback and storage, rather than
the wrapper's size. Fast visible terrain and a completed exact map are separate
milestones. Keep completed native pixels authoritative across zoom changes;
use a preview only where those pixels have not yet been generated.

This audit compares public-map baseline `1427ad5`, prior work
`origin/instant-map` (`22b2304`), and the updated Telescope fork. Source links
below describe the baseline unless stated otherwise. No local-app browser tests
were run. The native measurements below were collected on the updated branch;
the user separately authorized measurements of the deployed upstream site.
See the [deployed-site report](deployed-telescope-measurement.md) for verified
Render Everything runs, software-GPU conditions and completion limitations.

## September 28 upstream update and next work

The pinned `render-perf` submodule advances from `fa9cd25` to `9c58775`:

- `1b26ba0` preserves scene/material transparency when zoomed out. The shared
  material palette now uses mean texture alpha instead of assuming the XML
  alpha describes the rendered texture. Scene visual art applies to translucent
  cells too; opaque artwork makes those painted cells opaque, without filling air.
- `9c58775` moves standalone controls into an Options modal and enables Lake by
  default. The host already enables Lake and supplies its own UI.

Neither commit accelerates terrain computation. Shader source is unchanged,
including the boundary where the host applies vertical/elevator corrections.
The host scene-art helper needed the same translucent-cell correction; it now
matches upstream for all 65,536 cell/art alpha combinations and unequal image
dimensions. Upstream per-mip scene air masks do not change the native scene-pack
API used here. Scene packs were rebuilt and verified, and derived terrain cache
revision `full-pixel-v12` prevents reuse of older output. Unchanged source ZIPs
remain reusable.

Current display uses complete worker viewport frames with native backgrounds,
scene artwork and POIs drawn directly, rather than foreground tile jobs. The
zoom-continuity repair keeps up to three earlier coverage frames within an
additional 32 MiB decoded budget. It prefers a wide surrounding view through
small zoom steps. Earlier frames are clipped outside newer coverage, so a new
transparent hole cannot reveal obsolete terrain. Native completed pages remain
separate and authoritative. Real OSD/native-canvas tests reproduce and repair
the missing live surroundings; gradual baked-DZI/legacy-HD tests did not
reproduce a baked-map dropout. Local browser verification remains manual.

The next substantial changes should target these remaining costs:

1. Split the cold runtime payload. `public/data.zip` alone is 24,842,915 bytes:
   about 1.99 seconds at 100 Mbps before latency, decoding or computation. A
   smaller runtime subset and compact metadata are necessary for the specified
   cold one-second target. Persistent reuse helps later visits, not this bound.
2. Batch contiguous native terrain work and move clipping, ancestor reduction,
   encoding and persistence into the rendering worker. The sweep currently
   serializes up to 30,240 candidate 512px blocks through worker rendering,
   main-thread canvas capture/reduction, codec-worker PNG encoding and bounded
   IndexedDB writes. Empty/static footprints already skip shading. Batches must
   yield to navigation and preserve exact alpha, ownership and scene masks.

Compatibility validation passed 25 focused host checks, four upstream Node
test files, and 42 native/resource/policy checks. The emitted worker matches
1,139,200 viewport RGBA bytes and 196,608 shader-reference bytes with zero
differences. These software-llvmpipe checks establish sampled correctness, not
hardware/browser speed or full-map completion. The sub-one-second all-nine
region target remains unmet.

## Measured on this checkout

[Native benchmark output](terrain-benchmark-2026-09-27.json), collected before
the shared-resource refactor, seed `786433191`,
three timed iterations, Telescope `fa9cd25`: Mesa llvmpipe software rendering,
not a hardware GPU or a browser. The benchmark waits for actual draw completion.
Timing includes source assets read locally, with no network download.

| Work | Measured time |
| --- | ---: |
| Source loading and first seed generation | 761 ms |
| Resource upload/build/compile | 704 ms |
| First completed shader draw | 2,277 ms |
| Warm 512×512 overview shader, median | 4.54 ms |
| Warm 512×512 native-detail shader, median | 2.63 ms |
| Warm 1080p overview shader, median | 25.69 ms |
| Subsequent seed generation | 331 ms |
| Warm exact-tile GPU/readback stage | 5.3–5.7 ms |
| Exact-tile CPU finishing stage | 104–181 ms |

The first exact-tile GPU sample also includes a cold draw (2,214 ms), so it is
excluded from the warm GPU range. Shader-only timings exclude scene composition,
readback and presentation; exact-tile timings include the existing finishing
pipeline. This is evidence for separating compilation, CPU finishing and display
work, not a before/after speedup claim or a full-map completion measurement.
Coordinate validation uses flat material colors because the updated shader
intentionally filters textured overview pixels; timed draws keep textures on.

## Retention repair delivered on instant-map

The live HD option is present on `instant-map`. [Retained terrain pages](../src/telescope/retained-terrain.ts)
now keep native samples and their reduced ancestor pixels separate from OSD's
disposable display canvases. A coarse preview cannot overwrite completed detail,
including completed transparent pixels. Lossless optional persistence supports
reuse after decoded-cache eviction; memory and pending writes are bounded.
See [the implementation notes](instant-map.md) for storage-failure limitations.

The production TileSource/native GLES regression compared 302,464 native and
overview pixels across the main, west and east worlds. Twelve repeat navigation
requests issued zero shader draws. Additional retention tests cover disk reload,
concurrent completion, memory pressure and unavailable storage. These validate
retention; they do not meet the [cold full-map target](full-map-generation-plan.md).

## Baseline exact path (`1427ad5`)

- At this baseline, public live maps used approximate terrain; the full-pixel
  switch belonged to offline baking. The current `instant-map` live HD option
  is described above.
- The exact pyramid renders only native-resolution leaves and reduces all
  children. An uncached overview therefore walks its entire descendant tree
  ([pixel-pyramid.ts:184](../src/telescope/pixel-pyramid.ts#L184)). Empty footprints
  are already skipped conservatively
  ([terrain-footprint.ts:11](../src/telescope/terrain-footprint.ts#L11)).
- A 70-by-48-chunk region is 35,840 by 24,576 pixels: 880,803,840 pixels,
  or 3.52 GB of uncompressed RGBA. Nine regions contain 7.93 billion pixels
  and 31.71 GB RGBA, before pyramid levels. These are bounding-box sizes;
  empty/static-region skipping lowers actual work.
- Every generated tile waits for PNG encoding and an IndexedDB transaction
  before entering the completed cache. The default memory cache retains only
  32 tiles ([pixel-pyramid.ts:244](../src/telescope/pixel-pyramid.ts#L244),
  [terrain-tile-store.ts:55](../src/telescope/terrain-tile-store.ts#L55)).
- Main-plane GPU pixels pass through canvas readback, an extra RGBA copy,
  CPU scene/liquid/edge finishing, and another canvas draw
  ([terrain-presentation.ts:31](../src/telescope/terrain-presentation.ts#L31)).
  Heaven and hell explicitly use CPU rendering
  ([gl-terrain-tile-source.ts:165](../src/telescope/gl-terrain-tile-source.ts#L165)).

Two bounded correctness repairs precede optimization: use the existing optional
database wrapper for terrain tiles so blocked opens and aborted transactions
cannot strand rendering; include actual NG+ count and scene/generation identity
in persistent keys. The baseline key includes an NG+ boolean rather than the
count ([gl-terrain-tile-source.ts:394](../src/telescope/gl-terrain-tile-source.ts#L394)).
These are findings, not claims that this review implements the repairs.

## Existing work worth reusing

Commit `22b2304` already contains worker-based WebGL rendering, prepared scene
packs, retained generation workers, bounded tile caching, OSD coverage retention,
request admission and cancellation. Its `docs/instant-map.md` records native
measurements and reproduction commands. Those historical results are not fresh
measurements of this checkout or hardware/browser guarantees.

That branch shades at most 512 by 512 samples for each requested display tile
(`22b2304:src/telescope/instant-terrain.ts:88`). Coarse pixels therefore remain
an approximation. Fine OSD tiles survive only until replacement coverage arrives;
the separate 32 MiB terrain cache also evicts detail. Native liquid/edge finishing
is omitted from that path. Importing the branch wholesale would not meet the
requirement to preserve completed final-pixel detail.

The upstream lazy-scene update also changes the host contract: metadata records
can have `imgElement: null`. Consumers must await `ensureScenePixels` before
building materials, masks or recolored images. Merely updating the submodule
would let the old null checks skip scene content. The artifact's older
viewport-only description is useful architecture context, not the latest API
contract ([saved artifact](../task/artifact/Telescope%20GL%20Terrain_files/saved_resource.html)).

## Route to fast rendering without losing completed detail

1. Separate visible requests from background map completion. Render nearby exact
   leaves first; propagate their filtered pixels into ancestor tiles immediately.
   Track exact coverage so a sampled preview cannot overwrite completed regions.
   Never require a full descendant traversal merely to display an overview.
2. Keep GPU resources and intermediate tiles on a persistent worker. Move finishing
   passes onto the GPU only after parity checks cover scenes, force-air holes,
   liquids, biome edges, elevator continuations and all vertical planes. Until
   then retain the existing exact finishing path for affected content.
3. Reuse completed leaves and exact ancestor reductions across zooms. Maintain
   bounded GPU/RAM caches plus lossless persistent tiles; publish completion
   before encoding, with a bounded persistence queue that owns pending pixels.
   Include source revision, seed, NG+, mode, scene identity, world and plane in keys.
4. Batch GPU readback and worker encoding outside the interaction path. Share
   immutable source geometry across worlds, but evaluate noise at each world's
   absolute coordinates. Reuse final pixels only where equivalence is proven.

Finite RAM cannot retain every world pixel. Persistence allows reuse beyond RAM
eviction, subject to available storage. Exact overview completion still requires
evaluating every contributing pixel. GPU execution can greatly reduce that cost;
it does not make multi-billion-pixel cold computation equivalent to fetching
an existing daily DZI.

## What OSD can contribute

### Parallel-world transitions

Telescope's fast boundary crossing has a concrete mechanism: its
[terrain resource key](../lib/noita-telescope-vm/js/gl/terrain_renderer.js)
does not include the camera or parallel world. One persistent context shades
new absolute coordinates with the existing terrain data. Its
[world worker](../lib/noita-telescope-vm/js/world_worker.js) separately scans
prescanned spawns for world-specific scenes and POIs; crossing a boundary does
not repeat Wang generation. The app requests worlds slightly ahead of the
visible bounds. The deployed measurements above do not isolate per-world
worker latency.

The host already shares horizontal geometry/renderers and warms offscreen base
tiles plus an expanded viewport. Its remaining transition costs include tile
production/transport and scene/POI composition. Before the shared-resource
refactor, vertical planes also used separate workers/contexts, rebuilding and
uploading the same roughly 52.84 MB coverage/material lattice. Only five small
lookup textures need distinct plane variants (50,400 bytes per NG0 plane).
The implemented shared GPU resource owner removes that duplicate preparation
without changing OSD's presentation or retained native pixels. Against the
previous three-renderer layout, native GLES checks matched 95,232 pixels across
39 windows and all 10,080 plane lookup cells. Upload payloads fell from
205,728,672 to 68,677,024 bytes (66.62%), with lattice builds reduced from three
to one. Switching prepared planes required zero uploads, compilation or lattice
builds. These are resource counts and sampled parity checks on llvmpipe, not
browser panning measurements or driver-memory totals.

OSD's built-in horizontal/vertical wrapping repeats the same source tiles.
The host instead positions distinct generated TileSources at each world's
coordinates, with world-specific scenes/POIs and retention keys. That permits
different content across a seamless boundary without image wrapping. Navigation
remains limited to the existing nine regions; explicit world coordinates and
cache identities leave room for generating farther worlds later.

Keep the host's vertical corrections: the noisy lattice lookup is translated
after evaluating noise in absolute coordinates, and each local cell retains
its coverage-dependent engine mode. Simply selecting the upstream main map's
top/bottom lookup row changes those pixels. Resource sharing must preserve
the existing output, static masks, elevator handling and POI layer ordering.

Another independent startup cost remains: the live pipeline waits for all
requested worlds' scene/POI results before installing the terrain sources.
Removing that join requires incremental publication and a separate explicit
all-nine completion barrier. Smooth navigation and the complete-map target
must both be measured; neither substitutes for the other.

### Tile presentation

Reuse `22b2304`'s demand admission before starting timed image jobs, destination-view
priorities, cancellation, shared requests, protected overview residency and fine
tile fallback. Increasing dispatch per frame helps cached tiles return promptly;
it must not create unbounded cold GPU jobs. `immediateRender` can prioritize the
needed level, while retaining usable old coverage until replacement is ready.

Keep cached pixel ownership separate from OSD: it may resize its canvases to zero
on eviction. Filter exact reductions, retain sharp enlargement, and preserve
transparency when replacing regions. Canvas presentation is compatible with GPU
terrain generation; changing OSD drawers alone removes neither shader work nor
readbacks. A shared-context GPU drawer could reduce copies, but increases OSD
coupling and requires testing existing overlay behavior.

## Measurement and acceptance

Use native EGL/GLES and existing real-worker fixtures for host verification.
The deployed upstream site has a separate browser-measurement exception;
local-app browser testing remains manual.
Record cold initialization, GPU resource preparation, first usable view, first
exact view, finished-map time, shader time, readback/finishing/encoding time, peak
decoded bytes, and queued work separately. Identify hardware versus software
rendering and compare fixed seeds/regions against the same baseline.

Run the existing `terrain-renderer-runtime`, `cpu-terrain-runtime`,
`pixel-pyramid`, and `terrain-pyramid` suites after relevant changes. Extend
production-source tests to require zero shader draws when revisiting retained
tiles, stable exact ancestor pixels through zoom-out/in, and unchanged output
after OSD destroys display copies. Exercise storage stalls, quota failure,
cancel/reseed, and cache pressure. Verify images against independent native
reductions and established engine fixtures; matching two implementations alone
does not establish game accuracy. Manual review covers actual zoom smoothness,
first-load latency, overlays and GPU context recovery.
