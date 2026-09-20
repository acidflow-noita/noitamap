# Experimental GPU portals

Open a dynamic seed map and click **GPU · Portal · EXP**, next to the seed
controls. It defaults to OFF on every page load. No map reload is needed.
Click again to stop immediately and release this experiment's GPU context.

This prototype uses only the experimental GPU-particle backend from
`WUOTE/noita_particle_animations` commit
`85d0740e7d592d9b65395fbdae68013f23c4acc7` (September 19, 2026,
08:29 EDT, “Add full-gpu renderer (experimental)”). An isolated `git pull --ff-only`
on September 19 confirmed that this is still GitHub main. There is no animation atlas,
software renderer fallback, or CPU-physics renderer selection. The source repo
was not modified; an isolated checkout is under `task/noita-particle-animations`.
The earlier atlas experiment is parked under `task/portal-atlas-prototype`.

## What to check manually

- Pan/zoom around Holy Mountain portals, the red final-biome portals and the six
  Leviathan hub portals. Portal size is in game-world pixels, not fixed UI pixels.
- Try the meditation cube/return and Hourglass/eye-room effects.
- Compare interaction with the toggle off and on; test turning it off mid-load.
- Watch the lower-left diagnostics: active/visible (total) portals, particles,
  completed frame rate, simulation steps/s (target 60), worker CPU submission time,
  optional GPU timestamp time, CPU-observed GPU-fence wait, worker delivery time, estimated
  GPU memory and actual WebGL renderer string. CPU submission time is NOT GPU
  execution time. A software WebGL driver may identify itself as SwiftShader/Mesa.
- `window.__portalOverlayStats()` gives the same diagnostics in the console.
- To stress tiny portals too, add `portalGpuMinPixels=0` to the URL, then enable
  the UI toggle. `portalGpuLimit` can lower the default/hard limit of 192.

## Boundaries

One WebGL2 context lives on an OffscreenCanvas in a dedicated worker, sharing
source textures and scratch render targets. Each visible portal retains its own
GPU particle state and glow history. The UI has one bitmap-presentation canvas,
not a WebGL context per portal. Emission/RNG, sprite work, asset decoding and GL
submission run in the worker. Only GPU-backed ImageBitmaps cross to the UI;
there is no per-frame particle/pixel readback or CPU-renderer fallback. Worker,
OffscreenCanvas, WebGL2 and bitmaprenderer support are required explicitly.

Only one frame request may be in flight. A nonblocking GL fence waits for actual
GPU completion before returning the bitmap, preventing a slow VM GPU from
accumulating work indefinitely. There is no artificial idle/duty-cycle throttle.
Timing matches upstream GridRuntime: accumulate wall-clock time and its
fractional remainder, advance up to two native 1/60 physics steps per displayed
frame, and bound long stalls. Both 60fps and 30fps presentation therefore advance
60 simulation steps per second. `SIM BEHIND` means actual simulation debt exceeded
that upstream budget, not that a frame took more than 8ms. A genuinely overloaded
device can still fall behind; worker isolation is not a GPU-throughput guarantee.
Final texture sampling and CSS scaling preserve sharp pixels; linear sampling
remains only in the original native-resolution glow/history pipeline.

Pan/zoom alignment does NOT wait for the worker. OSD's draw event applies
`currentCamera * inverse(renderedCamera)` as a CSS transform to the last frame.
Old worker replies are also reprojected to the current camera on presentation.
The worker crops each returned bitmap to the union of selected portals' exact
480×320 render windows, clipped to the requested view. A single 1:1 portal sends
153,600 pixels instead of a mostly empty full viewport; the particle textures,
physics and glow resolution are unchanged. Crop coordinates are incorporated
into camera reprojection, including rounded fractional-DPR backing dimensions.
A 64-CSS-pixel overscan border reduces newly uncovered edges; on very large/fast
moves newly exposed portals can appear late, but old pixels remain world-anchored.
Off-screen/subpixel simulations are removed; visible instances retain state.
Hidden/spoiler views submit no new work (an in-flight frame may finish), and
toggling off terminates the worker and releases its presentation bitmap. Newly
visible portals start fresh; this is not a replay of a player's save/game clock.

The renderer retains the laboratory's 480×320 per-effect render window; very
wide trails (especially the Hourglass return) can be clipped. The GPU backend
is experimental and not bit-identical to native Noita. This is a feasibility
prototype, not an FPS guarantee or a finished visual-fidelity implementation.
The backing canvas is capped at 2M pixels; reported memory above 256 MiB stops
the experiment. Context loss/errors are shown, with no automatic fallback.

Placement uses the seed's actual scene/biome metadata, including existing baked
maps, without changing loot counts or requiring a rebake. Conditional portals
show potential sites, not an assertion that their gameplay condition is met.
`src/portals/placements.json` records reviewed anchors and explicit omissions.
Runtime-created portals (for example the portal at Leviathan's death position)
are not fabricated at a boss spawn position. Not every portal type is placed.

Source extraction is optional and read-only; normal builds use committed data:

```sh
NOITA_DATA_DIR=/path/to/unpacked/data python3 build_scripts/extract-portal-effects.py
NOITA_DATA_DIR=/path/to/unpacked/data python3 build_scripts/extract-portal-placements.py
NOITA_DATA_DIR=/path/to/unpacked/data python3 build_scripts/extract-portal-backgrounds.py
```

No browser testing was performed for this integration; browser feasibility and
visual review belong to the maintainer. The unrelated particles checkout remains
untouched.

## Captured portals in the static background

The eye-shaped Hourglass chamber and meditation destination chamber use the
original portal-free background art in `src/portals/assets/backgrounds/`.
The meditation patch composites `cube_chamber_background.png` with its clean
`cube_chamber_visual.png`; the eye chamber has no `_visual` (its Lua explicitly
uses an empty filename), so it uses `hourglass_chamber_background.png`. Authored
alpha defines the meditation patch footprint. For the eye room, coverage is
restricted to material air AND all spawn points: the purple background extends
behind the steel_static outline, which must remain transparent in our patch.
The 6,956 metal-material pixels stay untouched. Both masks cover ALL spawn-marker
positions rather than leaving colored pinholes. Material-template RGB is never drawn; it is only
read for spawn coordinates and preserving the meditation liquid corner. Original
visual alpha is retained at the art's edges. Input hashes, bounds and covered
spawn coordinates are recorded in `backgrounds/sources.json`.

Patches are small static OSD image layers using its default source-over blend,
not the particle canvas's screen blend, and need no new canvas/context or RAF.
They use actual destination-portal coordinates minus the authored spawn marker,
including parallel-world offsets. Layer order is captured base → clean room art
→ ALL seed layers → GPU particles. This preserves spells/wands embedded in daily,
previous-daily and local bake DZIs, not just separately flagged live markers.
New map items trigger reordering, not every particle frame.

A patch appears only for its portal in the currently presented GPU frame. If
that portal is culled/capped, the original captured portal remains visible.
Toggle-off, spoiler/hidden-tab suspension and renderer failure hide/remove the
patches; late image loads cannot resurrect them after toggle-off or reseeding.
No hosted background changes or seed rebake are needed. The experiment remains
off by default, leaving the captured base map unchanged.

The approved masks are source-verified, not visually compared in a browser.
Glow spilling onto walls beyond the interior mask and captured lighting still
need manual review. The small 36×37 entrance cube is a different scene and is
not replaced by these destination-room patches. Do not stage the unpacked game
archive; the optional extraction script reads it without modifying it.
