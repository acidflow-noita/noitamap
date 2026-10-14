Completed final pixels and map readiness

This module stores immutable, already-composed RGBA. It does not generate terrain,
evaluate seed rules, draw layers, or promise fast first-time map cooking. The prior
native-pixel-block-codec and native-mip-dependencies experiments remain evidence
that compressing already-rendered seed pages alone does not solve that problem.

SharedPixelStore owns a content-interned DAG. Solids are four-byte colors that can
fill any square. Small nonuniform squares use packed palette indices when that
is smaller than literal RGBA; larger squares refer to four shared child nodes.
Hash matches are checked against exact bytes, including RGB at zero alpha.
IDs are one-based and local to a store. Node, page and image references remain
valid as preparation appends more content for other maps. Public reads and leaf
inspection return detached byte arrays; branch/solid inspection is immutable.

For successive seeds, seal the one-time library with freezePreparation() and use
baseline.fork() for each cook. A fork reads the immutable base nodes, pages,
images and interning indexes without copying them, and owns only its additions
and memo entries. Base IDs remain stable; dynamic IDs belong to that fork only.
The baseline has no references to its forks. Keeping an older CookedMap alive
keeps its own private store valid during replacement; releasing that map and its
compiler/composer lets those seed allocations be collected. Use a fresh composer
for each fork because its memo tables also contain seed-local IDs. A frozen base
rejects mutation, and a seed fork cannot become a new baseline, preventing chains
that would retain earlier seed stores. stats() separates owned/shared node, page,
image, payload and reference counts; ownedInternEntries counts retained index
entries, not JavaScript heap bytes. Count shared payload once across live forks.
CookedMapBuilder.seal freezes a seed fork for display after the full map and all
global mips are validated. freezeForDisplay() discards only its owned interning
and reduction indexes, retains immutable nodes/page/image references, and rejects
later mutation. Failed seals leave the staging store usable. Original stores
remain appendable for legacy callers; a restored display store may explicitly
freezeForDisplay too. Preparation baselines retain their shared lookup indexes.

Preparation API (import store.ts, or the index.ts convenience entry):
  new SharedPixelStore({pageSize: 512, leafSize: 8})
  addBlock(rgba, side) -> PixelNodeId
  solidBlock([r,g,b,a]) -> PixelNodeId
  joinBlocks(side, [topLeft,topRight,bottomLeft,bottomRight]) -> PixelNodeId
  inspectNode(nodeId, side) -> solid with rgba, branch with children, or leaf
  readBlock(nodeId, side, x=0, y=0, width=side, height=side) -> detached RGBA
  commitPage(rootNodeId) -> PageId
  addPage(finishedRGBA) -> PageId
  solidPage([r,g,b,a]) -> PageId
  freezePreparation() -> PixelStoreBaseline with fork()

joinBlocks concatenates finished fragments; it never performs composition.
commitPage prepares all local mip roots before publishing its PageId. Reductions
are memoized on exact node content and recurse through shared children; no dense
512-square buffer is needed to commit a prepared root or explicit solid page.
Small joined fragments canonicalize to the same leaf as addBlock of their bytes.
Preparation retains hash and reduction indexes; stats().nodePayloadBytes measures
stored node payloads only, excluding JavaScript objects and those indexes.

PixelDecoder in decoder.ts imports only byte-format helpers. readRect(pageId,
level,x,y,width,height) looks up/copies stored bytes. Level 0 is native resolution;
level 9 is one pixel for a 512-square page. Every mip uses the exact staged
premultiplied-alpha 2:1 box filter and integer rounding from terrain-pyramid.mjs.
Native hidden RGB is preserved; completely transparent mip cells become black
with zero alpha, matching the reference. Mips must describe the final composite,
not independently reduced layers. Decoding never invokes the reducer.

CookedMapBuilder(store, manifest = NORMAL_MAP_MANIFEST) is staging state, with
completedPages, missingPages, expectedPages, and put({horizontal,vertical},x,y,id).
put accepts only a completed page from that store, rejects conflicting writes,
and permits an identical repeated write. There is no readRect or ready flag on
an incomplete builder. seal() fails if any declared page is absent. An explicit
transparent page is valid; a missing page never becomes transparent implicitly.

The normal manifest contains every horizontal/vertical coordinate in -1,0,1,
each with 70 by 48 pages of 512 pixels. This is 30,240 page references, 35,840 by
24,576 pixels per region, global origin (-53,760,-31,744), and complete size
107,520 by 73,728 pixels. Page references consume 120,960 bytes per map. A generic
manifest can set pageSize, regionColumns, regionRows, regions and origin, but
its declared region coordinates must form a complete rectangle without holes.

seal() also joins the final one-pixel page grid (210 by 144 for a normal map) and
prepares every remaining global reduction through 1 by 1. Odd edge pixels are
reduced with transparent padding on every stage, as in the reference. Those
eight normal-map roots add 32 bytes of references; their shared node payloads
belong to the store. Only then is CookedMap.ready true. CookedMap.readRect uses
page references at local levels and stored global images above them. Coordinates
are relative to the manifest origin at the selected mip level. page(region,x,y),
levelSize(level), width, height, maxLevel, store and pixels are also available.
All pixels and global mip references exist before this map can be read.

Persistence is explicit and separate from decoding. map.exportSnapshot() returns
a structured-clone/IndexedDB value containing the manifest, compact remapped page
and global-mip references, and only their reachable nodes. It excludes unrelated
pages, unused fragments, preparation indexes and seed rules. Exported buffers do
not alias live content. Store.exportSnapshot(pageIds,imageIds) exposes the same
selection mechanism independently; returned pageRefs/imageRefs preserve request
order, including duplicates. These typed-array records are not JSON text.

Prepared fragments smaller or larger than a page can be exported independently:
baseline.exportBlocks([{root,side}, ...], optionalPreparedPageIds) (also available
on a mutable store) returns a PixelSelectionSnapshot. Explicit page selections
retain their already-completed mips in pageRefs; the default is no page records.
The returned imageRefs
address square images containing exactly the requested reachable roots, including
duplicate selections. Export does not add pages, mips, image records or payloads
to the baseline. After SharedPixelStore.fromSnapshot(selection.store), call
store.imageBlock(selection.imageRefs[i]) to obtain the restored {root,side};
export remaps node IDs, so retain these references with the prepared recipe.

restorePixelStore(snapshot) in snapshot.ts validates all payload lengths, node
dimensions, backward-only child references, palette bounds, reachability and
complete local mip lists, then exposes a byte-only decoder. restoreCookedMap in
map-snapshot.ts additionally checks the map's exact page count and complete global
mip dimensions. It restores a SharedPixelStore so prepared fragments can be reused
for subsequent work. Validation checks structural completeness, not provenance
against game captures or recomputation of every stored mip. A persistence caller
must keep the exported store and remapped references together in one transaction.
RestoredPixelStore.copySnapshot() returns detached validated tables in their
original order. SharedPixelStore.fromSnapshot uses that order unchanged: prepared
recipes may reference raw node IDs, so restoration must never renumber nodes by
the order of pages or images. Reachable selection export remains the explicit
operation that remaps IDs and returns corresponding reference tables.

Verification lives in cooked-pixels.test.ts: exact native/local mip round trips
for three existing captured-gold page cores; whole-image reference reductions
across pages and odd edges; fractional/zero alpha; collision-safe interning;
prepared fragment composition; explicit all-nine readiness; immutable reads;
reachable snapshot round trips and malformed input rejection. The captured-gold
fixtures retain their existing provenance and do not establish new game fidelity.
