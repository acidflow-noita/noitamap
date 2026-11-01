# Sun rendering source

Dust: WUOTE/noita_particle_animations, revision `a2bda47983473785540c994c1e2818c85ad7efe3`.

Runtime modules are copied unchanged from `dist/`. Only the Sun and Dark Sun
definitions and their three textures are packaged. The game archive and studio
UI are not included. Existing portal rendering is not replaced by this import.
Map presentation, culling and worker budgets live outside `runtime/`.

The two figures use the existing Moon and Dark Moon quest landmarks. They show
potential Sun locations, just as conditional portals show potential portal sites;
they do not infer a player's current Sun quest progress.

Initial stills are prepared once with `node build_scripts/build-sun-previews.mjs`
(Node, Mesa GLES, no browser). They use the same lighting and renderer as live
frames. Visitors load a still only when it enters the viewport. The worker and
602,384-byte texture pack load only near a Sun large enough to animate.

Each figure retains its complete frame and simulation when paused. The simulation
window covers 1536 world pixels. Transferred frames use 256, 512, 768, 1024 or
1536 pixels according to display size, with hysteresis to prevent resize churn.
The original particle and glow buffers keep their native resolution. Dust's
linear final sample and the Sun layer's normal CSS scaling preserve smooth
edges; the map's pixelated terrain rule does not apply to this layer.
Animation starts above an 18 CSS pixel core diameter and stops below 12 pixels.
The initial still fades into the first completed frame inside an isolated
additive group; subsequent zoom transitions reuse the last frame directly.
Camera motion only updates CSS transforms. There is one request in flight,
at most two simulation steps per frame, and no catch-up after suspension.
Sustained load lowers cadence from 60 to 30, 20 or 15 frames per second, with
a longer recovery window before raising cadence again. Slow frames do not
permanently freeze animation. The hidden document suspends scheduling immediately.

Textures and particle buffers measured 78,262,608 bytes for one warm Sun and
89,796,944 for both. The worker budget is 128MiB; browser presentation copies and
driver overhead are additional. It retains at most two full-frame bitmaps.
The two initial stills total 206,522 bytes. No Sun GPU context exists at ordinary
surface view until the user visits a Sun.

Local inspection:

- Sun: `/?m=dy&se=618&x=259&y=-25847&z=1200`
- Dark Sun: `/?m=dy&se=618&x=261&y=37764&z=1200`
- Add `&sunEffects=0` for a comparison with no Sun overlay.
- `window.__sunOverlayStats()` reports state, cold startup, delivery time,
  frame count, target cadence, output dimensions, GPU timing when supported,
  and allocated buffers.
- Zoom across the transition repeatedly, pan away/back, rotate/flip and hide
  the tab. Frame counts must stop while paused; images must remain aligned.

`node build_scripts/benchmark-sun-renderer.mjs` isolates lighting cost with
identical frozen particles on Mesa software GLES. Measured medians at 1536px:
lighting disabled 8.35ms, enabled 9.48ms. This is not a browser FPS result.
Lighting adds arithmetic to the existing composite pass, with no new pass or
texture fetch. It does not generate direct-light or skylight fields.

Terrain lighting remains a separate task: apply shared math to unlit foreground
in both the baker and live renderer before background/emissive composition.
Do not apply it again to captured map imagery. Baking the two initial Sun stills
does not require rebaking the daily terrain or changing Guessr publication.
