Independent ordered page composition

createPageComposer(inputs) returns composePage(page), a synchronous function that
returns a fresh Uint8ClampedArray of final native RGBA. It never mutates the page's
input carriers. The caller resolves base foreground, ownership, background phase,
global liquid runs, and every selected scene instance before composition. The
separate optional background page is a raw carrier before scene background art.
Inputs remain immutable for the composer's lifetime.

Scene sources and per-placement preparation

await createSceneSourceLoader(assets, {cacheBytes?, definitions?}) loads the v1
data/pixel_scene_meta.json through NativeAssets and returns a source loader.
loader.load(placement) or loader.load(key) reads the exact material PNG, colors
file and background through the same explicit reader. No global rules install,
browser state, asset interception or host scene-filtering policy is required.
The default catalog preserves original first-key-wins source-biome selection,
directory aliases, explicit directory overrides, colors-file aliases, authored
background paths and skip-edge flags. An explicit definition Map may replace it.
Missing metadata, stale dimensions and missing declared art are errors.

The loader retains decoded sources under its byte budget (default 32 MiB), joins
duplicate in-flight requests, and returns oversized sources uncached. clear()
releases cached sources. Returned data is immutable to callers. Material and
visual sources preserve invisible source RGB using native PNG decode's explicit
preserveTransparentRGB option; backgrounds retain normal zero-RGB transparency.
Black material pixels and metadata spawn coordinates are cleared exactly once.
Original hasAir/hasBiomeFill, spawn triples and MSB-first metadataArtMask are
retained. The caller separately owns static/captured-art and layer policies.

createNativeScenePreparer(resources) returns prepare(placement, rawSource), a
synchronous function producing one full PreparedNativeScene. The result retains
key/name/variantKey metadata. The factory keeps only immutable lookup maps and
does not cache expanded instances. Streaming cookers own their instance budget.
prepareNativeScene(placement, source, resources) is the one-shot equivalent;
prepareNativeScenes(placements, sourcesByKey, resources) is a bounded-batch helper.

Preparation resources are explicit: NativeMaterialAtlas; generatorConfig;
engineBiomes in the complete material WASM's zero-based BIOME_ENGINE order;
materialNames; wangMaterialIds; fillBiomeMaterials; fillLayerMaterials;
biomeBackgroundColors; biomeForegroundColors; and a bands resolver exposing
resolveCoverageBandPoints. The latter is the owned complete-materials resolver,
queried in batches of at most 4096 full-coverage absolute scene coordinates.
No topology support gate is imposed on a scene's density-band selection.

Ordered substitutions also affect invisible RGB. Color and material lookups remain
distinct. Density-to-air adds an erase instruction; a transparent texture texel
does not invent one. Material/texel partial alpha erases old foreground before
compositing. Visual art cannot create a cell where the material painter made air.
The ordinary native force-air override is retained even for legacy display
exceptions such as friend rooms. No scene is clipped to a page before preparation.

World composition resources

await createWorldCompositionResources(world, preparedMaterials, assets,
  {edgeModule, scenes, generatorConfig?, liquidMaterialIds?, ownershipPolicy?})
prepares the remaining owned context. edgeModule is the existing edge WASM's
bytes/module, and scenes is the selected placement metadata (key/variantKey).
The result contains edgeStamper and the two named biome color maps needed by
createNativeScenePreparer. forPlane(-1|0|1) returns ownsTerrain, backgroundAt,
liquidSurfaces, sceneAirBackground, skipSeamAt, chunkShiftX and chunkShiftY, plus
the coarse ownership maps for indexing. The caller's material resolver and atlas
provide materialAt/readMaterials/liquidColor. staticSceneBits is the shared
LSB-first mask builder for placements the caller classifies as static.

The terrain claims, vertical material ownership, repeated temples, continued
elevator columns, carved-room backgrounds, absolute texture phase, connected
liquid levels and inherited liquid/powder physics match the existing compositor.
The optional ownershipPolicy edits the coarse claim map explicitly before its
background ownership is derived. It does not introduce a hidden host policy.

Resource paths are explicit: data/edge_atlas.bin, data/materials.xml (unless
liquidMaterialIds is supplied), named data/weather_gfx/*.png backgrounds, and
data/biome_impl/biome_map{,_background,_foreground}.png. The latter are the actual
deployed game color maps. The fork's data/biome_maps convenience copies differ
at Water Cave and must not be substituted by a generic asset reader. Source
readers must preserve each requested asset's revision and fail on missing data.

Order is fixed:
  1. Ownership-filtered base foreground and separate base background.
  2. Globally connected liquid surface leveling with original-material probes.
  3. All overlapping scene background art in original scene order.
  4. Ordered scene foreground, erase masks and missing-background air fill.
  5. Terrain edge generation/seam passes, then sequential scene material writes
     and scene edges, using the existing owned edge WASM.
  6. Static force-air clear.
  7. Straight-alpha foreground/background composition at reference precision.
  8. Ordinary static ownership clear.

PreparedScene.pixels must already include per-placement material textures,
density-band selection, ordered variant replacements, force-air and visual art.
eraseMask is RGBA, where any nonzero alpha erases old foreground before that
scene's pixel is composited. sourceAlpha is one byte per ORIGINAL source pixel;
it controls edge ownership and cannot be reconstructed from the finished alpha.
backgroundArt is top-left anchored and may be larger than the material scene.

PreparedScene.edge contains the FULL signed material grid, not a page crop:
-2 untouched; 0 air; 0x7ffe unknown; positive IDs actual materials. artMask uses
MSB-first bits, unlike static masks which use LSB-first bits. The strict adapter
computes whole-scene edge eligibility from the full grid unless edgeEligible is
explicitly supplied. Each scene changes the live edge grid and clears/resets old
decal state in sequence, including scenes with skipEdges. Flattening those writes
into one material page before stamping is not equivalent.

materialAt/readMaterials must answer the original pre-scene field. The adapter
keeps the canonical 32-pixel output halo; for the current 17-pixel sprite reach
it reads 21 pixels of material halo and leaves the unused outside ring zero.
Liquid bottom probes may require values beyond that halo. Incomplete rectangular
material reads throw. Pages larger than the 640x640 padded WASM capacity throw.

createStrictEdgeStamper(wasmBytes, {tables, atlas, atlasWidth}) instantiates the
existing ../edges/core.wasm, checks its ABI and resource layout, and returns the
concrete edgeStamper. There is no optional download or reference fallback.
PreparedEdgeTables uses the exact existing edges/data.ts ABI; its normal/ray
tables must be built with the consuming runtime's Math. Resource preparation and
asset identity checking belong to the caller. The WASM reserves 16 MiB memory.

skipSeamAt(chunkX, chunkY) receives integer SHIFTED chunk indices. The existing
policy resolves the source biome at (chunkX*512 - chunkShiftX + 256,
chunkY*512 - chunkShiftY + 256), using noiseBiomeEdges !== false, then tests the
skip-seam biome set. Return an explicit boolean for every requested chunk.

Tests:
  node node_modules/vitest/vitest.mjs run tests/native-composition.test.ts
  node node_modules/vitest/vitest.mjs run tests/native-composition-runtime.test.ts
  node node_modules/vitest/vitest.mjs run tests/native-scene-preparation.test.ts tests/native-scene-source-loader.test.ts
  node node_modules/vitest/vitest.mjs run tests/native-composition-resources.test.ts

The first suite checks the concrete WASM adapter across all shipped edge-material
families, scene ordering/art/eligibility, atlas alpha semantics and strict failure
behavior. The second builds the composer independently and compares real completed
pages against the current CPU pipeline using its JS edge stamper. Reference-only
input capture exists under tests/helpers, never in production composition.
Those pages now use this loader and preparer, with independent byte comparisons
of their full sources, prepared colors/erase masks and signed material/art grids.
Repeated actual catwalk variants demonstrate placement-dependent color results.
No new-seed whole-map speed or real-game capture parity is implied by these tests.
