# Holy Mountain water wobble

Production animation is restricted to the water pools inside the captured Holy
Mountain lower rooms. The upper portal basins, teleportation cups, lava, generated
pools and other pixel scenes remain static. This is a deliberately limited visual
effect, not a complete recreation of Noita liquid rendering.

## Geometry and source

`holy-mountain-water.json` records the capture identity, exact pool bounds and
source hashes. The mask selects only the authored `water` material in the lower
`temple/altar` room family, placed at the Lua offset of 260 world pixels. It
contains 36 adjoining pool sections (18 Holy Mountains across three worlds),
174,114 water pixels, and is 919 gzip bytes. No rendered-color classification,
liquid settling, basin expansion or live material query is involved.

Rebuild it offline with:

```sh
node --import tsx build_scripts/build-holy-mountain-water-mask.mts
```

Unsupported capture identities, NG+, and simplistic backgrounds do not enable
the effect. Looking outside the HM pools does not start the mask worker or load
its asset. The same mask is used for live seeds and baked Daily maps; no Daily
liquid-mask file is downloaded. Existing marker exclusions protect sprites.

The former 15-pixel upper-basin reservations are removed from native terrain,
scene preparation and both background presentation paths. The surrounding
terrain/background paints normally again. Historical full-liquid assets and
material-query helpers remain available for offline research and regression
checks; they are not sources for production animation.

## Navigation and performance

The existing map paints independently. A complete map crop and a matching water
mask feed the bounded WebGL overlay. Its retained image keeps animating during
pan/zoom and is reprojected with the camera while a replacement prepares. There
are no per-frame terrain queries, uploads, captures or network requests.

Animation remains capped at 30 fps, starts at 0.75 CSS pixels per world pixel,
and stops below 0.5. Hidden tabs, reduced motion, distant/offscreen views and
teardown stop frame scheduling. One GPU fence bounds outstanding work. The
4-million-pixel/2048-per-axis color limits and 16-million-pixel mask limit remain.

The restricted scope removes general-liquid material queries, generated-block
caches and Daily sidecar downloads. The GPU draw still has a real cost. Earlier
software-GLES measurements in `liquid-performance.json` describe the retained
renderer, including broader masks, and are not browser FPS measurements for
this restricted version. Visual inspection remains manual.

## Publication and baked maps

Push the map change to `dynamic-map`. No separate auth/Guessr Worker deployment,
secret or database migration is required. The normal biome-baker fetches the new
source and no longer calculates, checkpoints or publishes general-liquid masks.
Its source fingerprint changes, so it does not resume the old cutout imagery.

The animation restriction applies immediately when the new website loads,
including on old Daily maps. However, Daily tiles baked with the basin strip
already exposed need a fresh bake to restore those pixels. Disabling animation
cannot undo geometry already present in an image. An old published mask file
may remain on its immutable deployment, but the client never requests it.

For local inspection, `&nb=1` forces live rendering when that seed has an older
public Daily bake. Check HM water while panning/zooming, then confirm upper
basins, lava and other pools remain still. The original reported upper-basin
view is `/?x=759&y=1072&z=819&m=dy&se=2100611341&ds=1&nb=1`.

Existing diagnostics remain available:

```js
window.__setLiquidWobble(false)
window.__setLiquidWobble(true)
window.__liquidWobbleStats()
```

`&liquidWobble=0` disables initialization. Tests cover exact authored water
boundaries, excluded liquids, source identity, no IO outside pools, cancellations,
marker exclusions, camera reprojection and native CPU/GPU basin restoration.
