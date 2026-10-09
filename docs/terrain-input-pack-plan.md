# Rendering inputs for a complete cold map

The next bounded milestone is to remove the mandatory **24,842,915-byte `data.zip`** from generation, final terrain composition, and visible POI rendering. At the agreed 100 Mb/s baseline, that ZIP alone takes 1.987 seconds to transfer before latency or processing. A smaller input pack is necessary for the one-second target; it does not establish that billions of final pixels can be generated and retained within the remaining time.

The completion boundary includes Main, West and East, their Heaven/Hell regions, required static artwork, and this host's baked or placed **POIs above the map**. It includes POI selection, coordinates, final sprite selection and rendering. Tooltip-only details can be moved later only after proving that doing so changes none of those outputs or the RNG used to choose them. The existing live path and an upstream Telescope viewport are not equivalent completion measurements.

This document is an input audit and implementation proposal, not an implemented pack. [The inventory](terrain-input-inventory.json) records the exact configuration requests, resolved archive entries, source hashes, compressed sizes, known extra dependencies, and unresolved requirements. It targets upstream `fa9cd25d902f04b234896716eca3ba52b2d11856` with this workspace's host integration. Its configuration union is independent of a particular seed; the complete dependency closure is still unproven.

The inventory and estimates below predate the host's prepared-scene path repair.
That repair gives canonical prepared scenes precedence over raw game PNGs and
keeps `spliced/` in fallback paths (Water Cave previously loaded the wrong-size
raw image). Re-resolve the configuration union and regenerate hashes/sizes before
using this historical inventory as an implementation manifest.

## Why the main ZIP blocks initialization

1. [The adapter, lines 220–257](../src/telescope/telescope-adapter.ts#L220), starts the prepared scene pack concurrently, then awaits `getDataZip()` before installing asset interception and importing Telescope. [The bridge, line 345](../src/telescope/telescope-osd-bridge.ts#L345), repeats this dependency on generation-cache hits.
2. [The archive loader, lines 68–208](../src/data-archive.ts#L68), takes a cross-tab lock, performs HEAD validation, downloads the entire response on a cold miss, concatenates its chunks, awaits the Cache API write, and parses the ZIP directory before resolving. A failed optional cache write can therefore fail this path too. The [worker path, line 47](../src/data-archive.ts#L47), requires an existing Cache API entry and performs no network fetch.
3. [Asset resolution, line 63](../src/telescope/telescope-asset-paths.ts#L63), probes main-archive candidates before specialized archives. [Extraction, line 84](../src/telescope/telescope-assets.ts#L84), awaits each required archive before checking its entry. Adding a small ZIP without changing priority would leave the large ZIP on the critical path.
4. Importing the [full-pixel export module](../src/telescope/full-pixel-telescope-exports.ts) imports geometry, recursive spawn scanning, wands, tooltips and other presentation dependencies together. [Image-processing initialization, line 59](../lib/noita-telescope-vm/js/image_processing.js#L59), reads three biome-map PNGs during browser module evaluation; [material data](../lib/noita-telescope-vm/js/potion_config.js#L254), [wobble flags](../lib/noita-telescope-vm/js/wobble_flags.js#L4), and [wand sprite rates](../lib/noita-telescope-vm/js/wand_config.js#L5) also use top-level await. Merely splitting exported namespaces does not break their cyclic imports through `utils`, scenes and spawn scanning.
5. The [adapter's asset join, line 382](../src/telescope/telescope-adapter.ts#L382), explicitly awaits translations as well as base maps, Wang templates and scene metadata before seed work. Later consumers directly access the main ZIP: [liquid-material inheritance](../src/telescope/liquid-surfaces.ts#L38), [scene PNG indexing](../src/telescope/telescope-osd-bridge.ts#L2259), scene/background decoding, and some [wand sprite fallbacks](../src/telescope/telescope-osd-bridge.ts#L281). Removing only the first adapter wait would move the stall rather than remove it.

## Accounted bytes

These are source measurements taken on September 27, 2026. ZIP values are the existing members' DEFLATE sizes, deduplicated by archive and entry path, without ZIP framing. Standalone estimates use Python `gzip.compress(data, compresslevel=9, mtime=0)`. Combining them estimates candidate compressed payloads; it is **not** a measured production transfer, a final pack size, or proof of sufficient inputs. Bundled JSON sizes also omit JavaScript wrappers and chunk boundaries.

| Terrain configuration group | Requests | Distinct resolved archive members | Compressed bytes |
| --- | ---: | ---: | ---: |
| NG0/NG+ and background/foreground biome maps | 4 | 4 | 10,731 |
| All configured Wang templates | 30 | 30 | 445,201 |
| All configured scene material masks | 352 | 305 | 876,330 |
| Authored scene color images | 202 | 152 | 2,400,901 |
| Scene backgrounds, including biome-specific variants | 75 | 75 | 1,122,027 |
| Current host biome backgrounds | 20 | 20 | 444,982 |
| **Union of these archive members** | **683** | **586** | **5,300,172** |

Category totals overlap; add the union, not the rows. Scene material and visual requests also need the packaged `cauldron.png` and `cauldron_fg.png`, absent from all three archives. Their gzip estimates are 9,786 and 311,077 bytes. The packaged nightmare biome map adds 3,388 bytes. The foreground fallback is now covered by the actual-PNG/interception asset test.

| Additional known terrain input | Raw bytes | Accounted compressed bytes |
| --- | ---: | ---: |
| Material atlas | 4,390,912 | 565,554 |
| Material atlas layout | 5,292 | 1,336 |
| Edge atlas | 414,720 | 29,012 |
| Biome flags | 14,493 | 1,928 |
| Material metadata | 137,135 | 11,602 |
| Prepared full scene metadata pack, 352 scene keys | 1,027,960 packed | 106,098 |
| `materials.xml` for inherited liquid/powder rules | 418,728 | 35,047 |
| Host-added Darkness/Potion Mimics foreground/background images | 18,656 | 17,905 |

The prepared pack value is the actual `full.bin.gz` at the inventory's manifest provenance. It contains placement/spawn metadata under the new lazy scene-loading implementation, **not all decoded scene pixels**. The separate `pixel_scene_meta.json` is an alternative metadata source (82,434 gzip bytes), not another required copy to add to that pack. [The scene-job enumeration](../lib/noita-telescope-vm/js/pixel_scene_generation.js#L646) and [lazy metadata load](../lib/noita-telescope-vm/js/pixel_scene_generation.js#L668) explain this distinction.

The original terrain candidate accounts for **6,339,953 bytes**. Including the two known host temple pairs and liquid XML raises this to **6,392,905 bytes**. A smaller **1,174,850-byte** subset covers the listed maps, Wang templates, GPU/material inputs and placement metadata, but excludes scene pixels and other final artwork; it cannot produce the complete final map by itself.

The current visible POI path has additional inputs:

| POI-related input | Raw bytes | Gzip estimate |
| --- | ---: | ---: |
| Host `public/assets/spritesheet.png` | 1,454,113 | 1,216,793 |
| Host atlas coordinates, `src/data/atlas.json` | 1,388,316 | 76,179 |
| Spell ID to sprite lookup source | 113,153 | 11,367 |
| Upstream wand sprite rate metadata | 39,855 | 13,300 |
| Translations currently awaited before generation | 1,534,897 | 567,773 |
| **Accounted POI/current translation inputs** | | **1,885,412** |

[POI data construction, line 538](../src/telescope/poi-spatial-index.ts#L538), awaits the host spritesheet and atlas. [Sprite lookup, line 96](../src/telescope/poi-spatial-index.ts#L96), also uses spell metadata. [Decoration export, line 1469](../src/telescope/telescope-osd-bridge.ts#L1469), draws these markers after scene artwork, while the [live marker source](../src/telescope/marker-tile-source.ts) draws them into requested OSD tiles. Loading the atlas or finishing the Flatbush index alone does not prove that every required final marker pixel or overview reduction is complete.

Terrain plus these POI/current-translation inputs accounts for **8,278,317 bytes**, about **0.662 seconds of ideal transfer at 100 Mb/s**. That leaves less than 0.338 seconds before accounting for unlisted static artwork, code, request latency, decompression, seed work, compilation, rendering and retention. The incomplete set is not a feasibility claim.

## Required closure work

- **Static map pixels remain unbudgeted.** The host protects or reveals artwork already in base DZI layers. A DZI descriptor and its overview tiles are insufficient if later detail must be available without downloading or generating missing final pixels. Inventory the actual nine-region static source ownership and all required native artwork; choose a lossless shared representation before claiming complete-map readiness. Preexisting static POI art must not be counted twice or silently omitted.
- **The host's fallback scene index broadens the union.** It scans `data/biome_impl` for `_visual`, `_fg`, `_background` and related names, then falls back by basename and shortened suffix. The explicit upstream scene catalog does not prove that every host-selected fallback is included. Export that mapping at build time and test it against the current resolution behavior. Host [vertical temple injection, line 1335](../src/telescope/telescope-adapter.ts#L1335), is a concrete extra already counted.
- **Background families differ.** The inventory separately enumerates upstream's 23 biome images (478,298 compressed bytes), 18 distinct edge masks (143,440), and 167 background-art images (2,341,545). These overlap each other and the host groups and are not added to the 8.28 MB estimate. They are candidates to reconcile with static DZI ownership and host output, not proof that adopting all upstream background drawing preserves the host's composition.
- **Top-level imports must be closed after host aliases.** `biome_backgrounds.js` loads its 4,036-byte gzip metadata at module evaluation; its broader art table is another 2,241 bytes. Whether those modules are required after app/browser/worker substitutions must be checked against the chosen rendering entrypoints. The material XML dependency is definite for the exact compositor. Its resolved liquid flags can be generated at build time, preserving inheritance, comments and material ID ordering.
- **POI generation cannot be dropped.** [Spawn scanning](../lib/noita-telescope-vm/js/poi_scanner.js#L338) recursively discovers more scenes while selecting POIs; [static spawns](../lib/noita-telescope-vm/js/static_spawns.js) also import wand generation. Preserve scene, POI and nested-spawn ordering, RNG, game mode, unlock state and parallel/vertical-world differences. Audit all sprite keys against the host atlas, including composites and special wands. Tooltip-only fallback images may be deferred only if the visible map never depends on them. Current translations stay in the budget until the label/display dependency is separated and verified.
- **Code and transport remain separate costs.** The source table excludes generated JavaScript, CSS, WASM, shader compilation, pack indices/hashes, and actual HTTP encoding. It also excludes the host's 33,214-byte gzip boundary metadata source because it is bundled into code. Measure emitted chunks and deployed bytes without double-counting the source JSON estimates.

The archives contain large asset families absent from the explicitly enumerated terrain union, including entity XML, enemy sprites, UI artwork, scripts, and effects. Their absence from that union does not make all of them safe to delete: visible POIs and any unclosed module dependency can still require a member. Keep the legacy archives available for genuinely later consumers while proving that the complete-map dependency graph never awaits them.

## Proposed bounded implementation

1. Add a deterministic build manifest with logical asset IDs, content hashes, archive/source provenance, decoded dimensions, and explicit roles: geometry/placement, final terrain artwork, static source art, and visible POI artwork. Enumerate complete config tables for supported modes/unlocks; a runtime trace from one seed is diagnostic evidence only. Include all 352 scene jobs and nested variants, not only scenes selected by a demonstration seed.
2. Build immutable packs from that manifest. Preserve the current specialized scene-material archive precedence; a similarly named original game PNG may encode different spawn/material preprocessing. Precompute biome-color lookups and material inheritance. Keep original authored alpha, FORCE AIR masks, background masks and marker offsets. Derive compressed atlases or expanded uploads from the same bytes; do not downsample native art to meet the size budget.
3. Introduce an explicit initialization API supplied with loaded render/POI inputs. Break top-level fetching cycles, start code/pack fetch and compilation preparation together, and let workers read the same immutable pack without waiting for the main thread's Cache API write. Route all mandatory reads through the manifest before any legacy archive fallback. A missing mandatory manifest entry is a closure failure, not a transparent PNG.
4. Preserve visible POI generation and composition in the measured pipeline. Split only work whose output is needed solely on tooltip/search interaction and whose removal does not alter chosen scenes, markers or RNG. Prepare sprite uploads and marker indices concurrently with terrain when their dependencies are available. Join their actual completion, including final marker painting/reductions, before reporting a complete map.
5. Switch the adapter, bridge scene/background reads, exact liquid input, and marker asset paths together. Make persistence optional and off the foreground completion path. Content-addressed URLs permit immutable caching without a serial HEAD validation request. Keep an explicit legacy path for optional UI assets rather than an accidental main-ZIP dependency from the new resolver.

## Verification and timing gate

Use nonbrowser tests first: enumerate every manifest configuration and resolve every request; compare archive/source hashes and decoded pixel bytes; fail on unmapped required assets. Compare precomputed biome/liquid tables to their current parsers. Compare the isolated generation entrypoint against the existing one for complete scenes and visible POIs, including positions, variants, draw order, material replacements, unlocks, NG0/NG+, Nightmare and all nine regions. Seed samples are useful parity checks, but static configuration closure must cover rare paths that those samples do not select.

Exercise both main and worker initialization with the legacy archive API replaced by a throwing stub. Include exact composition and marker rendering, not only `onTerrainReady`. Verify missing/slow Cache API storage cannot block valid loaded inputs. Test atlas coverage across the configuration union and independently compare composite marker pixels and offsets.

Then measure the actual emitted/deployed mandatory byte set and the dependency timeline on the agreed network, with cache conditions stated. Report code, geometry/placement, scene art, static art, POI art, decoding, compilation and final composition separately, while counting the full navigation-to-completion wall time. No new browser run or input-pack runtime implementation was performed for this audit. The [full-map generation plan](full-map-generation-plan.md) covers GPU throughput, memory and retained final results after the input bottleneck is removed.
