import { PixelDecoder } from "./decoder";
import { checkRect, type PageId, type PixelStoreSnapshot } from "./format";
import {
  mapLayout,
  pageIndex,
  type CookedMapManifest,
  type MapLayout,
  type RegionCoordinate,
} from "./manifest";
import type { SharedPixelStore } from "./store";

export interface CookedMapSnapshot {
  readonly format: "noitamap-cooked-map";
  readonly version: 1;
  readonly manifest: CookedMapManifest;
  readonly pixels: PixelStoreSnapshot;
  /** Global row-major native pages; no missing-page sentinel is permitted. */
  readonly pageRefs: Uint32Array;
  /** All map levels above the page's 1x1 level, in increasing reduction order. */
  readonly upperMipRefs: Uint32Array;
}

/** A validated complete map. View operations only copy committed final pixels. */
export class CookedMap {
  readonly ready = true;
  readonly manifest: CookedMapManifest;
  readonly width: number;
  readonly height: number;
  readonly maxLevel: number;
  readonly pageCount: number;
  readonly pageReferenceBytes: number;
  readonly mipReferenceBytes: number;
  readonly pixels: PixelDecoder;
  readonly store: SharedPixelStore;
  readonly #layout: MapLayout;
  readonly #pageRefs: Uint32Array;
  readonly #upperMipRefs: Uint32Array;

  /** Used by preparation and validated restore. All references are checked here. */
  constructor(
    store: SharedPixelStore,
    manifest: CookedMapManifest,
    pageRefs: Uint32Array,
    upperMipRefs: Uint32Array,
  ) {
    const layout = mapLayout(manifest),
      decoder = store.decoder();
    if (decoder.pageSize !== layout.manifest.pageSize)
      throw new Error("Cooked-map/store page size mismatch");
    if (
      !(pageRefs instanceof Uint32Array) ||
      pageRefs.length !== layout.pageCount
    )
      throw new Error("Incomplete cooked-map page references");
    if (
      !(upperMipRefs instanceof Uint32Array) ||
      upperMipRefs.length !== layout.maxLevel - decoder.maxPageLevel
    )
      throw new Error("Incomplete cooked-map upper mip references");
    for (const id of new Set(pageRefs)) decoder.assertPage(id);
    for (let i = 0; i < upperMipRefs.length; i++) {
      const level = decoder.maxPageLevel + i + 1,
        image = decoder.imageSize(upperMipRefs[i]);
      if (
        image.width !== Math.ceil(layout.width / 2 ** level) ||
        image.height !== Math.ceil(layout.height / 2 ** level)
      )
        throw new Error(
          "Cooked-map upper mip dimensions do not match the manifest",
        );
    }
    this.store = store;
    this.pixels = decoder;
    this.#layout = layout;
    this.manifest = layout.manifest;
    this.width = layout.width;
    this.height = layout.height;
    this.maxLevel = layout.maxLevel;
    this.pageCount = layout.pageCount;
    this.#pageRefs = new Uint32Array(pageRefs);
    this.#upperMipRefs = new Uint32Array(upperMipRefs);
    this.pageReferenceBytes = this.#pageRefs.byteLength;
    this.mipReferenceBytes = this.#upperMipRefs.byteLength;
    Object.freeze(this);
  }

  page(region: RegionCoordinate, x: number, y: number): PageId {
    return this.#pageRefs[pageIndex(this.#layout, region, x, y)];
  }

  levelSize(level: number): { width: number; height: number } {
    if (!Number.isInteger(level) || level < 0 || level > this.maxLevel)
      throw new RangeError("Invalid cooked-map mip level");
    return {
      width: Math.ceil(this.width / 2 ** level),
      height: Math.ceil(this.height / 2 ** level),
    };
  }

  /** x/y are pixels within this level, relative to the manifest's global origin. */
  readRect(
    level: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    const size = this.levelSize(level);
    checkRect(size.width, size.height, x, y, width, height);
    if (level > this.pixels.maxPageLevel)
      return this.pixels.readImageRect(
        this.#upperMipRefs[level - this.pixels.maxPageLevel - 1],
        x,
        y,
        width,
        height,
      );
    const out = new Uint8ClampedArray(width * height * 4);
    if (width === 0 || height === 0) return out;
    const side = this.manifest.pageSize / 2 ** level;
    for (
      let py = Math.floor(y / side);
      py <= Math.floor((y + height - 1) / side);
      py++
    )
      for (
        let px = Math.floor(x / side);
        px <= Math.floor((x + width - 1) / side);
        px++
      ) {
        const left = px * side,
          top = py * side;
        const x0 = Math.max(x, left),
          x1 = Math.min(x + width, left + side);
        const y0 = Math.max(y, top),
          y1 = Math.min(y + height, top + side);
        this.pixels.copyRect(
          this.#pageRefs[py * this.#layout.pageColumns + px],
          level,
          x0 - left,
          y0 - top,
          x1 - x0,
          y1 - y0,
          out,
          ((y0 - y) * width + x0 - x) * 4,
          width * 4,
        );
      }
    return out;
  }

  exportSnapshot(): CookedMapSnapshot {
    const selection = this.store.exportSnapshot(
      this.#pageRefs,
      this.#upperMipRefs,
    );
    return Object.freeze({
      format: "noitamap-cooked-map",
      version: 1,
      manifest: this.manifest,
      pixels: selection.store,
      pageRefs: selection.pageRefs,
      upperMipRefs: selection.imageRefs,
    });
  }
}
