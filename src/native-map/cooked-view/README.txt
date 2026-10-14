Display and persistence of complete native pixel maps

CookedTileService(map, {tileSize:512, overlap:2}) accepts only a sealed CookedMap.
OSD level L maps to map.maxLevel-L, where native level 0 is full resolution.
Every request copies its exact rectangle from the already-completed local or
global mip, including clipped overlap at the map boundary. No requested tile
can invoke preparation, a seed rule, compositing, reduction or an approximate
fallback. An explicit transparent page is a valid image; a missing page never
reaches this service because the CookedMap seal rejects it.

service.ts is the direct worker-compatible import: it depends only on the final
map decoder and has no DOM or persistence imports. read({level,x,y}) returns
RGBA plus its exact bounds; handleMessage({id,level,x,y}) returns a success or
error response. A successful response's tile.rgba.buffer is transferable.
The copied buffer belongs to that response, so transferring it cannot detach
the immutable shared map. Map installation/worker transport can own the service
for one map lifetime without adding generation callbacks.

createCookedTileSource({map,id,tileSize?,overlap?}) uses the site's global OSD
instance and returns {source,service,originX,originY,width,height}. Use a distinct
id for each complete map/revision. It yields before completing ImageJob, copies
stored bytes to an OSD-owned canvas with smoothing disabled, and handles abort,
timeout callback retirement and source removal without late completions.
There is no secondary canvas cache: OSD owns its received canvases, while the
completed map remains the reusable byte source. No live app or UI is changed.

CookedMapStorage provides explicit IndexedDB persistence:
  saveLibrary(key, preparedWorldArtifact)
  openLibrary(key) -> PreparedWorldArtifact | null
  saveMap(key, cookedMap, {libraryKey?}) -> {sharedNodes,storedNodes}
  openMap(key) -> CookedMap | null
  deleteMap(key)
  close()

The database schema, prepared-library records, completed-map records, source
artifact and pixel snapshot each carry an explicit version. Library keys are
immutable/add-only; a changed asset/rule/preparation revision needs a new key.
saveLibrary copies the caller's artifact and validates both its prepared recipe
and final-pixel graph. Recipe metadata is preserved, so openLibrary can feed
restorePreparedWorld without rebuilding selected page mips. Libraries always
come from the preparation pipeline; completed seed maps are never promoted into
reusable libraries by this storage API.

Completed-map records genuinely share on-disk prepared pixel payloads. Exact
content matches point to library nodes with negative IDs; positive IDs point to
the map's private nodes. Hashes narrow candidates, then every payload/child list
is compared exactly before sharing. Prepared library pixels are stored once.
No library is required for a standalone completed-map snapshot. Saving a map
with a library verifies that dependency inside the same transaction that writes
the complete map record. Library keys cannot be overwritten through this API.

Transactions request strict durability. Save resolves only on transaction
completion, never on individual request success. A quota/abort failure preserves
the previous complete record. Reopen reads the map and its library in one
transaction, validates the complete graph and all page/global mip references,
and freezes the returned display store to release mutable interning indexes.
Missing keys return null. Corrupt/incomplete records, missing libraries, quota,
blocked upgrades, timeouts, unavailable storage and closed owners throw explicit
CookedStorageError values; none return a partial map or silently regenerate it.

On-disk sharing does not yet mean shared RAM between multiple reopened maps.
Each openMap currently reconstructs one complete store in memory. Independent
new-seed compilation uses the separate preparation-baseline/fork API, which
shares prepared memory. Closing storage closes its connection; transactions
already issued may finish. Records are local structured-clone data, not JSON.

Verification: pure tile-service tests cover every OSD level, global mips, odd
edges, overlap and transferable byte ownership. Installed OpenSeadragon runs in
jsdom with native Skia for asynchronous ImageJob ownership/cancellation checks.
A transactional IndexedDB test double covers reopen across connections, library
sharing, recipe persistence, commit-time quota rollback and explicit failures.
These checks do not claim real-browser IndexedDB or browser-renderer validation.
