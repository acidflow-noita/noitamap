Named cave-state input boundary

This is an owned interchange envelope for selected Noita generation INPUTS.
It is not a Noita save-file parser, process reader, gameplay-state snapshot,
complete cave-state capture, or proof that every map pixel matches a game run.
There is no real capture/exporter integration or end-user import control yet.
No UI or existing live Telescope adapter uses this module yet.

The confirmed topology0 sampler reads a named modifier grid's W/H, exact F32
samples and node+0x94 sampling offset. Live analysis verified these fields against
noita.exe SHA256a0d9f9ca513e27a598c61dd9a19211c7a11d1477c9a2b93d909757d91d17d914.
See task/instant-map-dependencies/caves/capture-boundary.txt and its byte evidence.
This module preserves actual node94; it never replaces it with width*5.

The four named topology0 inputs already supported by the owned kernel are
$biome_desert, $biome_pyramid, $biome_winter and _EMPTY_. The latter two can depend
on startup/runtime information absent from the world seed. Missing imported
winter/EMPTY grids remain null/missingModifier; they are not filled using the
incomplete seed-only approximation. Optional captured desert/pyramid grids also
override preparation; otherwise their existing deterministic preparation remains.
The other topology0 surface phase and bitmap offset retain the existing
world-seeded local-MINSTD chain and rounding. This import adds no new scalar
reconstruction claim. Supplying both a full topology0 override and imported
generationState is rejected as ambiguous.

winter_caves initially creates a DIRECT per-topology node outside the named
cache. Verified normal Wang generation later replaces that node with a newly
allocated shared world lattice; the initial phase-F grid is not copied into it.
The normal path therefore does not need another winter_caves modifier import.
Nonstandard configurations disabling that generation path are not supported by
this schema/kernel hook. A winter_caves/direct-node record is rejected, never
discarded or aliased to $biome_winter. Even all four named grids do not establish
complete runtime state, past chunk generation, POI/scene state or physics.

API
- importCaveGenerationState({manifest,buffers}, trustedExpectedContext) verifies
  schema, scope, version, binary/data/config/load-order SHA256 identities, asset
  revision, seed, NG+, mode, dimensions, counts, exact LEF32 bytes and checksums.
  The expected identity must come from the application's selected engine/assets,
  not by copying the uploaded manifest. Actual process addresses are not inputs.
- Manifest captureId is an EXPORTER identifier. Consistency is an explicit
  stopped-process/coherent-copy assertion. Structural validation cannot establish
  that an exporter genuinely captured atomically. Synthetic fixtures are labeled
  synthetic. No native frame counter or raw startup-RNG sufficiency is invented.
- The importer snapshots every buffer/metadata item before awaiting checksums,
  rejects nonfinite samples, shared buffers and unsupported grids, and publishes
  a frozen opaque token. Private arrays cannot be borrowed or mutated externally.
- exportCaveGenerationState returns fresh byte copies for durable storage or
  worker transfer. Tokens cloned into another realm must be reimported there.
- generationState on CompleteMaterialInputs/CompleteWorldOptions accepts
  {state,expected}; the world API also checks actual seed/NG+/mode/asset revision.
  The material API verifies seed and physical map size. All public metadata
  reports generationStateDigest. Source options are snapshotted before deferred
  resolver creation.
- withCaveStateCacheIdentity(fullSeedAndSettingsKey,state) adds the content digest
  as a separate namespace. It distinguishes state-free and captured maps. The
  digest includes scope, binary/data/config/order, seed/mode, dimensions, exact
  node94 bits and grid bytes; captureId/method are provenance, not pixel content.
  Equal content from two coherent captures can reuse pixels. Existing prepared
  final-page admission checks this digest and forwards it with the cooked result.

Bounds and coverage
One to four grids; each dimension1..4096 and at most1,048,576cells; total source
bytes<=16MiB. node94 is bounded finite float32. Sizes are validated before copies.
Negative densities and negative zero preserve their exact finite F32 bits.
No byte quantization, lossy JSON numeric-array conversion or coordinate rounding.

A coherent grid snapshot supports reevaluating this density input at that instant.
It does not reconstruct historical chunks generated with an earlier version of a
mutated grid, changed materials/entities, or subsequent physics simulation.
No authentic captured modifier-grid F32 file was found in the provided tree.
The regression fixtures are explicitly SYNTHETIC and exercise validation, content
identity, ownership and actual WASM pass-through; they are not game capture parity.
