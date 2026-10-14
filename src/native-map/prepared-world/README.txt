Prepared final-image compiler

This is an engine component, not a new site route. It compiles explicit final
image recipes into a sealed CookedMap; display receives only immutable pixels,
page references, and completed mip levels. No material/noise/RNG/edge callback
is stored in the decoder. The site is not switched to this path yet.

One-time preparation
- PreparedWorldBuilder references concrete image fragments. It evaluates constant
  composition and finite alternatives controlled by one common selector once.
- Separate selectors remain separate. The builder does not enumerate a Cartesian
  product of independent world decisions or assume matching selector cardinality
  means the decisions are interchangeable.
- The builder prepares each constant page's full exact mip chain, then freezes a
  shared baseline. exportPreparedWorld prunes unreachable preparation programs
  and preserves reachable pixels and mips. restorePreparedWorld checks revision
  and all graph/page references without recomputing prepared pixels.

New seed
- PreparedWorldCompiler.compile takes finalized choices and optional resolved
  exception fragments. A callback receives the private seed store for writing
  those fragments; node IDs from another seed must not be passed as bindings.
- Every page in the explicit manifest is committed. All cross-page mip levels
  are closed before the method returns. Missing choices/fragments/pages fail;
  zero never substitutes for an unresolved image. Abort never returns a map.
- Each seed forks the shared baseline. Old visible maps cannot retain new seed
  exceptions, and neither seed can mutate the other's pixels. After sealing,
  private construction indexes are released; the baseline remains reusable.
- Long program walks yield to the worker event loop at timed checkpoints, so
  a subsequent seed/cancellation message can arrive before the cook finishes.

Fragment operations preserve exact straight-alpha composition, hidden RGB at
alpha zero, binary masks, clipped integer placement and order. Fractional/rotated
art must be rasterized with the actual rendering policy during preparation;
this module never rounds a placement to fit the representation.

The normal manifest contains30,240 pages across all nine regions. The all-nine
unit test uses deliberately simple image alternatives to test admission and
readiness. Its execution time is NOT a Noita generation benchmark.

Native assembly boundary
complete-world builds actual owned terrain/scenes pages from native world
decisions. cookTerrainSceneLayer requires exactly the nine standard regions,
accepts a selected page table referencing the frozen prepared library and can
retain its output in this store. It checks missing coverage before rasterizing;
maxReferencePixels:0 rejects any missing recipe rather than silently baking a
world on the CPU. An explicit positive budget permits the exact reference path
for correctness checks and preparation. Static captured artwork and POI imagery
remain separate host layers; the result is explicitly terrain-scenes-layer.
Library selection and the cost of building that library are outside this
all-page owner; zero reference work here does not itself establish overall
new-seed speed. The caller owns source.dispose() after cooking.

Unfinished performance-critical work
There is no complete seed-independent Noita image recipe catalog yet. A caller
must prove each prepared page accounts for current geometry, materials, liquid
runs, ordered scenes, edge decisions, ownership and static masks. Reusing a
same-coordinate page or caching a finished seed is not that proof. The existing
bounded Wang/group catalogs cover only subsets of base terrain and cannot be
used as completed-page recipes. Conservative finishing dependencies currently
touch most sampled pages. Exact authored-tile interiors plus bounded boundary,
scene and edge exceptions still need a compact all-nine representation.

The scalar owned page source is a correctness/preparation implementation, not
an instant new-seed architecture. Its measured real-page costs are recorded in
../complete-world/parity-result.json. This component makes no subsecond or weak
device performance claim and has not been connected to the live map controls.

Validation
Run npm test -- src/native-map/prepared-world
Tests cover actual material-atlas bytes, hidden RGB, clipped/masked/ordered
composition, mip equivalence, prepared alternatives, independent selectors,
snapshot reopening, separate seed lifetimes, all30,240 page addresses, missing
inputs, cancellation, and a12,000-step ordered image graph. Real world pages
through owned material/scene/edge code and stored mips are tested separately by
complete-world. Those comparisons establish compatibility with the current
reference pipeline, not additional accuracy against Noita captures.
