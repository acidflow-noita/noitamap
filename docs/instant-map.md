# HD terrain renderer (`instant-map`)

The dynamic map can render terrain at the resolution currently requested by
OpenSeadragon instead of computing full-resolution descendants for every
overview tile. The implementation uses vitaminmoo's pinned `render-perf`
renderer, with the verified shader corrections described in
[terrain-shader-evidence.md](terrain-shader-evidence.md).

## Local use

```sh
npm run dev
```

Open `http://localhost:5173/?m=dy&se=786433191&u=all&nb=1`.
**Performance → HD renderer** is enabled by default. Turning it off saves the
approximate-renderer preference and reloads with the same seed, unlocks and
camera position. `nb=1` bypasses daily baked images. There is no Pro build or biome rebake
requirement. `npm run build` builds the public map for deployment review.

`npm run dev` and `npm run build` automatically prepare the seed-independent
Telescope scene assets, reusing them when their source fingerprint and checksums
match. Changes to either Telescope fork, source archives or preparation code
regenerate both packs. Generated files live in ignored
`build_data/telescope-scenes/`; Vite ships content-hashed assets. For standalone
Vite or native benchmark commands, run `npm run prepare-telescope-scenes` first
if those files are missing or stale. This preparation does not require a Sage
or daily biome bake.

Ordinary generated-map links use HD unless the user has disabled it. Validated
daily images retain their baked path. The preference uses `noitamap-hd-renderer`
and does not revive the old offline `noitamap-gl-terrain` setting. Diagnostic
links can override it with `terrain=gpu` or `terrain=approx`; changing the switch
removes that override. If browser storage is blocked, the switch uses the URL
override to retain its choice through the reload.

NG+/nightmare retain approximate presentation. Generation, background workers,
asset tables and cache identities use one matching fork throughout GPU mode.
Legacy cached generations cannot be mistaken for render-perf generations.
HD uses OSD's canvas drawer even if localhost has a saved WebGL
drawer override; terrain shading itself remains on the GPU.

## What changes

- Each requested tile retains at most 256 × 256 display pixels. Coarse tiles
  use one bounded draw of at most 512 × 512 samples, then filtered reduction. It never walks a
  full-resolution pyramid or PNG-encodes terrain. Camera movement, layer order,
  POI interaction, scene layers, screenshots and tile eviction stay with OSD.
- Horizontal worlds share GPU resources. After first paint, small overview
  requests warm heaven and hell in the background. A plane offset preserves the repeated source
  geometry while evaluating noise at absolute game coordinates.
- Existing procedural ownership and authored scene masks protect static map
  artwork and room air holes. The renderer does not clear entire scene rectangles.
- Obsolete seed and viewport jobs cancel. GPU initialization/drawing failures
  restore the approximate presentation. The first-draw diagnostic listens for
  an actual OSD terrain tile draw, rather than merely queuing an image.
- The legacy approximate path composites/encodes three terrain images instead
  of nine when horizontal pixels are provably identical. NG+/nightmare and
  coordinate-dependent fill layers do not use this reuse.
- Large approximate PNGs encode in a worker. Cancellation terminates it, and
  the pure RGBA encoder preserves the existing privacy-browser handling.
- Scene/generation consumers request raw PNG pixels without constructing an
  unused ImageBitmap. Visual bitmap consumers keep their existing contract.

Console: `[Instant terrain] First tile drawn` includes resource upload time,
number of initialized planes, tile count and shaded pixel count. Each terrain
source also exposes `instantStats`. Tile submission time includes canvas copying
but is not a GPU timer or a complete browser interaction benchmark.

Independent startup work now overlaps: daily identity lookup with explicit live-GPU
asset/shader startup, cache reads with asset initialization after a shared cache
revision check, and background artwork/sprites with generation. Terrain resource
preparation starts after Wang geometry is ready, before POI scanning finishes.
The completed map still applies its full scene masks before presentation. A
cancelled request cannot attach late artwork or replace the current map. Explicit
live requests no longer fetch the previous-daily pointer unnecessarily.

## Reproducible measurements

No browser tests were run. Native tests execute real GLSL through EGL/GLES and
real raster/PNG code; lifecycle tests simulate OSD's tile loading contract.

```sh
node build_scripts/benchmark-instant-terrain.mjs --seed 786433191 --iterations 9 --out task/instant-map/benchmark.json
```

Add `--require-hardware` on a machine with a usable hardware GLES driver. It
rejects software renderers. This VM has Mesa llvmpipe, so hardware GPU performance
and end-to-end browser loading/interaction remain unmeasured. No game data was
missing; Ghidra-MCP inspected the existing executable and project.

Initial native runs on seeds 42 and 786433191:

| Work | Measured time |
| --- | ---: |
| Completed warm GPU shader draw, 512² overview | 4.50–5.42 ms |
| Completed warm GPU shader draw, 512² detail | 2.77–2.99 ms |
| Completed warm GPU shader draw, 1080p overview | 21.58–21.77 ms |
| Cold assets + main-world generation + first GPU terrain draw, initial | 7.49–7.62 s |
| Subsequent seed generation in the same initialized process | 387–388 ms |
| Approximate nine-region raster + PNG encoding, before | 3.35–3.53 s |
| Approximate nine-region raster + PNG encoding, after reuse | 1.10–1.17 s |

A separate controlled startup comparison for seed 786433191 measured assets
plus generation at **5.20 s before → 2.84 s after** removing unused bitmap
construction and sharing duplicate Wang templates. Seed 42 confirmed
**5.06 s → 2.83 s**. Cold first terrain fell from **7.79 s → 5.35 s** and
**7.58 s → 5.33 s**, respectively, on this software renderer. Generation fingerprints
(biomes, geometry, POIs, scene placements) and four finished-image hashes were
unchanged. Native bitmap construction uses the Skia adapter; browser startup
must still be measured separately.

The next startup change precomputes seed-independent scene PNG decoding and
spawn scanning during that build step. Runtime initialization fetches an exact
packed scene table and expands it on a worker, transferring its buffers back
without copying the expanded pixels. Base maps, translations, bounded Wang
image loads and scene installation run concurrently. Light mode falls back to
the same inline decoder if workers are unavailable.

In isolated native runs, assets plus main-world generation fell again from
**2.844 s → 1.052 s** for seed 786433191 and **2.832 s → 0.957 s** for seed 42
(63–66% less time). Initialization itself took **499–502 ms**. The old and new
generation fingerprints and all four finished-image hashes matched for each
seed; preparation additionally compares every scene pixel, metadata field and
spawn record against the original upstream loaders. These are one-world native
measurements with local assets, not network or browser timings.

| Prepared input | Scenes | Download (gzip) | Encoded payload | Retained decoded buffers |
| --- | ---: | ---: | ---: | ---: |
| Approximate fork | 334 | 488,197 B | 3,233,644 B | 171,307,376 B |
| Render-perf fork | 352 | 2,308,041 B | 18,565,152 B | 265,725,604 B |

The runtime bypasses `pixel_scenes.zip`; it still needs `data.zip` for other
assets. The expanded scene tables remain large. Exact RGBA run encoding reduces
decompression work and sharing avoids duplicate immutable blocks; this is not
a claim that full scene memory has become small.

Evidence is retained in
`task/instant-map/benchmark-startup-final{,-seed42}.json` (before) and
`task/instant-map/benchmark-packed-scenes-final{,-seed42}.json` (after).
To include side-world generation in another run, add `--worlds 0,-1,1` to the
benchmark command; terrain shader samples still measure the main world.

Shader timings wait for `glFinish`; they exclude scenes, canvas transfer, OSD and
network. Approximate timings verify identical decoded pixels and placements.
Worker encoding moves roughly 915 ms of blocking work off the caller in a
7.68-million-pixel fixture; submission took about 6 ms, while total encoding
time stayed approximately the same. These are separate measurements, not an
end-to-end speedup claim.

## GPU worker startup

Terrain resource construction, uploads and shader drawing now execute in a
persistent OffscreenCanvas worker when supported. Shader compilation starts
before archive loading: a build-time module derives the exact shader constants
from the pinned source without evaluating archive-dependent generator imports.
Tests require identical shader strings and forbid worker asset fetches before
initialization. Main-context and approximate fallbacks remain available.

A cold native run with Mesa's shader disk cache disabled measured:

| Phase | Elapsed from startup |
| --- | ---: |
| Assets and main-world generation complete | 0.975 s |
| Worker resources ready | 1.431 s |
| First 128 × 128 terrain tile returned | 3.371 s |
| Three reference tiles returned | 3.381 s |

During worker resource preparation and drawing, the caller's maximum measured
heartbeat gap was 6.6 ms. This does not measure main-world generation stalls,
network, scene composition or browser presentation. All 196,608 returned RGBA
bytes matched independent shader rendering. The native harness substitutes
transferred RGBA for browser ImageBitmap transport. The app can start resources
earlier than this fixture, through the terrain-ready callback.

The software driver's first real draw remains expensive. A dummy warmup draw
caused a second specialization and made startup slower, so the shipped prewarm
only compiles and links. These results do not establish hardware GPU timing or
instant cold browser loading. See [shader evidence](terrain-shader-evidence.md)
for the test command and details. Worker requests have deadlines; stale seed
work cancels without launching an approximate render of the previous seed.
Leaving dynamic mode releases workers and their retained resources.

## Parallel-world generation reuse

The side-world scanner now retains at most two workers. Creation waits for the
shared `data.zip` cache write, because worker module imports read that archive
from cache. Each then decodes its immutable scene pack directly on its own thread during main initialization,
then processes one seed at a time. Production dispatch never clones the large
raw RGBA scene snapshot from the main thread. Seed-specific recolor variants
are cleared between jobs; changing forks retires idle workers rather than
keeping both large scene sets. Failures retire the affected worker and reject
its request. Leaving the dynamic map disposes the pool and releases its scene
tables; ordinary reseeding keeps it warm. Leaving during the archive download
cannot start workers after disposal.

Native tests compared every generated POI and scene placement against fresh
workers for seeds **42 → 43 → 42** and unlocks **all → none → all**, in both
Telescope forks. The return to seed 42 reproduces the original output exactly.
For render-perf, preparing both workers took 530 ms (overlappable with main
initialization). The first scan then took 236 ms versus 617 ms for fresh workers;
subsequent scans took 193–212 ms versus 606–615 ms. The legacy fork measured
176–191 ms versus 565–605 ms after initialization. These compare two side
worlds, not the complete map load. There were zero raw scene snapshot messages
and only two retained workers across all six side-world requests.

```sh
npx vitest run tests/pw-worker-pool.test.ts tests/pw-prewarm-lifecycle.test.ts tests/pw-worker-pool-runtime.test.ts
```

## Zoomed-out terrain quality

The original display path sampled one world point per coarse pixel, then OSD's
pixel-art drawer enlarged those samples without interpolation. The pinned
shader does **not** disable engine terrain or noise at lower zoom: its zoom
uniform only maps display coordinates to world coordinates. Changing that
uniform alone could not solve the lost coverage.

Coarse tiles now sample twice per axis (up to four times for small tiles), with
a hard 512-pixel draw dimension. Ownership and authored scene masks apply
before repeated 2:1 filtered reductions. Native-resolution detail remains exact.
A terrain-only `tile-drawing` handler filters reductions of these sampled tiles;
enlargement uses sharp pixels, including cached coarse tiles during zoom-in.
OSD 6.1 saves/restores the destination context around that event, so POIs and
other map layers retain their existing pixel-art setting. OSD's existing
`minPixelRatio=0.5` already requests a finer
level ahead; this change does not force a full-resolution tile tree or enlarge
the tile cache.

Actual production TileSource tests compare seed 42 against independently
rendered **1:1 terrain reduced over the complete pixel area**, not only sampled
point coordinates. Mean absolute premultiplied-RGBA error (0–255 channel range):

| World pixels per displayed pixel | Previous error | Filtered error | Error reduction |
| --- | ---: | ---: | ---: |
| 2 × 2 | 3.565 | 0 | 100% |
| 4 × 4 | 5.311 | 2.815 | 47.0% |
| 8 × 8 | 2.617 | 1.183 | 54.8% |

These tiles completed shader drawing, clipping and reduction in 6.9–8.1 ms on
Mesa llvmpipe. Each requested tile still used one shader draw and at most
262,144 samples; the largest reference used 4,194,304 native pixels. This is a
native software-renderer measurement, not browser or hardware-GPU timing.
The same integration test verifies 302,464 pixels across Main/West/East against
independent sampled rendering and ownership, sparse scene holes, cancellation,
resource reuse, and first-paint events.

Reproduce with:

```sh
npx vitest run tests/instant-terrain.test.ts tests/instant-terrain-runtime.test.ts
```

## Sharpness while zooming

The viewer now uses `immediateRender: true` for every map layer. OSD's default
prioritizes the coarse overview before the level closest to the destination
zoom, which creates a blurry-to-sharp sequence for static map tiles too. The
new setting requests the closest detail first while retaining already cached
tiles. Network/worker latency can still leave a temporary lower-detail tile;
it is no longer deliberately loaded ahead of the detail the user needs.
Tile crossfades are disabled, so incoming detail replaces the old level directly.

The earlier terrain handler also enabled interpolation when enlarging any
coarse GPU tile. It now filters only actual reductions, keeping the bounded
terrain area sampling while removing that magnification blur. The full viewer
continues to use nearest-neighbor pixels, and tile-edge seam protection remains
enabled.

Native tests execute the installed OSD level-selection and CanvasDrawer methods
(including the intermediate sketch canvas and tile-edge pass). They show the
old policy requests level 0 first for a zoom requiring level 6; the new policy
requests level 6 first. Static tiles remain unfiltered before and after GPU
tiles, with no smoothing state leaking into either context. Enlarged terrain
edge colors remain sharp, while reductions still average their pixel coverage.

```sh
npx vitest run tests/osd-pixel-rendering.test.ts tests/instant-terrain.test.ts
```

## Retained coverage and zoom reuse

An actual moving-camera regression exposed a gap in the original cache fix:
OSD excludes finer levels below `minPixelRatio` before checking whether their
tiles are already loaded. Zooming out could therefore discard visible detail
while replacement tiles were pending. A cached 140 × 96 regional overview
was insufficient to hide that transition.

The viewer now keeps previously drawn fine tiles in OSD's normal draw list
until suitable loaded replacements cover their visible footprint. This applies
to static DZI, HD terrain and scene layers, preserves their transparency, and
leaves OSD's level selection intact. Retention shares a cap of 512 tile
references across the viewer; it creates no canvas copies. Offscreen, unloaded
and replaced tiles release their references, as do removed map layers. When a
view needs fallback, it also finds usable detail still present in OSD's cache
after navigating away and back. A complete view skips that cache scan.

After the first terrain tile actually draws, background preparation warms three
base levels per loaded region: Main/West/East across the main plane, heaven
and hell (nine regions, or three in main-world-only mode). These use existing
OSD tiles. Normal regions retain 140 × 96, 280 × 192 and 560 × 384 pixels:
81 tiles and 10,160,640 decoded RGBA bytes across all nine regions.

Once the camera settles, preparation also covers twice the current/destination
viewport at the next zoom-out resolution, using OSD's world/image transforms.
The plan coarsens if needed to stay within 48 adaptive tiles and the shared
resident pixel budget. Camera changes
discard undispatched adaptive requests; one already active background request
can finish normally. Only one coverage request is dispatched at a time, leaving
queue capacity for normal visible demand. First-time vertical planes still
require resource initialization.

Completed, clipped terrain tiles share a separate **32 MiB decoded-pixel cache**
for the active map. The three base levels are protected ahead of ordinary least-recently
used detail; the limit applies to both. OSD gets independent copies because it
destroys its canvas data on eviction. A different seed or scene-mask lifecycle
clears the cache. Source identity includes the plane/world, so absolute-coordinate
noise cannot be reused across worlds accidentally. This limit excludes OSD's
own cache, transient copies and canvas/driver bookkeeping.

Preparing source-cache pixels alone was insufficient: an actual production
TileSource/OSD regression loaded 240 detail tiles and evicted every level-9/10
base tile from OSD, although all 81 remained in the source cache. Returning to
the overview drew only the level-8 thumbnail. Coverage now keeps its base and
active adaptive tiles resident in OSD, within **160 tiles / 40 MiB decoded**
shared across terrain and the scene layer. This protects existing OSD canvases;
it creates no additional copies and changes no global eviction cutoff. The
same pressure test now draws the six level-10 tiles immediately. Image removal,
seed cancellation and adaptive-plan changes release the relevant reservations.

All map layers now dispatch up to 16 missing tiles per update instead of one.
An FHD replay through the production terrain source and installed OSD needs
**3 request updates instead of 40** to restore 40 cached tiles. These counts
exclude downloads/shader work and are not measured browser frame timings.
Concurrent requests for one tile share a draw; cancelling one request does not
cancel its other consumers. Cache hits bypass GPU scheduling entirely.
Real OSD loader aborts, timeouts and retries each settle once; late worker
results cannot decrement the loader count again or finish a newer attempt.

At most two asynchronous terrain jobs are dispatched at once. Queued jobs are
ranked again against the latest destination viewport, zoom and device pixel density when capacity
opens; current coverage and suitable detail take priority over obsolete detail.
Cancelled queued jobs are removed immediately. Synchronous work retains its
8 ms yielding budget, and failures cannot leave the queue stalled.

Cold requests also need admission **before OSD creates an ImageJob**. Limiting
only GPU work let hundreds of OSD's 30-second clocks run while their requests
waited in the two-slot work queue. Timeout then marked those tiles permanently
missing. Generated terrain and scene layers now share two cold admission slots;
cached copies bypass admission. Current and destination views determine which
unstarted requests remain useful. Obsolete requests clear their loading state
without emitting a load failure. Coverage retains its base/adaptive interests
and starts its own deadline only after admission.

The paired actual-AppOSD test pans across three FHD views using the production
TileSource and a controlled one-second asynchronous renderer. The previous
path started **509 timed ImageJobs** and produced **451 permanent failures** at
30 seconds. Admission keeps **two timed jobs** active and produces **zero
failures**. With continued settled frames, the view fully loads, the queue
empties and native canvas pixels match. The renderer's throughput is unchanged;
this verifies queue handling rather than measuring browser/GPU speed.

Render RPCs have a separate **10-second worker watchdog**; initialization keeps
its 30-second allowance. Cancelling a subscriber keeps the remote watchdog
until the worker acknowledges completion/cancellation. Otherwise an OSD timeout
could cancel that watchdog first and leave a hung worker reused indefinitely.
The real ImageLoader/source/client regression verifies one generation fallback,
released queue capacity and closed late bitmaps before the outer 30-second
deadline. A responsive worker's cancellation acknowledgment clears its watchdog.
Lazy heaven/hell preparation failures also reach the generation fallback after
their original tile callers have cancelled, avoiding a stranded rejected
resource promise. A regression verifies one fallback and removal of all nine
HD layers in this case.
On-demand diagnostics: `__osdViewer.terrainAdmissionStats` exposes active/queued
cold jobs, completed-cache admissions and discarded obsolete requests.

Native production-source verification revisited six tiles across three worlds
and two zoom levels, including destroying OSD's returned copies. **12 requests
performed zero GPU draws**, with 236,928 compared pixels unchanged; copying and
byte comparison together took 8.23 ms in this VM. Installed-OSD tests also verify
all-nine-region preloading and drawable coverage while finer tiles are withheld,
and restored CanvasDrawer output remains identical after mixed-source eviction.
Separate moving-camera tests reproduce the original fine-tile disappearance,
then verify repeated zoom-out, transparent holes and replacement handoff through
the real CanvasDrawer for both DZI and HD sources. Further tests cover partial
replacement, two 135-tile layers, retention limits and removal cleanup.
An additional fixture constructs the actual AppOSD/Viewer/World/CanvasDrawer
and runs scheduled frames through a pan-away-and-return sequence; usable cached
detail survives while the desired replacement level is unavailable.
These are native checks, not measured browser zoom timing. New uncached detail
and first-time overview preparation still take work; repeated navigation within
the cache no longer shades the same pixels again.

```sh
npx vitest run tests/osd-app-continuity.test.ts tests/osd-terrain-admission.test.ts tests/instant-terrain-hung-worker.test.ts tests/osd-load-budget.test.ts tests/osd-tile-continuity.test.ts tests/osd-zoom-continuity.test.ts tests/instant-terrain-residency.test.ts tests/instant-terrain-cache.test.ts tests/instant-terrain-coverage.test.ts tests/instant-terrain-osd-abort.test.ts tests/pixel-scene-tile-source.test.ts tests/terrain-work-queue.test.ts tests/instant-terrain.test.ts tests/instant-terrain-runtime.test.ts
```

The `[OSD Bridge] Pixel-scene prefetch` console message describes scene-artwork
preparation in IndexedDB after a seed render. It is separate from terrain tile
coverage and is not invoked by ordinary zoom. Concurrent warmups share a job;
later seed renders recheck the persisted artwork cache.

Composed scene tiles now also have a separate **16 MiB decoded-pixel cache**.
The scene layer joins the existing HD coverage scheduler, with two base levels
and the same adaptive/residency limits. Its full 512 × 512 canvas allocation is
counted even on edge tiles. Uncached composites yield during large scene lists;
removal cancels pending consumers and releases owned bitmaps/cache pixels.
Native tests compare output against the previous compositor's placement and
overlap rules. This avoids repeated room compositing without changing artwork.

## Accuracy and remaining work

Display-resolution shading now integrates multiple samples per coarse pixel.
Its overview remains a bounded approximation to a reduction of all finished
native-resolution pixels; sufficiently small features can still alias. Existing scene artwork is composed separately; the native
baker's complete liquid/edge finishing pass is not run for every display tile.
The continuous lower Power Plant shaft uses a separate CPU material field in the
baker and is not newly certified by this GPU path.

Corrected material probes and camera tests establish only their tested regions.
Floating-point thresholds can still differ between the CPU and GLSL. The
full-map decoded-pixel parity gate still applies to a GPU daily-bake replacement.

Cold downloads and first shader compilation remain separate bottlenecks even
with scene decoding moved into prepared assets. This work does not make a complete
multi-billion-pixel daily export instantaneous. Manual review should cover main,
west/east, heaven/hell, room air holes, rapid reseeding, context loss, light mode,
POI/drawing interactions and overview/detail transitions.
