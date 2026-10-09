# Cold-start, complete nine-region generation

## Target and current status

The target is **less than one second from a cold site navigation to the complete final-pixel map**: Main, West and East, including each region's Heaven and Hell. Downloads, JavaScript loading, decoding, worker startup, shader compilation, seed generation, final terrain composition and overview reduction count. Finishing only the visible viewport, showing a preview, or starting background generation does not meet this target.

Completion means every generated native-resolution pixel in that extent has its final material, scene artwork, FORCE AIR behavior, liquid surface, edge decals, background and static-art protection, **including the map's displayed POI sprites at their deterministic placements**, with completed overview reductions. Moving anywhere or changing zoom must not trigger further procedural generation for that completed map. Encoding completed pixels losslessly can reduce storage; retaining only a seed and a procedural resolver does not count as completion. Any extra requirement to persist the entire result to disk must also have its own measured completion point.

**The current implementation does not achieve this.** The upstream update and retained live tile caches are useful groundwork. The requested network baseline is **100Mb/s with 30ms latency**; hardware should span phones/integrated GPUs through large desktop GPUs, including 96GB devices. This is a device family to validate, not evidence that every member can meet one second. Browser/OS and concrete representative devices remain measurement inputs. No hardware GPU is exposed in this development VM; its native renderer is llvmpipe.

Graceful degradation is under discussion. Until explicitly accepted, progressive completion on constrained devices is not a replacement for the all-nine cold target. If accepted, report “complete” only after the whole extent is final; retain completed quality through all pan/zoom changes and show remaining generation separately. Do not use missing thin features, discarded completed pixels or unbounded memory as the fallback.

The [deployed Telescope measurement](deployed-telescope-measurement.md), with Render Everything enabled, verifies viewport-sized terrain shading and deferred scene work. Its status text, first frame and pending-zero samples do not establish complete nine-region generation. That implementation is a source of reusable optimizations, not the performance target.

## POI imagery is part of the result

The host does substantial work beyond terrain shading:

- **Generate and place:** [the adapter](../src/telescope/telescope-adapter.ts#L618) scans spawns and nested scenes, generates loot, and handles Heaven/Hell for each requested horizontal world. West/East use workers whose results are awaited. Host additions include fixed-world items, boss drops, wand names, deduplication and placement corrections; [the live pipeline](../src/dynamic-map.ts#L475) also applies unlock state and stable nested POI IDs. All nine regions require `parallelWorlds: [-1, 0, 1]`, not the light-mode `[0]` path.
- **Live imagery:** [buildMarkerData](../src/telescope/poi-spatial-index.ts#L538) loads the game spritesheet/atlas, selects real item/wand/creature sprites, unwraps visible container contents, applies offsets/rotations, and builds a Flatbush index. [Marker tiles](../src/telescope/marker-tile-source.ts#L81) rasterize those sprites into a separate transparent 512px OSD layer on demand. [Scene artwork](../src/telescope/telescope-osd-bridge.ts#L2836) is composed/decoded separately and [tiled with its own cache](../src/telescope/pixel-scene-tile-source.ts#L16). [Orb icons](../src/telescope/telescope-osd-bridge.ts#L5369) and enabled [high-value rings](../src/telescope/telescope-osd-bridge.ts#L3092) are DOM overlays. These costs remain outside the terrain shader.
- **Daily bake:** [prepareDecorationExport](../src/telescope/telescope-osd-bridge.ts#L1468) prepares scene artwork and marker sprite draw records; [exportDecorationCell](../src/telescope/telescope-osd-bridge.ts#L1545) paints 2048px cells. [The image baker](../build_scripts/build-daily-seed-images.cjs#L819) composites these above terrain/background pixels before publishing images and metadata. With decorations baked, the live bridge skips the scene and marker raster layers but still creates the click index, orb overlays and search data.

Upstream Telescope also generates POIs and draws them: [its POI pass](../lib/noita-telescope-vm/js/app.js#L4594) uses colored/accessibility shapes, [cached shape sprites](../lib/noita-telescope-vm/js/app.js#L261), and zoom-dependent whole-world marker bakes. It also draws scene artwork. Its marker pass is different from Noitamap's actual game-sprite atlas, host-specific placement rules, container contents and daily decoration bake. Compare equivalent visible output and enabled layers; do not treat either application's terrain-only timing as the other's finished-map timing.

The completion barrier must join nine-region POI/scene generation, mandatory artwork/atlas decoding, deterministic host placement, final terrain/scene/POI composition and retained reductions. Layers may remain separate if their completed output is retained and composites identically. [First paint](../src/dynamic-map.ts#L526) deliberately occurs before scenes/POIs finish; [items progress 100%](../src/telescope/telescope-osd-bridge.ts#L5662) can fire when a source is added or after a three-second fallback. Neither proves pixel completion. Track sprite/scene tile completion explicitly, and report [search/click readiness](../src/main.ts#L640) separately: FlexSearch indexing and translated labels contribute to usable-map latency. Pro's [feature loader](../task/noitamap-pro/src/pro-entry.ts#L13) adds report, drawing, filtering and effects only when requested; benchmark the selected feature state rather than assuming every Pro feature always initializes. The public map also starts [animated portals](../src/portals/index.ts#L57) asynchronously when enabled (default on); include their startup and first-frame cost in the displayed-map measurement.

The [native benchmark](../build_scripts/instant-terrain-fixture.ts#L44) includes spawn/POI generation and host postprocessing in its generation timings for the requested worlds, defaulting to `[0]`. Its viewport timings exclude marker construction/drawing, scene artwork composition, DOM overlays, search and OSD composition; the legacy finishing samples also exclude POI sprite decoration export. The native TileSource test verifies terrain and retention, not complete POI imagery. Likely additional bottlenecks to measure are scene composition/decoding, synchronous marker/index/search loops, and repeated decoration-cell filtering plus PNG encoding. The marker layer currently has no retained cache beyond OSD, and the exporter scans all decoration records for each cell; spatially indexed batches and retained sprite tiles are concrete candidates. These are code-based hypotheses, not measured shares of total runtime.

## The amount of work

For NG0, one region is 70 × 48 chunks of 512² pixels. The nine-region bounding rectangle is 107,520 × 73,728 = **7,927,234,560 pixels**.

| Dense representation, all nine regions | Bytes | GiB |
| --- | ---: | ---: |
| Final RGBA8, native resolution only | 31,708,938,240 | 29.531 |
| Final RGBA8 plus complete mip chain, approximately | 42,278,584,320 | 39.375 |
| One 16-bit material ID per native pixel | 15,854,469,120 | 14.766 |
| One 8-bit local-palette index per native pixel | 7,927,234,560 | 7.383 |
| One coverage bit per native pixel | 990,904,320 | 0.923 |

The source currently defines **466 materials**; a global 8-bit material ID is insufficient. A local palette needs a wider fallback when its cardinality exceeds 256. Material IDs also omit visual-art colors, alpha, edge stamp results and backgrounds, so they are an intermediate, not the complete final image. A coverage bit cannot encode the other 465 materials or the artwork.

There are 30,240 native 512² tiles, or 120,960 native 256² tiles. A bounded background sweep now generates them independently of viewport requests and publishes retained reductions to OSD. This removes zoom as the generation trigger, but its individual draws, CPU reductions and optional compressed persistence do not meet the one-second target. A bulk GPU interface is still needed for that target.

Writing dense native RGBA alone requires 31.71GB of output in the one-second budget. A simple pipeline that writes R16 material IDs, reads them while writing RGBA, then reads child pixels and writes all mip levels moves approximately **116GB**, before noise/lattice reads, masks, scene overdraw and decals. This is traffic accounting, not a prediction of hardware runtime. At 100GB/s effective throughput that traffic alone takes about 1.16s; at 500GB/s about 0.23s, before all remaining work. Both effective throughput and memory capacity need measurement on the target device.

The existing [footprint policy](../src/telescope/terrain-footprint.ts) safely skips known-empty/static-owned regions, with a 42px boundary margin and scene-background bounds. Measure its reduction over all nine regions for several seeds; there is no measured sparse-work percentage in this plan. Static pixels may be shared with immutable assets only when those required bytes are already available within the cold-start budget. Neither dropping backgrounds nor omitting static art qualifies as empty-space optimization.

## Download and initialization redesign

The current [adapter](../src/telescope/telescope-adapter.ts) waits for `data.zip` before importing Telescope, because imported modules immediately fetch their inputs. The [archive loader](../src/data-archive.ts) performs HEAD validation followed by GET on a cold miss, then parses the ZIP. Prepared scene inputs overlap this work, but much of module initialization, image decoding, seed generation and resource upload follows it.

Current source asset sizes:

| Asset | Bytes |
| --- | ---: |
| `public/data.zip` | 24,842,915 |
| `public/pixel_scenes.zip` | 3,092,626 |
| `public/wang_tiles.zip` | 858,452 |
| Material atlas, raw | 4,390,912 |
| Edge atlas, raw | 414,720 |
| Prepared full-pixel metadata pack, gzip | 106,100 |
| POI spritesheet PNG | 1,454,113 |
| POI atlas JSON, source before bundling/compression | 1,388,316 |

A local gzip level-9 check reduces the raw material atlas to **567,073 bytes** and the edge atlas to **30,102 bytes**, without changing decoded pixels. That makes a smaller mandatory rendering pack plausible; it is not a measured deployed transfer size or a complete asset budget.

The 24.84MB main ZIP alone takes **1.987s at 100Mb/s**, or **0.199s at 1Gb/s**, excluding request latency and all computation. File sizes for raw assets are not claims about deployed HTTP transfer compression. Measure actual mandatory transferred bytes. At the chosen 100Mb/s baseline, even an otherwise free one-second run can transfer only 12.5MB; 30ms latency and nonoverlapped work reduce that allowance. The existing main ZIP cannot remain a mandatory cold dependency.

Create a content-hashed, rendering-only manifest and pack: biome maps, Wang templates, scene/POI placement and spawn metadata, material tables, required scene pixels/art, background art, material/edge atlases and required POI sprites/atlas entries. Precompute texture layout, inheritance/lookup tables and seed-independent scans during the build. Remove startup XML/CSV parsing and unrelated UI assets from this pack. Split optional POI tooltip/wand-detail UI and translations away from rendering, while preserving spawn/RNG work that determines terrain, scene placement or displayed POI imagery. Required scene and POI art cannot be deferred past the claimed completion time.

Load render code, immutable packs and shader preparation concurrently from the page entry; avoid discovering them only after the main ZIP has loaded. Use immutable asset identities to avoid a serial HEAD request. Network latency, download, decompression and compilation still count even if overlapped. Persisted browser/driver caches may be measured separately, but cannot silently turn the cold benchmark into a warm one.

The [input-pack audit](terrain-input-pack-plan.md) and [configuration inventory](terrain-input-inventory.json) account for an estimated 8.278MB of compressed terrain, visible POI and currently awaited translation inputs. Static native artwork, emitted code and remaining import/fallback dependencies are not yet closed. This is a candidate byte inventory, not an implemented pack or a complete cold-start budget.

## Generation architecture

1. **Produce a compact deterministic world description.** Keep the 70×48 biome map, region ownership, Wang choices, scene placements and per-instance parameters. [The lattice builder](../lib/noita-telescope-vm/js/engine_resolve/lattice_builder.js) already creates a 3,584×2,457 Float32 coverage + Uint16 material field, approximately 52.84MB before temporary copies. Reuse source geometry where valid, including [vertical-plane geometry](../src/telescope/terrain-planes.ts). The absolute-coordinate noise, material textures and scene RNG mean final pixels cannot simply be copied across worlds.
2. **Batch native-resolution GPU material resolution.** Use a persistent device/context and tiled storage, with one evaluation per owned native pixel and sufficient neighbor halos. Classify proven-empty/uniform regions first; conservatively process anything uncertain. Specialize topology/biome passes to reduce irrelevant branches where measurements justify it. A low-resolution field plus deferred shader evaluation is still only the input to this stage.
3. **Finish on the GPU.** Port the semantics in [terrain composition](../src/telescope/terrain-composition.ts): ownership, background, liquid surfaces, scene material substitution/texturing, visual art, force-air, terrain/scene edge stamps, static masks and final alpha composition. Include the existing game-sprite POI imagery and host placement rules above the scene/terrain layers. Extend this to Heaven/Hell and elevator shafts; the current exact path uses CPU finishing and CPU vertical-plane rendering. Keep material IDs available locally for neighbor queries instead of resolving them again for edge stamps.
4. **Reduce completed final colors on the GPU.** Build overview levels from the native results, preserving the host's alpha/coverage rules and tile boundaries. Do not regenerate coarse topology or average material IDs. Fuse compatible passes when it reduces memory traffic without changing paint order.
5. **Retain the completed result within the memory budget.** Use sparse pages, shared immutable artwork, constant-tile descriptors and measured lossless compression of already resolved tiles. Keep a bounded GPU working set and a separate completed backing store. A cold complete-map run cannot evict its only final result and claim completion while leaving future pan/zoom to regenerate it. Storage/eviction strategy is an architecture decision, especially on devices that cannot hold the dense 39.4GiB pyramid.

WebGL render passes are a useful first prototype because the terrain resolver and native GLES harness already exist. A compute implementation is a candidate for compaction, tile classification, shared-neighbor work and ordered stamp resolution. Choose between them using measured work, memory and target support; changing the API by itself does not remove billions of output cells.

## Hard correctness work

- **Deterministic generation has dependencies.** [Wang generation](../lib/noita-telescope-vm/js/tile_generator.js) advances PRNG streams and can reroll/pathfind up to 99 times. Region generation resets its own stream and may be parallelizable with isolated state and stable output order; individual dependent draws cannot simply be assigned independent random seeds. [Spawn scanning](../lib/noita-telescope-vm/js/poi_scanner.js) recursively discovers scenes. Many spawn functions seed local PRNGs by coordinates, but nested scene discovery and paint order still require a deterministic dependency schedule. Parallelize verified independent work, not the RNG sequence blindly.
- **Decals are ordered writes.** [Edge stamping](../lib/noita-telescope-vm/js/edge_decals.js) includes neighborhood tests, 16 normal rays, seeded decisions, overwrite rules and scene-local passes that mutate the material context seen by later scenes. A naive GPU scatter creates overlapping-write races. Candidate compaction plus explicit deterministic ordering, or a proven equivalent per-target gather, is required. Batch nonoverlapping scenes where possible.
- **Numeric parity is part of the port.** The CPU resolver uses explicit `Math.fround`, double-coordinate operations and reconstructed constants. Compare material IDs before color textures so threshold/material differences cannot hide in similar colors. Cover positive/negative worlds, boundaries, rare materials, thin features and static masks; exact arithmetic needs validation on each GPU implementation.
- **Source fidelity remains separate from speed.** Existing comments explicitly describe deterministic position-based decal randomness rather than complete recovery of the game's original RNG stream. Faster rendering must not be presented as newly proven pixel identity with the game.

## Measurable milestones and decision gates

| Milestone | Required evidence |
| --- | --- |
| Establish representative device matrix | Include phones, integrated GPUs and desktop GPUs; record browser/OS, GPU/driver, usable RAM/VRAM, and enforce 100Mb/s/30ms. Separate process-cold, storage-cold and driver-cache conditions. |
| Count actual all-nine work | Owned native pixel count, static/empty skips, scene/decal candidates, material entropy/local-palette sizes and peak live bytes for multiple seeds. |
| Remove download dependency bottleneck | Mandatory compressed bytes and full navigation dependency timeline; verify every required final-art asset is included. |
| Measure device floor | Hardware-only bulk fill/copy/reduction tests at realistic batch sizes, reported completion times and peak allocation, without readback in the timed GPU stage. |
| GPU exact tile parity | Final output matches the CPU reference for terrain/scenes/air/liquids/decals/static masks and displayed POI sprites/placements, including seams and vertical worlds. |
| GPU all-nine completion | Sum final native ownership, verify completed reductions and retain all final results; time seed work, shader compilation, uploads, each GPU pass and storage separately. |
| Literal cold target | Measure navigation through all-nine completion on the stated device/network with caches cleared as agreed; report repeated median and tail results, not the fastest viewport frame. |

Use [native GLES hardware selection](../build_scripts/native-gles.mjs) with `requireHardware` and completion fences/`glFinish` for device experiments. Extend it for framebuffer batches and finishing/reduction passes; its current 2048² surface and viewport tests do not benchmark full-map storage. The software renderer remains useful for parity tests. A future compute backend needs its own native adapter/timestamp harness. Native tests cannot establish browser navigation, browser memory limits or network timing. The user explicitly permits automated measurement of the upstream Telescope site; that exception does not authorize browser testing of local Noitamap, which remains a manual user check.

Proceed with the rendering-only asset split and a representative GPU finishing prototype, then use the device matrix to decide which machines can meet the target and which need an explicitly accepted fallback. A dense 39.4GiB final pyramid already exceeds the available memory of many target devices, so sparse/lossless completed storage is mandatory for broad support. If mandatory transfer, measured device throughput or final-result memory already exhausts one second, report the failing prerequisite and achievable measurement explicitly. Do not rename “first usable view” or “world description ready” as “full map generated.”
