import { PixelDecoder } from "./decoder";
import {
  checkNodeSide,
  colorAt,
  packColor,
  powerOfTwo,
  squareSide,
  validatePixels,
  type ImageId,
  type PageId,
  type PixelBytes,
  type PixelImage,
  type PixelNode,
  type PixelNodeId,
  type PixelSource,
  type PixelStoreSnapshot,
  type RGBA,
} from "./format";
import { reduceFinalPixels } from "./mip";
import { exportPixelSelection, restorePixelStore } from "./snapshot";

export type InspectedPixelNode =
  | Exclude<PixelNode, { readonly kind: "solid" }>
  | { readonly kind: "solid"; readonly color: number; readonly rgba: RGBA };

export interface SharedPixelStoreOptions {
  readonly pageSize?: number;
  readonly leafSize?: number;
}

export interface PixelStoreStats {
  readonly nodes: number;
  readonly pages: number;
  readonly images: number;
  readonly solids: number;
  readonly literals: number;
  readonly palettes: number;
  readonly branches: number;
  /** Payload bytes only; excludes JS objects and preparation hash/memo tables. */
  readonly nodePayloadBytes: number;
  readonly pageReferenceBytes: number;
  readonly ownedNodes: number;
  readonly sharedNodes: number;
  readonly ownedPages: number;
  readonly sharedPages: number;
  readonly ownedImages: number;
  readonly sharedImages: number;
  readonly ownedNodePayloadBytes: number;
  readonly sharedNodePayloadBytes: number;
  readonly ownedPageReferenceBytes: number;
  readonly sharedPageReferenceBytes: number;
  /** Retained entries, not a JavaScript heap-byte estimate. */
  readonly ownedInternEntries: number;
}

/** Immutable preparation shared by independent seed stores. No fork is retained. */
export interface PixelStoreBaseline {
  readonly pageSize: number;
  readonly leafSize: number;
  fork(): SharedPixelStore;
  stats(): PixelStoreStats;
  inspectNode(id: PixelNodeId, side: number): InspectedPixelNode;
  exportBlocks(
    blocks: Iterable<PreparedPixelBlock>,
    pageIds?: Iterable<PageId>,
  ): ReturnType<SharedPixelStore["exportBlocks"]>;
}

export interface PreparedPixelBlock {
  readonly root: PixelNodeId;
  readonly side: number;
}

/** A content-interned store of final, immutable RGBA. Nothing here generates terrain.
 * Preparation can append shared nodes while sealed maps retain stable references. */
export class SharedPixelStore {
  readonly pageSize: number;
  readonly leafSize: number;
  readonly isSeedFork: boolean;
  readonly #nodes: PixelNode[] = [];
  readonly #pages: (readonly PixelNodeId[])[] = [];
  readonly #images: PixelImage[] = [];
  readonly #solids = new Map<number, number>();
  readonly #leaves = new Map<string, number[]>();
  readonly #branches = new Map<string, number>();
  readonly #pageRoots = new Map<number, number>();
  readonly #imageRoots = new Map<string, number>();
  readonly #reduced = new Map<number, number>();
  readonly #source: PixelSource;
  readonly #decoder: PixelDecoder;
  readonly #base: SharedPixelStore | undefined;
  readonly #baseNodes: number;
  readonly #basePages: number;
  readonly #baseImages: number;
  #frozen = false;
  #displayFrozen = false;
  #baseline: PixelStoreBaseline | undefined;

  constructor(options: SharedPixelStoreOptions = {}, base?: SharedPixelStore) {
    if (base && (!base.#baseline || base.#base))
      throw new Error(
        "Pixel store forks require an immutable preparation baseline",
      );
    this.#base = base;
    this.isSeedFork = !!base;
    this.#baseNodes = base ? base.#nodes.length : 0;
    this.#basePages = base ? base.#pages.length : 0;
    this.#baseImages = base ? base.#images.length : 0;
    this.pageSize = options.pageSize ?? base?.pageSize ?? 512;
    this.leafSize =
      options.leafSize ?? base?.leafSize ?? Math.min(8, this.pageSize);
    powerOfTwo(this.pageSize, "pageSize");
    powerOfTwo(this.leafSize, "leafSize");
    if (this.leafSize > this.pageSize || this.leafSize > 256)
      throw new RangeError(
        "leafSize must fit the page and be no greater than 256",
      );
    if (
      base &&
      (base.pageSize !== this.pageSize || base.leafSize !== this.leafSize)
    )
      throw new Error("Pixel store fork dimensions differ from its baseline");
    this.#source = Object.freeze({
      pageSize: this.pageSize,
      leafSize: this.leafSize,
      node: (id: number) => this.#node(id),
      page: (id: number) => this.#page(id),
      image: (id: number) => this.#image(id),
    });
    this.#decoder = new PixelDecoder(this.#source);
    Object.freeze(this);
  }

  decoder(): PixelDecoder {
    return this.#decoder;
  }

  /** Seal the one-time preparation. A baseline has no references to its forks. */
  freezePreparation(): PixelStoreBaseline {
    if (this.#displayFrozen)
      throw new Error("Display pixels cannot become a preparation baseline");
    if (this.#base)
      throw new Error("A seed fork cannot become a preparation baseline");
    if (this.#baseline) return this.#baseline;
    this.#frozen = true;
    this.#baseline = Object.freeze({
      pageSize: this.pageSize,
      leafSize: this.leafSize,
      fork: () =>
        new SharedPixelStore(
          { pageSize: this.pageSize, leafSize: this.leafSize },
          this,
        ),
      stats: () => this.stats(),
      inspectNode: (id: PixelNodeId, side: number) =>
        this.inspectNode(id, side),
      exportBlocks: (
        blocks: Iterable<PreparedPixelBlock>,
        pageIds?: Iterable<PageId>,
      ) => this.exportBlocks(blocks, pageIds),
    });
    return this.#baseline;
  }

  /** Final payload and references survive; preparation-only lookup indexes do not.
   * A prepared baseline must keep its indexes for future independent forks. */
  freezeForDisplay(): void {
    if (this.#baseline)
      throw new Error(
        "A preparation baseline cannot discard its shared indexes",
      );
    if (this.#displayFrozen) return;
    this.#displayFrozen = true;
    this.#frozen = true;
    this.#solids.clear();
    this.#leaves.clear();
    this.#branches.clear();
    this.#pageRoots.clear();
    this.#imageRoots.clear();
    this.#reduced.clear();
  }

  /** Arbitrary prepared square roots use the snapshot's image table. No page or
   * mip is manufactured, and exporting does not mutate a frozen baseline. */
  exportBlocks(
    blocks: Iterable<PreparedPixelBlock>,
    pageIds: Iterable<PageId> = [],
  ) {
    const images: PixelImage[] = [],
      ids: number[] = [],
      found = new Map<string, number>();
    for (const { root, side } of blocks) {
      powerOfTwo(side, "prepared block side");
      checkNodeSide(this.#node(root), side);
      const key = `${root}/${side}`;
      let id = found.get(key);
      if (id === undefined) {
        id = images.push(Object.freeze({ root, width: side, height: side }));
        found.set(key, id);
      }
      ids.push(id);
    }
    return exportPixelSelection(
      {
        ...this.#source,
        image: (id) => this.#entry(images, id, "prepared block"),
      },
      pageIds,
      ids,
    );
  }

  /** Resolve an exported prepared fragment after fromSnapshot(), without decoding. */
  imageBlock(id: ImageId): PreparedPixelBlock {
    const image = this.#image(id);
    if (image.width !== image.height)
      throw new Error("Prepared block image must be square");
    powerOfTwo(image.width, "prepared block side");
    return Object.freeze({ root: image.root, side: image.width });
  }

  /** Detached inspection data: mutating a returned payload cannot change a map. */
  inspectNode(id: PixelNodeId, side: number): InspectedPixelNode {
    powerOfTwo(side, "block side");
    const node = this.#node(id);
    checkNodeSide(node, side);
    if (node.kind === "solid")
      return Object.freeze({
        ...node,
        rgba: Object.freeze([
          node.color & 255,
          (node.color >>> 8) & 255,
          (node.color >>> 16) & 255,
          node.color >>> 24,
        ]) as RGBA,
      });
    if (node.kind === "literal")
      return Object.freeze({ ...node, bytes: new Uint8Array(node.bytes) });
    if (node.kind === "palette")
      return Object.freeze({
        ...node,
        colors: new Uint32Array(node.colors),
        indices: new Uint8Array(node.indices),
      });
    return node;
  }

  readBlock(
    id: PixelNodeId,
    side: number,
    x = 0,
    y = 0,
    width = side,
    height = side,
  ): Uint8ClampedArray {
    return this.#decoder.readBlock(id, side, x, y, width, height);
  }

  /** Restore validated finished bytes and rebuild only the interning indexes. */
  static fromSnapshot(input: PixelStoreSnapshot): SharedPixelStore {
    const checked = restorePixelStore(input);
    const snapshot = checked.copySnapshot();
    const store = new SharedPixelStore({
      pageSize: snapshot.pageSize,
      leafSize: snapshot.leafSize,
    });
    for (const node of snapshot.nodes) {
      const id = store.#append(node);
      if (node.kind === "solid") store.#solids.set(node.color, id);
      else if (node.kind === "branch")
        store.#branches.set(`${node.side}/${node.children.join(",")}`, id);
      else {
        const bytes = store.readBlock(id, node.side),
          key = `${node.side}/${hashBytes(bytes)}`;
        const bucket = store.#leaves.get(key);
        if (bucket) bucket.push(id);
        else store.#leaves.set(key, [id]);
      }
    }
    for (const roots of snapshot.pages) {
      const id = store.#pages.push(roots);
      store.#pageRoots.set(roots[0], id);
      for (let i = 0; i + 1 < roots.length; i++)
        store.#reduced.set(roots[i], roots[i + 1]);
    }
    for (const image of snapshot.images) {
      const id = store.#images.push(image);
      store.#imageRoots.set(`${image.width}/${image.height}/${image.root}`, id);
    }
    return store;
  }

  readRect(
    id: PageId,
    level: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    return this.#decoder.readRect(id, level, x, y, width, height);
  }

  addPage(rgba: PixelBytes): PageId {
    return this.commitPage(this.addBlock(rgba, this.pageSize));
  }

  /** Includes all local mips without allocating a dense native page. */
  solidPage(rgba: RGBA): PageId {
    return this.commitPage(this.solidBlock(rgba));
  }

  solidBlock(rgba: RGBA): PixelNodeId {
    this.#assertMutable();
    return this.#solid(packColor(rgba));
  }

  /** Prepare a reusable, finished square fragment. Input bytes are copied. */
  addBlock(rgba: PixelBytes, side: number): PixelNodeId {
    this.#assertMutable();
    powerOfTwo(side, "block side");
    validatePixels(rgba, side, side);
    return this.#square(rgba, side, 0, 0, side);
  }

  /** Concatenates four final fragments; performs no blending or terrain decisions. */
  joinBlocks(
    side: number,
    children: readonly [PixelNodeId, PixelNodeId, PixelNodeId, PixelNodeId],
  ): PixelNodeId {
    this.#assertMutable();
    powerOfTwo(side, "block side");
    if (side < 2 || children.length !== 4)
      throw new RangeError("Expected four half-size child blocks");
    children.forEach((id) => checkNodeSide(this.#node(id), side / 2));
    const first = this.#node(children[0]);
    if (first.kind === "solid" && children.every((id) => id === children[0]))
      return children[0];
    if (side <= this.leafSize) {
      // Canonicalize small composed blocks to the same leaf as addBlock(bytes).
      const bytes = new Uint8Array(side * side * 4),
        half = side / 2;
      for (let q = 0; q < 4; q++) {
        const child = this.#decoder.readBlock(
          children[q],
          half,
          0,
          0,
          half,
          half,
        );
        for (let row = 0; row < half; row++)
          bytes.set(
            child.subarray(row * half * 4, (row + 1) * half * 4),
            (((q >> 1) * half + row) * side + (q & 1) * half) * 4,
          );
      }
      return this.#leaf(bytes, side);
    }
    const key = `${side}/${children.join(",")}`;
    const found =
      this.#branches.get(key) ??
      (this.#base ? this.#base.#branches.get(key) : undefined);
    if (found !== undefined) return found;
    const id = this.#append(
      Object.freeze({
        kind: "branch",
        side,
        children: Object.freeze([...children]) as unknown as readonly [
          number,
          number,
          number,
          number,
        ],
      }),
    );
    this.#branches.set(key, id);
    return id;
  }

  /** Publish a page only after every exact mip root exists. */
  commitPage(root: PixelNodeId): PageId {
    this.#assertMutable();
    checkNodeSide(this.#node(root), this.pageSize);
    const found =
      this.#pageRoots.get(root) ??
      (this.#base ? this.#base.#pageRoots.get(root) : undefined);
    if (found !== undefined) return found;
    const roots = [root];
    for (let side = this.pageSize; side > 1; side /= 2)
      roots.push(this.#reduce(roots[roots.length - 1], side));
    if (this.#basePages + this.#pages.length >= 0xffffffff)
      throw new RangeError("Page ID capacity exceeded");
    const id = this.#basePages + this.#pages.push(Object.freeze(roots));
    this.#pageRoots.set(root, id);
    return id;
  }

  /** Store an already-reduced rectangular image, e.g. a completed global mip.
   * Padding is final transparent RGBA and is hidden by the retained dimensions. */
  addImage(rgba: PixelBytes, width: number, height: number): ImageId {
    this.#assertMutable();
    validatePixels(rgba, width, height);
    const side = squareSide(width, height);
    let root: number;
    if (width === side && height === side) root = this.addBlock(rgba, side);
    else {
      const padded = new Uint8Array(side * side * 4);
      for (let y = 0; y < height; y++)
        padded.set(
          rgba.subarray(y * width * 4, (y + 1) * width * 4),
          y * side * 4,
        );
      root = this.addBlock(padded, side);
    }
    const key = `${width}/${height}/${root}`,
      found =
        this.#imageRoots.get(key) ??
        (this.#base ? this.#base.#imageRoots.get(key) : undefined);
    if (found !== undefined) return found;
    if (this.#baseImages + this.#images.length >= 0xffffffff)
      throw new RangeError("Image ID capacity exceeded");
    const id =
      this.#baseImages +
      this.#images.push(Object.freeze({ width, height, root }));
    this.#imageRoots.set(key, id);
    return id;
  }

  exportSnapshot(pageIds: Iterable<PageId>, imageIds: Iterable<ImageId> = []) {
    return exportPixelSelection(this.#source, pageIds, imageIds);
  }

  stats(): PixelStoreStats {
    let solids = 0,
      literals = 0,
      palettes = 0,
      branches = 0,
      nodePayloadBytes = 0;
    for (const node of this.#nodes) {
      if (node.kind === "solid") {
        solids++;
        nodePayloadBytes += 4;
      } else if (node.kind === "literal") {
        literals++;
        nodePayloadBytes += node.bytes.byteLength;
      } else if (node.kind === "palette") {
        palettes++;
        nodePayloadBytes += node.colors.byteLength + node.indices.byteLength;
      } else {
        branches++;
        nodePayloadBytes += 16;
      }
    }
    const shared = this.#base?.stats();
    const ownedPageReferenceBytes =
      this.#pages.length * (Math.log2(this.pageSize) + 1) * 4;
    return Object.freeze({
      nodes: this.#baseNodes + this.#nodes.length,
      pages: this.#basePages + this.#pages.length,
      images: this.#baseImages + this.#images.length,
      solids: solids + (shared?.solids ?? 0),
      literals: literals + (shared?.literals ?? 0),
      palettes: palettes + (shared?.palettes ?? 0),
      branches: branches + (shared?.branches ?? 0),
      nodePayloadBytes: nodePayloadBytes + (shared?.nodePayloadBytes ?? 0),
      pageReferenceBytes:
        ownedPageReferenceBytes + (shared?.pageReferenceBytes ?? 0),
      ownedNodes: this.#nodes.length,
      sharedNodes: this.#baseNodes,
      ownedPages: this.#pages.length,
      sharedPages: this.#basePages,
      ownedImages: this.#images.length,
      sharedImages: this.#baseImages,
      ownedNodePayloadBytes: nodePayloadBytes,
      sharedNodePayloadBytes: shared?.nodePayloadBytes ?? 0,
      ownedPageReferenceBytes,
      sharedPageReferenceBytes: shared?.pageReferenceBytes ?? 0,
      ownedInternEntries:
        this.#solids.size +
        [...this.#leaves.values()].reduce((n, ids) => n + ids.length, 0) +
        this.#branches.size +
        this.#pageRoots.size +
        this.#imageRoots.size +
        this.#reduced.size,
    });
  }

  #entry<T>(table: readonly T[], id: number, kind: string): T {
    if (!Number.isInteger(id) || id < 1 || id > table.length)
      throw new RangeError(`Missing final-pixel ${kind} reference`);
    return table[id - 1];
  }

  #node(id: number): PixelNode {
    if (this.#base && id <= this.#baseNodes) return this.#base.#node(id);
    return this.#entry(this.#nodes, id - this.#baseNodes, "node");
  }

  #page(id: number): readonly PixelNodeId[] {
    if (this.#base && id <= this.#basePages) return this.#base.#page(id);
    return this.#entry(this.#pages, id - this.#basePages, "page");
  }

  #image(id: number): PixelImage {
    if (this.#base && id <= this.#baseImages) return this.#base.#image(id);
    return this.#entry(this.#images, id - this.#baseImages, "image");
  }

  #assertMutable(): void {
    if (this.#displayFrozen)
      throw new Error("Completed display pixels are immutable");
    if (this.#frozen)
      throw new Error(
        "Preparation baseline is immutable; fork it before cooking a seed",
      );
  }

  #append(node: PixelNode): number {
    this.#assertMutable();
    if (this.#baseNodes + this.#nodes.length >= 0xffffffff)
      throw new RangeError("Pixel node ID capacity exceeded");
    return this.#baseNodes + this.#nodes.push(node);
  }

  #solid(color: number): number {
    const found =
      this.#solids.get(color) ??
      (this.#base ? this.#base.#solids.get(color) : undefined);
    if (found !== undefined) return found;
    const id = this.#append(Object.freeze({ kind: "solid", color }));
    this.#solids.set(color, id);
    return id;
  }

  #square(
    bytes: PixelBytes,
    stride: number,
    x: number,
    y: number,
    side: number,
  ): number {
    if (side <= this.leafSize) {
      const leaf = new Uint8Array(side * side * 4);
      for (let row = 0; row < side; row++) {
        const start = ((y + row) * stride + x) * 4;
        leaf.set(bytes.subarray(start, start + side * 4), row * side * 4);
      }
      return this.#leaf(leaf, side);
    }
    const half = side / 2;
    return this.joinBlocks(side, [
      this.#square(bytes, stride, x, y, half),
      this.#square(bytes, stride, x + half, y, half),
      this.#square(bytes, stride, x, y + half, half),
      this.#square(bytes, stride, x + half, y + half, half),
    ]);
  }

  #leaf(bytes: Uint8Array, side: number): number {
    const first = colorAt(bytes, 0);
    let solid = true;
    for (let i = 4; i < bytes.length; i += 4)
      if (colorAt(bytes, i) !== first) {
        solid = false;
        break;
      }
    if (solid) return this.#solid(first);
    const key = `${side}/${hashBytes(bytes)}`,
      bucket = this.#leaves.get(key),
      sharedBucket = this.#base ? this.#base.#leaves.get(key) : undefined;
    for (const candidates of [bucket, sharedBucket])
      if (candidates)
        for (const id of candidates) {
          const node = this.#node(id);
          let same = true;
          if (node.kind === "literal") {
            for (let i = 0; i < bytes.length; i++)
              if (node.bytes[i] !== bytes[i]) {
                same = false;
                break;
              }
          } else if (node.kind === "palette") {
            for (let i = 0; i < side * side; i++) {
              const bit = i * node.bits,
                index =
                  (node.indices[bit >> 3] >>> (bit & 7)) &
                  ((1 << node.bits) - 1);
              if (node.colors[index] !== colorAt(bytes, i * 4)) {
                same = false;
                break;
              }
            }
          } else throw new Error("Invalid prepared leaf bucket");
          if (same) return id;
        }
    const colorIds = new Map<number, number>(),
      colors: number[] = [],
      indices = new Uint8Array(side * side);
    for (let i = 0; i < side * side; i++) {
      const color = colorAt(bytes, i * 4);
      let index = colorIds.get(color);
      if (index === undefined) {
        index = colors.length;
        colors.push(color);
        colorIds.set(color, index);
      }
      if (colors.length > 256) break;
      indices[i] = index;
    }
    const bits =
      colors.length <= 2
        ? 1
        : colors.length <= 4
          ? 2
          : colors.length <= 16
            ? 4
            : 8;
    const packedLength = Math.ceil((side * side * bits) / 8);
    let node: PixelNode;
    if (
      colors.length <= 256 &&
      colors.length * 4 + packedLength < bytes.length
    ) {
      const packed = new Uint8Array(packedLength);
      for (let i = 0; i < indices.length; i++)
        packed[(i * bits) >> 3] |= indices[i] << ((i * bits) & 7);
      node = Object.freeze({
        kind: "palette",
        side,
        colors: Uint32Array.from(colors),
        bits,
        indices: packed,
      });
    } else node = Object.freeze({ kind: "literal", side, bytes });
    const id = this.#append(node);
    if (bucket) bucket.push(id);
    else this.#leaves.set(key, [id]);
    return id;
  }

  #reduce(id: number, side: number): number {
    const cached =
      this.#reduced.get(id) ??
      (this.#base ? this.#base.#reduced.get(id) : undefined);
    if (cached !== undefined) return cached;
    const node = this.#node(id);
    let reduced: number;
    if (node.kind === "solid") {
      // Native hidden RGB is retained. The reference reducer clears it at alpha 0.
      reduced = node.color >>> 24 ? id : this.#solid(0);
    } else if (node.kind === "branch" && side > 2) {
      reduced = this.joinBlocks(
        side / 2,
        node.children.map((child) => this.#reduce(child, side / 2)) as [
          number,
          number,
          number,
          number,
        ],
      );
    } else {
      const bytes = this.#decoder.readBlock(id, side, 0, 0, side, side);
      const image = reduceFinalPixels(bytes, side, side);
      reduced = this.#square(image.data, image.width, 0, 0, image.width);
    }
    this.#reduced.set(id, reduced);
    return reduced;
  }
}

function hashBytes(bytes: PixelBytes): number {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++)
    hash = Math.imul(hash ^ bytes[i], 16777619) >>> 0;
  return hash;
}
