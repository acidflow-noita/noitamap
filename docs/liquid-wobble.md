# Liquid wobble

The dynamic map applies Noita's world-anchored liquid refraction to eligible
material pixels, including lava. It checks the original and displaced sample
and protects nearby solid pixels and POI sprite footprints. The material rule,
native evidence and static-map adaptation are documented in
[liquid-refraction-evidence.md](liquid-refraction-evidence.md) and
[static-liquid-masks.md](static-liquid-masks.md).

## Rendering and resource limits

The existing map draws first. A small worker reads the sparse material masks
and prepares the visible area while camera movement is still running. Known
liquids publish before slower missing data: captured pools before a Daily mask
download, and captured/cached blocks before live GPU queries. New live blocks
resolve nearest the visible center first and publish partial results at most
once per 160 ms, followed by the complete result. Non-daily maps query
256-pixel blocks through the already-warm terrain shader, with asynchronous
readback and background queue priority. Scene material replacements and terrain
ownership are applied before rendering. These queries never start another
terrain renderer or run on every animation frame.

One finished map crop and its material mask are uploaded to a separate small
WebGL2 program. The animation is capped at 30 frames per second. It performs
no terrain regeneration, texture upload, canvas readback or network request
per frame. A nonblocking GPU fence admits at most one upload/frame at a time;
slow devices retain the preceding image instead of accumulating draw commands.

The crop is first copied into one reusable, bounded 2D surface. A whole-surface
bitmap is then uploaded with explicit WebGL2 dimensions. This avoids relying
on a cropped bitmap's possibly larger backing surface. The copy happens only
when the map snapshot changes, not during animation; it retains at most one
additional color-crop-sized scratch surface.

The completed crop keeps animating during navigation. It uses the portal
presenter's camera reprojection to follow pan, zoom, rotation and flipping
without regenerating masks, capturing terrain or uploading textures on each
movement. A clipped presentation layer prevents the transformed crop from
spilling outside the map. Newly exposed areas use the original map until the
replacement crop is ready. Preparation starts after one 16 ms coalescing
interval, without waiting for OSD's animation-finish. Nearby camera changes
retain useful pending work; requests are cancelled when their region leaves
the view, on structural layer changes, or on teardown.

Completed masks retain their full queried coverage, including known-empty
pixels. Pan/zoom inside that coverage reuses the mask without worker round trips
or more material queries. The existing image continues animating while it
covers the visible liquid. Newly exposed cached liquid receives a coalesced
snapshot during the drag, and animation-finish requests an immediate final
snapshot at the settled resolution. Captures taken during a zoom remain valid
in world coordinates and reproject instead of being discarded.

Tile arrivals coalesce into a refresh 160 ms after the first update. Later
arrivals neither restart that delay nor discard an already completed snapshot.
The preceding crop stays visible and animated while a replacement is prepared.
Its upload and first draw share one GPU fence, so a resized canvas is never
published as an empty intermediate frame. Further animation draws yield while
that upload is waiting for the existing fence. No queue of snapshots builds up.

The effect still stops at distant zoom, when its retained crop is offscreen,
in hidden tabs, or when reduced motion is requested. It starts at 0.75 CSS
pixels per world pixel and stops below 0.5, with hysteresis. First activation
fades in over 140 ms; ordinary refreshes preserve the phase and strength.
Layer removal/reordering, opacity, clipping, reseeding and context loss discard
obsolete imagery. Late responses cannot restore it.

Color surfaces are limited to 4,194,304 pixels and 2,048 pixels per dimension,
native masks to 16,777,216 pixels, and cached generated blocks to 8 MiB. Large
or high-DPI color crops are resized during the single snapshot copy, keeping
their original screen placement and world coordinates. The shader checks
every native cell covered by a resized pixel and leaves boundary pixels to
the original map. Nearest presentation avoids expanding the effect into air.
Oversized native masks retain the normal map. Only one captured
bitmap may wait for the GPU. A hidden effect retains bounded caches until
reseed/teardown, and schedules no animation frames. Shader code and GPU resources
load only when a valid visible mask and image are ready.

Active animation has a real GPU cost. Native software-GLES measurements are
available through `node --import tsx build_scripts/benchmark-liquid-refraction.mjs`; they do
not establish browser FPS or hardware performance. The benchmark separates
source upload from drawing and distinguishes transient sync objects from
texture/buffer reallocations. Actual local browser appearance and performance
remain a manual check.

With the queue guard enabled, this VM's llvmpipe renderer measured median/p95
draw times of 0.68/0.89 ms at 256 by 256, 2.64/3.02 ms at 1024 by 768, and
6.50/7.55 ms at 1920 by 1080, with 100% liquid coverage and 60 samples per
size. Each submitted frame used one transient sync and zero texture uploads
or texture/buffer reallocations. These timings exclude the separately measured
source capture/upload and are software-renderer results.

The expanded repair benchmark includes the actual captured Holy Mountain oil
basin mask, sparse views, high-DPI resizing and the maximum output budget.
Its measurements are in [liquid-performance.json](liquid-performance.json).
With no concurrent builds/tests, the measured median/p95 draw costs were:

| Scenario | Median | p95 | Estimated GPU storage | Scratch canvas |
| --- | ---: | ---: | ---: | ---: |
| Holy Mountain basin at 2x | 0.75 ms | 0.98 ms | 1.6 MiB | 0.5 MiB |
| 1024 by 768, all liquid | 2.76 ms | 3.73 ms | 9.8 MiB | 3.0 MiB |
| 1920 by 1080, all liquid | 6.37 ms | 8.20 ms | 25.7 MiB | 7.9 MiB |
| 1920 by 1080, scattered liquid | 2.21 ms | 2.75 ms | 25.7 MiB | 7.9 MiB |
| 4K high-DPI view, resized to 2048 by 1152 | 8.41 ms | 10.57 ms | 27.6 MiB | 9.0 MiB |
| Maximum 2048 by 2048 output, all liquid | 14.59 ms | 16.77 ms | 49.0 MiB | 16.0 MiB |

These are 90 synchronized draws per case on Mesa llvmpipe, excluding capture,
not a percentage loss in application FPS. The CPU submission medians were
0.06 to 0.21 ms; completion waits are benchmark-only. Software-driver threads
also consume CPU while rendering. The maximum full-liquid case is material
work even with the 30 fps cap and cannot be described as zero impact.

After navigation, native-fixture snapshot copying, readback and upload together
took 0.20 ms median for the basin, 3.39 ms for 1080p, and 38.79 ms at the maximum
output. Native canvas may defer copying until readback. These timings therefore
do not establish browser `createImageBitmap` latency. Static mask decoding,
indexing and a basin query took 18.36 ms outside the frame loop; its decoded
artifact is 4.54 MiB and belongs to the mask worker in production.
Steady draws performed zero texture uploads or texture reallocations. GPU
resource accounting returned to zero after every renderer teardown. The memory
columns exclude driver overhead, pending bitmaps, mask-worker data and caches.

## Daily assets and deployment

Push the map commit to `dynamic-map`. The existing biome-baker pipeline builds
that branch and publishes one `liquid-mask.bin` alongside each horizontal
world's DZI, tiles and generation metadata. The ordinary next bake, or a manual
rebake, supplies generated-liquid masks. No new Cloudflare Worker, database, credentials,
Cloudflare setting or separate Guessr deployment is needed.

Old daily bakes remain usable. They animate captured fixed-area liquids using
the bundled mask; their generated pools gain refraction after a new bake.
The published Daily for seed 2100611341 has no generated-liquid sidecar. Its
pool near 626,2043 therefore requires a new bake; changing the zoom cannot
supply that missing material information. Debug stats list missing sidecars
as `missingBakedWorlds`, separately from an empty viewport.

Captured Holy Mountain basins extend above their biome chunks. Sixteen filled
basins have 85,136 fluid pixels exposed to procedural painting. Their compact
reservations preserve those exact pixels in live terrain, native backgrounds
and new bakes. The mask descriptor's `capturedVersion: 1` confirms that the
bake preserves them. Older baked imagery covers that strip, so the client
excludes it from the captured mask rather than animating the covering backdrop.
The rest of each basin and the lower teleportation cups remain unchanged.

Live masks retry on terrain readiness events when the first query inputs were
not ready yet. There is no polling or cold renderer initialization.
The client only requests advertised, seed-matched mask files and verifies their
length and digest. It does not fall back to live generation to reconstruct an
old Daily mask. Image tile counts and the Guessr Daily preparation format stay
unchanged; the new sidecar is not added to Guessr clue images.

The fixed-area mask is 435,258 gzip bytes and is decoded in the mask worker.
It is used only with the reviewed captured-background identity. Daily masks
are fetched once per visited horizontal world and reused for subsequent views.
Rendering and animation make no calls to Pro or Guessr Workers.

## Local inspection

For the reported seed, append `&nb=1` to bypass its older public bake without
changing the seed. The generated pool can then be checked immediately:

- Basin: `/?x=759&y=1072&z=819&m=dy&se=2100611341&ds=1&nb=1`
- Generated pool: `/?x=626&y=2043&z=793&m=dy&se=2100611341&ds=1&nb=1`
- Remove `&nb=1` to check the legacy-bake mask exclusion. Its generated pools
  still need a new bake before they can animate.

- Captured Holy Mountain pools: `/?m=dy&se=195331&x=-770&y=1110&z=900`
- Generated pool: `/?m=dy&se=195331&x=-3130&y=870&z=900`
- Repeat on the current baked Daily after its mask sidecars are published.
- Inspect water, blood, oil and lava, boundaries, rotation/flipping, and nearby
  item/enemy markers. Markers and solid pixels must remain stationary.
- Zoom out, pan, hide the tab, switch seeds and revisit a previous view. No
  stale image may reappear and frame counts must stop while suspended.

Console comparisons without reloading:

```js
window.__setLiquidWobble(false)
window.__setLiquidWobble(true)
window.__liquidWobbleStats()
```

The setter returns false if the optional overlay has not been installed. Add
`&liquidWobble=0` to disable it before initialization. During an unchanged view,
`renderer.frames` may advance while `captures`, `renderer.uploads` and mask
`preparations` remain stable. `renderer.pendingSyncs` must never exceed one.
The diagnostics also expose `phase`, `lastCaptureMs`, `lastPrepareMs`,
`reusedMasks`, `progressUpdates`, and `pendingBlocks` to distinguish image/GPU
work from missing material data. Synthetic delay tests hold later data replies
for seconds while the first pool continues animating. This is a scheduling
regression check, not a measured browser latency guarantee.

Native checks cover fluid eligibility, authored geometry, mask packaging and
resume, CPU/GPU agreement, source/displaced boundaries, camera transforms,
context loss, cancellation, stale responses, and worker/GPU queue bounds. They
do not launch a browser or the game.
