# Engine geometry reference

- Reference: production **Regular** map, captured in Noita, seed **786433191**.
- The capture filenames say `78633191`; this is the historical filename typo,
  not the seed. The root README capture instructions and user identify the seed.
- Capture metadata/version read on 2026-09-08: `1731319026`.
- Descriptor: 36,352 × 73,728, origin (−17,920, −31,744), 512px tiles,
  2px overlap, maximum level 17.
- Horizontal world pitch: 35,840, not 36,352. The extra capture column is overlap;
  do not stretch the bake to fill it.
- `engine-reference.json` records immutable-path source URLs and sample chunks.
  Chunk coordinates are main-world biome-map coordinates; plane −1/0/+1 adds
  −24,576/0/+24,576 world pixels.

## Reproduce

```sh
node build_scripts/build-full-pixel-bake.mjs --seed=786433191 --out=/path/to/bake --concurrency=8
node build_scripts/compare-engine-terrain.mjs --bake=/path/to/bake --published
```

Output: `<bake>/engine-comparison/`, including cached reference images,
coordinate-matched panels and `report.json`. Panels are **engine | generated
composited over production's static underlay | absolute RGB difference**.
All source pixels are sampled 1:1. No browser is launched. The command reports
mismatches rather than assigning an arbitrary “accurate enough” threshold.

For short iterations use `--prepare-only` on the bake, then omit `--published`
on the comparison. This runs the real native tile renderer but is NOT a check
of the published DZI pyramid; the `--published` run is still required.

## Corrected failures

- Regenerating Wang geometry from a repeated sky/hell material row filled gaps
  that are visibly empty in the captured engine map. Vertical planes must reuse
  the main world's generated buffers and source ownership instead.
- Hell's background spans the material band, including those empty gaps. It is
  not terrain ownership and must not either fill the gaps with rock or disappear.
- Pixel-scene air is an erasure command. Flattening scene layers source-over
  left solid terrain inside rooms, and legacy “opaque air” exceptions produced
  cyan/brown rectangles. Scene force-air now clears terrain before compositing
  the original background.
- Scene textures depend on their absolute world position; an image cached only
  by scene/variant cannot represent all instances correctly.
- Scene visual art lives under `data/biome_impl/` in the game archive. Missing
  path mappings caused the loader to substitute blank 1×1 images.

## Verification recorded on 2026-09-08

- A complete native seed-786433191 bake produced **40,464** lossless WebP DZI
  tiles (13,488 per world), including all three vertical planes and decorations.
- Local wall time: **463.2 seconds**, eight CPU workers. This is a local pipeline
  measurement, not a GitLab/GPU benchmark; other tests ran concurrently.
- A subsequent comparison read 27 samples from the **published DZI files**,
  not just native samples. A served HTTP tile was also byte-compared to its
  completed-bake file.
- 52 focused unit tests and 17 real worker/native GPU/forced-CPU runtime tests
  passed. The GPU/CPU tests include FORCE AIR through real OSD tile jobs.
- Production Vite build passed. Full typecheck still encounters the unrelated
  missing sibling `noitamap-pro/src/public-report-entry` test import.
- No browser verification has been performed; the user tests the actual UI.

## Remaining mismatches — not approved as accurate

The large wrong vertical terrain strips are gone. The reference still exposes
cloud colors/material distribution, scene differences (including the sky mining
scene), and missing/incorrect terrain-edge detail. These are not dismissed as
capture problems, and the bake is **not** claimed pixel-identical or fully
engine-accurate. In particular the upstream edge-decal pass has not yet been
integrated into the full-pixel bake. Static temple foreground templates also
still use their existing separate art path.

Investigate those differences at the listed world coordinates. Do not “fix”
them by blurring/resizing the reference, accepting a nonblank-pixel test as
accuracy, or changing the static biome/holy-mountain skip list indiscriminately.


## Transparency correction and daily bake, 2026-09-08 (v6)

The reported plantlife purple rectangle was traced to the exact `#6b0080` PNG
`tRNS` key; red/orange scene backgrounds used the same PNG feature. The shared
PNG decoder previously ignored RGB/grayscale keys and forced those pixels
opaque. v6 reads the authored key, keeps near-key/real art colors, and invalidates
old completed terrain tiles. This was not fixed by an arbitrary color blacklist.

The reference sample list now includes plantlife, hut and snowcastle background
scenes. Native v6 samples at seed 786433191 were compared with the captured map at
identical coordinates; the erroneous rectangles are absent. The existing
geometry/material/edge mismatches listed above remain separate open issues.

The **actual biome-baker entrypoint**, using Node 22 and an unset `SEED`, fetched
66930481 and completed all 40,464 daily DZI tiles. Publication validation passed;
32 background assets matched independent native decoding, 24 published leaf tiles
matched direct native rendering, nine published parents matched their children,
and 24 neighboring overlap pairs agreed. A resume invocation reused the complete
output without generation/rendering. 71 focused unit tests and 17 native runtime
tests passed. The Vite production build passed. No browser or Docker/GitLab
execution was performed.


## Elevator continuation, 2026-09-08 (v7)

The user identified the single-cell bottom-row Power Plant stub (NG0 biome-map
column 2, row 47, around world x=−16,648/y=17,165) as a continuous lower shaft.
The production capture contains background-only sections between its endpoint
chunks; those sections are not evidence that the requested continued terrain is
correct. The correction generates a narrow, seed-dependent Wang region for the
stub only, including its own scene/POI scan, while keeping every original layer
buffer and the surrounding heaven/hell policy unchanged.

Verification on seed 66930481:
- Actual biome-baker entrypoint completed all 40,464 v7 tiles in 464.9 seconds
  with eight CPU workers on Node 22 (other tests ran concurrently).
- All **144** lower shaft chunks (48 × three worlds) contained resolved terrain,
  not merely a background. 168 sampled published leaves matched direct native
  output; nine mip tiles and 168 overlap pairs passed.
- All **1,313** original main-world layers/claims were unchanged from v6.
- **29,799** published full-resolution tiles outside the shaft and adjacent
  sprite/overlap margin were byte-identical to the previous v6 bake. This includes
  all heaven and the ordinary hell biome areas.
- 77 focused unit tests and 17 native worker/renderer tests passed. The native
  OSD tests include the elevator's top/middle/bottom, through the real CPU worker.
- The production build passed; the existing missing Pro-sibling typecheck issue
  remains unrelated. No browser automation/testing was performed.
