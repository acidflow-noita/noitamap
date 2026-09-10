## Structure

```
tests/
  translations.test.ts # Tests for translation fullness and integrity
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch
```

## Writing Tests

### File Naming
- Unit tests: `[module-name].test.ts`
- Place tests in the `tests/` directory

### Import Paths
All imports from `src/` should use relative paths from the test file:
```typescript
import { myFunction } from '../src/module/file';
```

## Real Telescope worker regression

```bash
npm test -- tests/telescope-worker-runtime.test.ts
```

Builds the actual production worker, generates seed inputs from the shipped
archives, and executes both forks for seeds 1 and 42 in east/west parallel worlds.
It uses Node worker threads and native Skia (`@napi-rs/canvas`), **not a browser**.
`Image`, `HTMLImageElement`, and `HTMLCanvasElement` are deliberately absent;
PNG decoding, canvas drawing, spawn generation, and message serialization run
for real. Temporary build outputs are isolated under the OS temporary directory.
This validates the worker pipeline, not browser/WebGL visual output.

## Real terrain/shader regression (Linux)

```bash
npm test -- tests/terrain-renderer-runtime.test.ts
```

Requires Mesa EGL/OpenGL ES libraries (`libEGL.so.1`, `libGLESv2.so.2`). This
executes the actual terrain shader and OSD image jobs without a browser, using
cold and cached custom/daily seed data. It checks visible pixels, reduced tiles,
and identical cold/cache output, and writes preview PNGs under the OS temporary
directory. Non-Linux hosts explicitly skip this native EGL test.

## Complete native daily bake

```bash
node build_scripts/build-full-pixel-bake.mjs --seed=381773 --out=/tmp/noitamap-bake --concurrency=8 --resume
```

This is an actual end-to-end, GPU-free bake (including POIs/scenes), not a mocked
render. It produces and validates 40,464 DZI files across three worlds and all
three vertical planes for an NG0 world. The 32-core GitLab job uses 30 workers.
`tests/terrain-policy.test.ts` checks static ownership and native textures;
`tests/terrain-pyramid.test.ts` checks alpha-aware reduction and overlap pixels;
`tests/baked-dzi-loader.test.ts` checks compatible/incomplete manifest handling.


## Scene composition and engine reference

```bash
npm test -- tests/terrain-scenes.test.ts tests/terrain-policy.test.ts tests/telescope-assets.test.ts
node build_scripts/compare-engine-terrain.mjs --bake=/path/to/seed-786433191-bake --published
```

Scene regressions cover FORCE AIR (including former opaque-air display
exceptions), translucent cell replacement, cell-color art restricted to painted
material, world-positioned instance caching, and native background extents. Both
the native GPU and forced-CPU runtime suites also place an air-mask scene through
the real OSD tile path and check the revealed background pixels. Archive tests
exercise both fetch and direct-zip scene-art mappings; missing visual mappings
previously produced 1×1 fallback PNGs.

The engine-reference command reads actual published lossless DZI pixels and
compares them with the authoritative captured Regular map. Geometry fixtures
include biome interiors, holy-mountain gaps, both sides of the sky band, and
static rock beside Winter Caves. See `fixtures/terrain/README.md`. Nonblank tiles,
matching backends and a completed bake are pipeline checks, not proof that every
piece of generated geometry is correct.


## Color-key transparency and real daily-bake artifacts

`tests/png-decode.test.ts` covers RGB/grayscale `tRNS`, source-depth 16-bit
key comparison, indexed alpha and all engine-listed scene background assets
against native libvips decoding with ICC conversion disabled (authored pixels,
not color-managed display output). It includes the reported plantlife purple
rectangle through the scene compositor. It does not infer transparency from
image corner colors.

```bash
npm test -- tests/png-decode.test.ts
node tests/helpers/verify-native-daily-bake.mjs /path/to/completed-daily-bake
```

The standalone artifact verifier reads the actual bake snapshot/PNG sources and
published DZI files. It checks native scene-background RGBA, representative
full-resolution output in all nine world/plane combinations, nine actual
premultiplied-alpha parent tiles, lossless WebP coding and shared tile overlaps.
It writes `verification/report.json` and native sample PNGs under the bake path.
It is independent of browser automation and does not claim complete Noita
geometry accuracy.


## Elevator continuation

```bash
npm test -- tests/terrain-elevator.test.ts tests/terrain-policy.test.ts
npm test -- tests/cpu-terrain-runtime.test.ts tests/terrain-renderer-runtime.test.ts
node tests/helpers/verify-native-daily-bake.mjs /path/to/completed-v7-bake
```

The bottom-row Power Plant stub is identified from its single real biome-map
claim, not a hardcoded world x. The lower-plane exception cannot open the general
heaven/hell masks or fill neighboring static rock. Tests cover buffer/claim
serialization, removal of only the false lower-endpoint spawn copy, and native
CPU-worker/OSD rendering at the start, middle and bottom. Completed-bake
verification requires non-background terrain in **every** shaft chunk (48 per
world), identical direct/published final pixels and matching DZI overlaps.


## Full-pixel toggle and completed daily state

```bash
npm test -- tests/full-pixel-toggle.test.ts tests/full-pixel-mode.test.ts tests/baked-dzi-loader.test.ts
```

The DOM unit tests (jsdom, no browser) verify that the entire live-render control
is hidden on baked maps and during initial bake detection, without changing the
saved preference. Leaving a baked view restores the visible control. Language
changes cannot make it reappear. Loader tests still validate all three complete
world manifests before recognizing full-pixel baked output.


## Stone stamps, static altar boundaries, liquids, and live work

```bash
npm test -- tests/terrain-edges.test.ts tests/static-terrain-mask.test.ts tests/liquid-surfaces.test.ts tests/material-cache.test.ts tests/terrain-footprint.test.ts tests/pixel-pyramid.test.ts
npx tsx tests/helpers/measure-terrain-footprint.ts /path/to/prepared-bake
```

The edge tests run the actual EdgeGraphics stamper with the existing binary
sprite atlas: dense stone, true-liquid exclusion, protected static pixels,
scene force-air, and identical independent tile seams. Static-scene tests
separate reserved material from forced air so an altar cannot become a black
rectangle. Liquid tests cover inherited liquid/powder classification, untouched
rock/powders, and tile-independent free surfaces. Material-cache tests preserve
absolute-coordinate IDs; pyramid tests coalesce requests without cancelling
other subscribers and skip only known-empty subtrees.

Native OSD tests exercise both CPU fallback and GPU plus worker composition;
they do not launch a browser. The engine-reference fixture list includes the
reported spot near (−1553,978), the neighboring wobble, and a liquid pool.
Full RGB differences remain recorded; passing infrastructure tests is not an
assertion of complete engine geometry or ore-distribution accuracy.


## Parallel live workers and actual game material flags

```bash
npm test -- tests/terrain-worker-pool.test.ts tests/pixel-pyramid.test.ts tests/liquid-surfaces.test.ts
npm test -- tests/terrain-worker-pool-runtime.test.ts
```

The shared pool tests exercise concurrent dispatch across three plane contexts,
resource reuse, priority changes, safe source cloning versus tile transfers,
cancellation, seed-change disposal and startup errors. The pyramid test requires
four concurrent leaf renders without unbounded recursive fan-out and compares
the final reduction against serial execution.

The native A/B test uses the real CPU final-pixel worker and shipped archives:
12 identical tile jobs with one and four workers, both cold and warm. It asserts
four simultaneous render requests and identical output hashes, then reports the
timings without a flaky performance threshold. No browser automation is involved.

Liquid tests read the actual game XML for desert `sand_static`, loose sand,
gunpowder, coal and powdered metals, including inherited materials such as
`purifying_powder`. All must remain outside fluid leveling. The full shader
material list is also checked against the independent engine sand/powder types.
