import { type PageId } from "./format";
import { CookedMap } from "./map-decoder";
import {
  mapLayout,
  NORMAL_MAP_MANIFEST,
  pageIndex,
  type CookedMapManifest,
  type MapLayout,
  type RegionCoordinate,
} from "./manifest";
import { reduceFinalPixels } from "./mip";
import { SharedPixelStore } from "./store";

/** A staging manifest. It is deliberately not a ready map or a tile source. */
export class CookedMapBuilder {
  readonly store: SharedPixelStore;
  readonly manifest: CookedMapManifest;
  readonly expectedPages: number;
  readonly #layout: MapLayout;
  readonly #pageRefs: Uint32Array;
  #completedPages = 0;
  #sealed: CookedMap | undefined;

  constructor(
    store: SharedPixelStore,
    manifest: CookedMapManifest = NORMAL_MAP_MANIFEST,
  ) {
    this.#layout = mapLayout(manifest);
    if (store.pageSize !== manifest.pageSize)
      throw new Error("Cooked-map/store page size mismatch");
    this.store = store;
    this.manifest = this.#layout.manifest;
    this.expectedPages = this.#layout.pageCount;
    this.#pageRefs = new Uint32Array(this.expectedPages);
  }

  get completedPages(): number {
    return this.#completedPages;
  }
  get missingPages(): number {
    return this.expectedPages - this.#completedPages;
  }

  put(region: RegionCoordinate, x: number, y: number, id: PageId): this {
    if (this.#sealed) throw new Error("Cooked-map builder is already sealed");
    const index = pageIndex(this.#layout, region, x, y),
      previous = this.#pageRefs[index];
    this.store.decoder().assertPage(id);
    if (previous && previous !== id)
      throw new Error("A final page is already committed at this address");
    if (!previous) {
      this.#pageRefs[index] = id;
      this.#completedPages++;
    }
    return this;
  }

  seal(): CookedMap {
    if (this.#sealed) return this.#sealed;
    if (this.missingPages) {
      const index = this.#pageRefs.indexOf(0),
        x = index % this.#layout.pageColumns,
        y = Math.floor(index / this.#layout.pageColumns);
      const horizontal =
          this.#layout.minHorizontal +
          Math.floor(x / this.manifest.regionColumns),
        vertical =
          this.#layout.minVertical + Math.floor(y / this.manifest.regionRows);
      throw new Error(
        `Cannot seal cooked map: ${this.missingPages} missing pages; region (${horizontal},${vertical}), page (${x % this.manifest.regionColumns},${y % this.manifest.regionRows}) is absent`,
      );
    }
    // Only the final page1 grid is dense (normal map: 210*144*4 bytes).
    // Every map-wide parent is reduced now; the decoder never makes a mip.
    let width = this.#layout.pageColumns,
      height = this.#layout.pageRows;
    let pixels: Uint8Array = new Uint8Array(width * height * 4);
    const decoder = this.store.decoder(),
      level = decoder.maxPageLevel;
    for (let i = 0; i < this.#pageRefs.length; i++)
      decoder.copyRect(this.#pageRefs[i], level, 0, 0, 1, 1, pixels, i * 4, 4);
    const upperMips: number[] = [];
    while (width > 1 || height > 1) {
      const reduced = reduceFinalPixels(pixels, width, height);
      width = reduced.width;
      height = reduced.height;
      pixels = reduced.data;
      upperMips.push(this.store.addImage(pixels, width, height));
    }
    this.#sealed = new CookedMap(
      this.store,
      this.manifest,
      this.#pageRefs,
      Uint32Array.from(upperMips),
    );
    if (this.store.isSeedFork) this.store.freezeForDisplay();
    return this.#sealed;
  }
}
