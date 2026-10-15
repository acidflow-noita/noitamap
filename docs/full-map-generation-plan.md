# Instant access to the complete final-pixel map

## October 15 rollback

The active application is restored to `4d8d6fe` (the last commit before
`4151b34` added the cooking core and `524947b` connected the complete-map
renderer), with the isolated daily starting-loadout fix retained. The
complete-map worker, cooker, output storage and presentation integration have
been removed from the active tree. Their source remains in Git history.

The failed deployed run took 481.08 seconds to first paint, including 317.854
seconds until cooking completed and 89.47 seconds of presentation. The
subsequent uniform-block screen did not establish a credible instant path.
That rewrite is stopped. This restores the earlier rendering architecture;
it does not establish instant or all-nine completion. Earlier proposals and
measurements below are historical context, not authorization to resume the
failed implementation.

## Target and current status

The ultimate target is **instant generation of every new, uncached pixel-perfect map**, including after reopening the site: Main, West and East, with each region's Heaven and Hell. On October 13 the user explicitly accepted slow one-time preparation of reusable engine/assets and authorized replacing the architecture. They then clarified that this preparation must serve **all new seeds**, and explicitly selected **all nine regions fully cooked before the first view appears**. Slow cooking per seed followed by fast cache hits, and exact tiles generated on demand, are not the requested solution.

Measure first-ever reusable setup, reopening the application and generating an unseen seed, a second unseen seed in the same session, and reopening a saved seed separately. Every case after reusable setup must be near-instant. Saved-map restoration is an additional optimization, not a substitute for the unseen-seed path. Report actual elapsed milliseconds and cache state rather than treating a saved-seed hit as a new-seed speedup.

Completion means every generated native-resolution pixel in that extent has its final material, scene artwork, FORCE AIR behavior, liquid surface, edge decals, background and static-art protection, **including the map's displayed POI sprites at their deterministic placements**, with completed overview reductions. Moving anywhere or changing zoom must not trigger further procedural generation for that completed map. Encoding completed pixels losslessly can reduce storage; retaining only a seed and a procedural resolver does not count as completion. Any extra requirement to persist the entire result to disk must also have its own measured completion point.

**The current implementation does not achieve this.** The upstream update and retained live tile caches are useful groundwork. The requested network baseline is **100Mb/s with 30ms latency**; hardware should span phones/integrated GPUs through large desktop GPUs, including 96GB devices. This is a device family to validate, not evidence that every member can meet one second. Browser/OS and concrete representative devices remain measurement inputs. The execution sandbox exposes llvmpipe; an unsandboxed native probe also exposes a VMware SVGA3D virtual GPU. The physical host GPU is unknown, and neither result establishes browser/device performance.

The weak-machine target has the same completion barrier. Progressive completion, a finished initial viewport, and deferred work on pan/zoom do not satisfy it. Do not use missing thin features, discarded completed pixels or unbounded memory as the fallback. Limited-concurrency measurements on this development host are not measurements on a weak device.

The [deployed Telescope measurement](deployed-telescope-measurement.md), with Render Everything enabled, verifies viewport-sized terrain shading and deferred scene work. Its status text, first frame and pending-zero samples do not establish complete nine-region generation. That implementation is a source of reusable optimizations, not the performance target.

## October 13 priority clarification

The owned geometry core and reduced edge-halo sampling are groundwork. Their measured stage-level improvements do not establish sub-one-second cold completion or instant warm generation. Prioritize complete mandatory-input delivery, a shared material result across rendering/finishing, bulk processing, and bounded retention of completed output. Evaluate these against the full cold/warm completion contract before claiming progress toward the timing target.

The current generation, first-viewport, and terrain-cooking logs each measure only part of that contract. In particular, terrain cooking excludes final scene/POI presentation and cannot stand in for an end-to-end complete-map measurement. Local production preview is useful for manual regression checks; localhost transfer speed is not the specified network baseline.

The first manual deployment check of `b4c9359` on `native-map.noitamap.com` used Windows 11 Pro, an RTX 3090 and Firefox 158.0b5. Seed 1103 reached first paint in **20.18s**, with **17.614s shader startup**, 0.56s generation and 1.59s presentation. A new seed, 11033, reached first paint in **1.35s**, with 0.01s asset/cache preparation, 0.30s generation and 0.97s presentation. F5 still incurred **15.882s shader startup** and 17.63s to first paint despite a generation-cache hit. The shader startup field is retained across seeds; its repeated value on a warm seed is not a second compilation. These observations prioritize shader compilation and presentation work. They do not establish complete-map timing.

Public HTTP checks verified that the deployed runtime and terrain bundles match the local build; the main entry differs only in its build timestamp and source-map filename. Native GLES tests on this host cannot reproduce the Windows browser/compiler stack, so any shader optimization requires a manual check on that device.

## Reusable preparation and the remaining computation

The concrete candidate is a compact prepared resolver bundle with immutable decoded templates, scene/material tables and small numerical lookup tables, followed by a fused batch material resolver for each seed's coarse lattice. Current tables contain 174 biome definitions, 749 material bands and 15 Wang parameter triples. Retain seed-independent work across seeds and sessions; preserve the exact arithmetic and the seed-dependent choices.

Full-resolution noise tables are not a compact substitute for computation: four Float32 fields over the nine-region bounds occupy **118.13GiB**, before final pixels. The permutation tables do not establish an exact integer-world-pixel period. Some smaller exact tables are possible: a scratch topology-0 sin-hash plus separable sine/cosine prefix lookup uses 1,888,036 bytes and matched 24,008 current-port outputs. The GPU already has an exact sin-hash table; its invariant prefix is currently rebuilt along with seed-dependent grids and could instead be reused.

A new typed C/WASM resolver fuses main-plane biome ownership/wobble, topology-2 coordinate warp, coverage sampling and material-band selection in one rectangle call, with persistent grid/parameter memory and no per-pixel JS boundary. Checked 307,200-pixel mines cases take approximately 27.3–27.8ms including trigonometric-axis preparation, versus 76.6–83.7ms for the JS reference. Ownership/material checks compare 38,191,104 bytes with zero differences. Warm installation of a new lattice/map plus the first rectangle takes 31.3ms; including the remaining JS seed/Wang/lattice preparation takes 396.4ms. Module startup is under 1ms on this host. Topology-0, unsupported/uncovered cells and other planes retain an explicit fallback. Scene/edge finishing and whole-map completion must still be included before judging an end-to-end backend. These findings replace neither the browser measurement nor the Noita fidelity oracle.

That topology-2 resolver is now integrated into CPU tile rendering, including the offline baker and CPU finishing of GPU tiles. It also covers Heaven, Hell and their local elevator lattices, preserving absolute-coordinate noise and float32 lattice translations. The promoted vertical implementation matches 165,888 coordinate samples and 52 completed 512px tile comparisons (54,525,952 RGBA bytes), including explicit load-failure fallback checks. Generated WASM and tables have source identities verified during the build. These are CPU-path improvements; the live main-GPU path does not use this resolver for its shader work.

A scratch topology-0 extension also matches its source reference, including 25.17 million bulk material pixels. Its measured throughput of 6.8–14.7 million material pixels per second still leaves roughly 95–209 seconds of single-thread material work for the measured 1.4-billion-pixel residual candidate extent, before finishing and retention. This extrapolation is a screening result, not a full bake measurement. Further CPU work must eliminate redundant computation as well as make individual samples cheaper.

The shader startup candidate preserves the order of floating-point additions while changing loop structure and sharing material-band selection. Native comparison covers 803 windows and 46,361,600 color/material bytes without differences. Native Mesa compile/link fell from about 239ms to 161ms; the effect on the user's 16-second Windows/Firefox stall remains unmeasured. New startup diagnostics separate compile submission, linking, asynchronous completion and finalization. A deferred scene-PNG persistence queue also passes exact display/PNG checks, but its native presentation benchmark did not improve; it is not counted as a demonstrated speedup.

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

The existing [footprint policy](../src/telescope/terrain-footprint.ts) safely skips known-empty/static-owned regions, with a 42px boundary margin and scene-background bounds. An October 13 audit additionally used composition ownership, scene extents and displayed decoration extents to enumerate all 30,240 native tiles for three seeds:

| Seed | Proven transparent dynamic-overlay tiles | Exact shared background tiles | Residual candidate tiles |
| --- | ---: | ---: | ---: |
| 1103 | 23,646 | 1,177 | 5,417 |
| 11033 | 23,687 | 1,181 | 5,372 |
| 786433191 | 23,733 | 1,186 | 5,321 |

The residual represents about **1.395–1.420 billion native pixels**, or **5.20–5.29GiB of RGBA** before reductions. It is a candidate workload, not a claim every candidate pixel is nonempty. The background-only tiles share one verified finished 512px image, 5,106 bytes as lossless WebP. The audit rendered 102 stratified final tile samples; it did not rasterize the whole map. No whole-tile residual matches were found among 37 sampled same-coordinate cross-seed pairs.

Transparent **dynamic-overlay** pixels still depend on the separately baked static base art. The three base DZI descriptors contain 30,528 native tiles and 40,896 tiles across their pyramids; those bytes were not included in the sample audit. Static pixels may be shared with immutable assets only when all required bytes are already available within the post-preparation budget. Neither dropping backgrounds nor omitting static art qualifies as empty-space optimization.

### Complete CPU measurements

Two fresh seed-1103 CPU bakes now cover all nine regions, actual scene/POI artwork, every overview level and lossless DZI encoding. Both used two workers pinned to the same two development-host cores; other experiments used different cores. This is **not** weak-machine, browser, or network evidence.

| Phase | Initial checkpoint | Vertical WASM + bulk finishing + fast reduction |
| --- | ---: | ---: |
| Input preparation and decoration export | 70.945s | 71.677s |
| Native terrain, backgrounds and decorations | 440.927s | 310.797s |
| Overview generation | 75.356s | 59.500s |
| Lossless DZI encoding | 312.757s | 313.768s |
| Complete CLI run, including remaining setup/validation | **905.722s** | **762.138s** |

All **40,464 published tiles** and **40,464 intermediate PNGs** match byte for byte between the independent runs. The emitted DZI pyramid occupies 663,644,586 bytes; whole-image deduplication reduces that only to 653,995,820 bytes despite reducing unique files to 11,234. The first run additionally passed independent checks of 166 rendered samples, 166 overlap pairs, 144 elevator tiles, nine overview tiles and 30 authored background sources. These measurements preserve current-source output; they do not close the separate game-accuracy gaps or include static base-art availability. They exclude the subsequently developed compiled edge-stamping candidate.

The complete result is about 16% faster, still far from instant. Encoding and export remain large costs. This measurement is the reason to prioritize prepared fragment selection and a different completed-image representation rather than extrapolate a small kernel speedup to the entire map.

## Prepared-fragment architecture under test

The current experimental direction separates **small per-seed selection data** from **large immutable cooked payloads**. The normal NG0 biome map is static; packs nevertheless verify the exact map colors, lattice dimensions, parameters and implementation identity before using any prepared result. Other modes and unmatched inputs keep exact fallbacks while their preparation is investigated.

1. During one-time preparation, cook seed-independent coordinate stencils, guarded material outcomes and immutable image fragments. Store payloads in bounded, content-addressed pages. The existing experiments mostly store material outcomes; converting those to complete final-image fragments remains required work.
2. For a new seed, generate its coarse geometry and placements, then select prepared outcomes using the actual coverage/material inputs. Resolve every unmatched case before completing the map. An interval certificate is accepted only when it proves the same result throughout the interval; sampled equality is insufficient.
3. Finish scene, liquid, decal and displayed POI contributions. Retain final image data and all reductions with bounded working memory. A material-only selector result cannot pass this barrier.
4. Publish the map only after all nine regions, required immutable static art and final reductions are available. Its display decoder may copy/decompress known RGBA data; it must not perform deferred noise, material, scene or RNG decisions.

The sampled grouped resolver reduced 2.15-million-pixel material queries from about 204–206ms to 88–95ms across three new seeds, with exact final-tile comparisons. Its combined prepared sample occupied 15.47MB resident / 4.21MB compressed, too large to scale naively across the full map on weak devices. A separate selector prototype keeps only **152,776 bytes** of group metadata resident (33,790 bytes compressed), chooses 1.23–1.31 million prepared material pixels in about **0.3ms**, and decodes those choices back to 3,786,076 checked material values with no differences across the three seeds. The pixel payload, unhandled cases and finishing are excluded from that selection timing. This demonstrates a useful memory split, not instant completed-map generation.

Further conservative coverage certificates and an 8,100-byte phase table reduce the six actual host-contained prefill rectangles (1.84 million pixels) from about 168–173ms to **50–51ms**. The phase table classifies bounded small-scale interpolation using proven error intervals; ambiguous values keep the original resolver. The final candidate again matches 42 finished tiles / 44MB RGBA. Its surviving scalar work remains substantial, especially threshold-straddling nonbinary coverage, uncertified material bands, topology 0 and the material-edge sampler. An early host-clipping variant and a non-inlined phase variant were rejected because paired measurements regressed.

A separate lossless image experiment builds a dictionary solely from immutable authored material/background texels. An 8px block dictionary plus three precomputed reduction levels occupies **33.81MB resident / 4.13MB compressed**. The same selected block IDs address already-reduced RGBA entries, so those overview levels need no new filtering during display. Thirty-four real baked tiles and their first three reductions match **47,349,760 RGBA bytes** exactly. At present this encoder consumes already-finished images; direct generation into that representation, complete-map payload size, durable browser storage, static-art preparation and weak-device timings are not implemented or established.

## Download and initialization redesign

The current [adapter](../src/telescope/telescope-adapter.ts) waits for a small game-asset index before importing Telescope, because imported modules immediately fetch their inputs. The [asset loader](../src/data-archive.ts) already uses content-addressed byte pages and CacheStorage, with lazy file reads and no runtime ZIP parsing or HEAD validation. The main index is 915,467 decoded bytes (164,573 bytes over Brotli in the deployment check); its 21 pages contain 41,658,845 bytes in total, but that is the entire catalog, not a measured mandatory startup download. Required-page discovery, image decoding, worker initialization and shader compilation still need profiling together.

Source/archive sizes below are build inputs and individual renderer assets, not a startup transfer budget:

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

The deployment check found that sampled binary asset pages and the 4,390,912-byte material atlas transfer without HTTP compression; JSON indexes and JavaScript receive Brotli. Measure the actual pages required by the browser, including worker fetches, before attributing startup time to bandwidth. At the chosen 100Mb/s baseline, even an otherwise free one-second run can transfer only 12.5MB; 30ms latency and nonoverlapped work reduce that allowance. The 24.84MB source ZIP is already absent from the runtime loader's mandatory path.

Create a content-hashed, rendering-only manifest and pack: biome maps, Wang templates, scene/POI placement and spawn metadata, material tables, required scene pixels/art, background art, material/edge atlases and required POI sprites/atlas entries. Precompute texture layout, inheritance/lookup tables and seed-independent scans during the build. Remove startup XML/CSV parsing and unrelated UI assets from this pack. Split optional POI tooltip/wand-detail UI and translations away from rendering, while preserving spawn/RNG work that determines terrain, scene placement or displayed POI imagery. Required scene and POI art cannot be deferred past the claimed completion time.

Load render code, immutable packs and shader preparation concurrently from the page entry; reduce dependent asset discovery after the index arrives. Immutable asset identities already avoid serial HEAD requests. Network latency, download, decompression and compilation still count even if overlapped. Persisted browser/driver caches may be measured separately, but cannot silently turn the cold benchmark into a warm one.

The [input-pack audit](terrain-input-pack-plan.md) and [configuration inventory](terrain-input-inventory.json) account for an estimated 8.278MB of compressed terrain, visible POI and currently awaited translation inputs. Static native artwork, emitted code and remaining import/fallback dependencies are not yet closed. This is a candidate byte inventory, not an implemented pack or a complete cold-start budget.

## GPU alternative to compare

The following remains an alternative for the unresolved bulk work. It has not been selected as the weak-device architecture, and current live viewport rendering does not implement these completion stages.

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
- **Vegetation evidence now includes actual current-binary execution.** A SHA-guarded, isolated x86 leaf runner and reconstruction agree on 21,914 hash, seed-phase, shuffle and integer-conversion cases. This corrects details such as seed zero reaching phase 10,000 and the float32 candidate-division order. Production grass remains unchanged: the historical pond capture lacks binary provenance, and the preprocessed vegetation list, candidates and decision-time occupancy still require capture. Correct numeric leaves alone do not establish correct grass placement.

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

Continue prepared-fragment selection, exact compiled residual work and completed-image storage as the current direction; compare a GPU implementation where it can improve the same fully finished result. A dense 39.4GiB final pyramid already exceeds the available memory of many target devices, so sparse/lossless completed storage is mandatory for broad support. If mandatory transfer, measured device throughput or final-result memory already exhausts one second, report the failing prerequisite and achievable measurement explicitly. Do not rename “first usable view” or “world description ready” as “full map generated.”
