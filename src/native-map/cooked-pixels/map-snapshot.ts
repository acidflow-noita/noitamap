import { CookedMap, type CookedMapSnapshot } from "./map-decoder";
import { SharedPixelStore } from "./store";

/** Persistence/preparation boundary; separate from the byte-only decoder. */
export function restoreCookedMap(snapshot: CookedMapSnapshot): CookedMap {
  if (
    !snapshot ||
    snapshot.format !== "noitamap-cooked-map" ||
    snapshot.version !== 1
  )
    throw new Error("Invalid cooked-map snapshot format/version");
  const store = SharedPixelStore.fromSnapshot(snapshot.pixels);
  return new CookedMap(
    store,
    snapshot.manifest,
    snapshot.pageRefs,
    snapshot.upperMipRefs,
  );
}
