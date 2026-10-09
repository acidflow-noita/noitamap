# Telescope render-perf update

Reviewed `386ee756893d10ec6626e815f9d40111dd4e3791` → `fa9cd25d902f04b234896716eca3ba52b2d11856` (14 commits). The update improves startup, scene drawing and edge stamps; it does not generate or retain every terrain pixel.

| Change | Effect in this host |
| --- | --- |
| `47af5ac` render HUD and GPU timer queries | Instrumentation is available in the library, but standalone HUD orchestration is replaced by the host app shim. |
| `8bd627e`, `fc501d3` answer failed scene builds; mark newly arrived bitmaps as recently used | Prevent stuck worker slots and immediate eviction loops in upstream's bitmap pipeline; our compositor uses its own cache. |
| `1419c59`, `c1b53fb` bounded per-world caches, two overlay jobs in flight, discard offscreen queued jobs, skip unused CPU overlays under GL | Standalone application improvements; importing the library does not adopt these policies. |
| `915c087` NG+ biome columns wrap on the map pitch | Automatically updates imported CPU/GPU biome lookup: 32768px biome pitch, 32760px world-content translation. Old final-pixel cache entries must be invalidated. |
| `77a6922` sparse edge candidates, precomputed normal rays and cropped-halo scan | Imported stamping improvements apply. Host now passes `inset: pad` to enable the cropped-halo optimization. The commit's approximately 45% speed claim is upstream's measurement, not a host benchmark. |
| `1a56799` 256MB scene-image default | Applies to upstream's bitmap cache; does not enlarge host caches. |
| `61f7d20` one-pass GL backdrop atlas | Requires host adoption. Host currently composes its own backgrounds. |
| `91ff9a5` resident GPU scene atlas and instanced draws | Requires host adoption. Upload budget is 16MiB/frame; spatial-query rebuilds are throttled to 50ms during arrival bursts. These retain scene images, not generated terrain. |
| `c5a7b91`, `7f545e4` precomputed scene metadata, lazy PNG decoding, faster spawn scanning, no unused PNG bitmap decode | Metadata enables smaller full-pixel prepared scene packs; used scenes decode when the host needs their pixels. Sprite/art bytes no longer need copying into POI workers. Upstream zip request coalescing is bypassed by our archive shim, which already coalesces extraction. |
| `7a079f5` perk/spell sheets | Bundled tooltip code needs literal sheet asset URLs; browser transform now supplies these. Host marker rendering retains its existing atlas. |
| `fa9cd25` scaled texture filtering | Imported terrain shaders filter material texels (up to 16 taps); exact 1:1 sampling remains nearest. This neither evaluates every covered terrain cell nor preserves all thin topology at overview scale. |

Integration fixes accompanying the submodule update:

- Strip the metadata reader's Node filesystem branch only in browser builds; keep upstream native tools intact.
- Bundle scene metadata and icon sheets. Preserve the older fork's optional PNG bitmap optimization.
- Await lazy scene pixels before scene compositing, full-resolution material extraction and static/FORCE AIR mask creation, including live terrain masks.
- Preserve metadata-only worker snapshots after main-thread pixels have warmed. Bump generator and final-pixel cache identities.

Further adoption must preserve compositing semantics. The new scene pass groups draws by atlas page, which can reorder overlapping scenes; it erases all FORCE AIR masks before painting scene colors; and an atlas allocation failure can omit a mask. Validate overlaps, static art and air holes before replacing the host compositor. Its scene mip averaging also reuses the selected strongest-alpha pixel index in the color sum; when that index changes it duplicates a neighbor and omits the original lower-right texel. The host's retained terrain pyramid does not use this helper.

The new HUD registers a closure for every `GLTerrainRenderer` in a global poller array, without unregistering it. The host browser transform removes that unused standalone subscription, allowing discarded main-thread renderers and their resources to be collected. Host timing and cache diagnostics remain available. Worker termination releases its separate module state.

The largest next improvement is to render final-resolution terrain tiles once into GPU textures, composite scenes/decals there, and derive overview tiles from completed children. Keep viewport changes out of the generation cache key. Persist completed tiles separately from the bounded GPU working set, and let OSD reuse completed ancestors during pan/zoom. A GPU material resolve followed by CPU scene/decal finishing and GPU re-upload still pays readback/copy costs; move those passes together or measure them separately. Edge-decal ordering, material IDs, large-coordinate precision, context loss and exact static masks remain correctness constraints. See [host performance review](terrain-performance-review.md) for the current renderer paths and memory costs.
