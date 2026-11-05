# Liquid wobble

The dynamic map applies Noita's world-anchored liquid refraction to eligible
material pixels, including lava. It checks the original and displaced sample
and protects nearby solid pixels and POI sprite footprints. The material rule,
native evidence and static-map adaptation are documented in
[liquid-refraction-evidence.md](liquid-refraction-evidence.md) and
[static-liquid-masks.md](static-liquid-masks.md).

## Rendering and resource limits

The existing map draws first. After navigation settles, a small worker reads
the sparse material masks and prepares the visible area. Non-daily maps query
256-pixel blocks through the already-warm terrain shader, with asynchronous
readback and background queue priority. Scene material replacements and terrain
ownership are applied before rendering. These queries never start another
terrain renderer or run on every animation frame.

One finished map crop and its material mask are uploaded to a separate small
WebGL2 program. The animation is capped at 30 frames per second. It performs
no terrain regeneration, texture upload, canvas readback or network request
per frame. A nonblocking GPU fence admits at most one upload/frame at a time;
slow devices retain the preceding image instead of accumulating draw commands.

The effect pauses during navigation, at distant zoom, when no liquid is visible,
in hidden tabs, or when reduced motion is requested. It starts at 0.75 CSS
pixels per world pixel and stops below 0.5, with hysteresis. Camera movement
immediately restores the original map. Once the new view is ready, displacement
fades in over 140 ms. Obsolete mask and image responses cannot restore an old
view. Layer/content changes invalidate the frozen image even without a new
tile download.

Color crops are limited to 4,194,304 physical pixels, native masks to
16,777,216 pixels, and cached generated blocks to 8 MiB. GPU texture dimension
limits also apply. Oversized views retain the normal map. Only one captured
bitmap may wait for the GPU. A hidden effect retains bounded caches until
reseed/teardown, and schedules no animation frames. Shader code and GPU resources
load only when a valid visible mask and image are ready.

Active animation has a real GPU cost. Native software-GLES measurements are
available through `node build_scripts/benchmark-liquid-refraction.mjs`; they do
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

## Daily assets and deployment

Push the map commit to `dynamic-map`. The existing biome-baker pipeline builds
that branch and publishes one `liquid-mask.bin` alongside each horizontal
world's DZI, tiles and generation metadata. The ordinary next bake, or a manual
rebake, supplies generated-liquid masks. No new Cloudflare Worker, database, credentials,
Cloudflare setting or separate Guessr deployment is needed.

Old daily bakes remain usable. They animate captured fixed-area liquids using
the bundled mask; their generated pools gain refraction after a new bake.
The client only requests advertised, seed-matched mask files and verifies their
length and digest. It does not fall back to live generation to reconstruct an
old Daily mask. Image tile counts and the Guessr Daily preparation format stay
unchanged; the new sidecar is not added to Guessr clue images.

The fixed-area mask is 435,258 gzip bytes and is decoded in the mask worker.
It is used only with the reviewed captured-background identity. Daily masks
are fetched once per visited horizontal world and reused for subsequent views.
Rendering and animation make no calls to Pro or Guessr Workers.

## Local inspection

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

Native checks cover fluid eligibility, authored geometry, mask packaging and
resume, CPU/GPU agreement, source/displaced boundaries, camera transforms,
context loss, cancellation, stale responses, and worker/GPU queue bounds. They
do not launch a browser or the game.
