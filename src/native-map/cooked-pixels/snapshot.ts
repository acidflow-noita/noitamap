import { PixelDecoder } from "./decoder";
import {
  checkNodeSide,
  powerOfTwo,
  squareSide,
  type ImageId,
  type PageId,
  type PixelImage,
  type PixelNode,
  type PixelSelectionSnapshot,
  type PixelSource,
  type PixelStoreSnapshot,
} from "./format";

function cloneNode(node: PixelNode, remap: (id: number) => number): PixelNode {
  switch (node.kind) {
    case "solid":
      return Object.freeze({ kind: "solid", color: node.color });
    case "literal":
      return Object.freeze({
        kind: "literal",
        side: node.side,
        bytes: new Uint8Array(node.bytes),
      });
    case "palette":
      return Object.freeze({
        kind: "palette",
        side: node.side,
        colors: new Uint32Array(node.colors),
        bits: node.bits,
        indices: new Uint8Array(node.indices),
      });
    case "branch":
      return Object.freeze({
        kind: "branch",
        side: node.side,
        children: Object.freeze(
          node.children.map(remap),
        ) as unknown as readonly [number, number, number, number],
      });
  }
}

/** Copies only the reachable DAG. Returned buffers never alias the source store. */
export function exportPixelSelection(
  source: PixelSource,
  pageIds: Iterable<PageId>,
  imageIds: Iterable<ImageId> = [],
): PixelSelectionSnapshot {
  const nodes: PixelNode[] = [],
    pages: (readonly number[])[] = [],
    images: PixelImage[] = [];
  const nodeMap = new Map<number, number>(),
    pageMap = new Map<number, number>(),
    imageMap = new Map<number, number>();
  const visit = (id: number): number => {
    const existing = nodeMap.get(id);
    if (existing !== undefined) return existing;
    const copy = cloneNode(source.node(id), visit);
    const mapped = nodes.push(copy);
    nodeMap.set(id, mapped);
    return mapped;
  };
  const pageRefs = Uint32Array.from(pageIds, (id) => {
    let mapped = pageMap.get(id);
    if (mapped === undefined) {
      const roots = source.page(id);
      if (roots.length !== Math.log2(source.pageSize) + 1)
        throw new Error("Incomplete final page mip references");
      mapped = pages.push(Object.freeze(roots.map(visit)));
      pageMap.set(id, mapped);
    }
    return mapped;
  });
  const imageRefs = Uint32Array.from(imageIds, (id) => {
    let mapped = imageMap.get(id);
    if (mapped === undefined) {
      const image = source.image(id);
      mapped = images.push(
        Object.freeze({
          width: image.width,
          height: image.height,
          root: visit(image.root),
        }),
      );
      imageMap.set(id, mapped);
    }
    return mapped;
  });
  return Object.freeze({
    store: Object.freeze({
      format: "noitamap-final-pixels",
      version: 1,
      pageSize: source.pageSize,
      leafSize: source.leafSize,
      nodes: Object.freeze(nodes),
      pages: Object.freeze(pages),
      images: Object.freeze(images),
    }),
    pageRefs,
    imageRefs,
  });
}

export interface RestoredPixelStore {
  readonly decoder: PixelDecoder;
  /** Detached validated tables in original ID order, without traversal remapping. */
  copySnapshot(): PixelStoreSnapshot;
  exportSnapshot(
    pageIds: Iterable<PageId>,
    imageIds?: Iterable<ImageId>,
  ): PixelSelectionSnapshot;
}

/** Validate every shape, reference and payload before a decoder can read it.
 * This checks a complete byte representation, not authenticity against game output.
 * No terrain, seed, compositor, encoder or mip reducer is imported on this path. */
export function restorePixelStore(
  input: PixelStoreSnapshot,
): RestoredPixelStore {
  const fail = (message: string): never => {
    throw new Error(`Invalid final-pixel snapshot: ${message}`);
  };
  if (!input || input.format !== "noitamap-final-pixels" || input.version !== 1)
    fail("format/version");
  powerOfTwo(input.pageSize, "snapshot pageSize");
  powerOfTwo(input.leafSize, "snapshot leafSize");
  if (input.leafSize > input.pageSize || input.leafSize > 256)
    fail("leaf size");
  if (
    !Array.isArray(input.nodes) ||
    !Array.isArray(input.pages) ||
    !Array.isArray(input.images)
  )
    fail("tables");
  if (
    [input.nodes.length, input.pages.length, input.images.length].some(
      (n) => n >= 0xffffffff,
    )
  )
    fail("ID capacity");
  const nodes: PixelNode[] = [];
  const getNode = (id: number): PixelNode => {
    if (!Number.isInteger(id) || id < 1 || id > nodes.length)
      fail("missing or forward node reference");
    return nodes[id - 1];
  };
  for (const node of input.nodes) {
    if (!node || !["solid", "literal", "palette", "branch"].includes(node.kind))
      fail("node kind");
    if (node.kind === "solid") {
      if (
        !Number.isInteger(node.color) ||
        node.color < 0 ||
        node.color > 0xffffffff
      )
        fail("solid color");
    } else {
      powerOfTwo(node.side, "node side");
      if (node.kind === "branch") {
        if (
          node.side <= input.leafSize ||
          !Array.isArray(node.children) ||
          node.children.length !== 4
        )
          fail("branch shape");
        for (const child of node.children)
          checkNodeSide(getNode(child), node.side / 2);
      } else {
        if (node.side > input.leafSize) fail("leaf dimensions");
        if (node.kind === "literal") {
          if (
            !(node.bytes instanceof Uint8Array) ||
            node.bytes.length !== node.side * node.side * 4
          )
            fail("literal bytes");
        } else {
          if (
            !(node.colors instanceof Uint32Array) ||
            !(node.indices instanceof Uint8Array) ||
            ![1, 2, 4, 8].includes(node.bits)
          )
            fail("palette payload");
          const count = node.colors.length;
          if (
            count < 2 ||
            count > 2 ** node.bits ||
            new Set(node.colors).size !== count
          )
            fail("palette colors");
          if (
            node.indices.length !==
            Math.ceil((node.side * node.side * node.bits) / 8)
          )
            fail("palette indices");
          for (let i = 0; i < node.side * node.side; i++) {
            const bit = i * node.bits,
              index =
                (node.indices[bit >> 3] >>> (bit & 7)) & ((1 << node.bits) - 1);
            if (index >= count) fail("palette index out of bounds");
          }
        }
      }
    }
    nodes.push(cloneNode(node, (id) => id));
  }
  const pages = input.pages.map((roots) => {
    if (!Array.isArray(roots) || roots.length !== Math.log2(input.pageSize) + 1)
      fail("incomplete page mip references");
    roots.forEach((root, level) =>
      checkNodeSide(getNode(root), input.pageSize / 2 ** level),
    );
    return Object.freeze([...roots]);
  });
  const images = input.images.map((image) => {
    if (!image) fail("image record");
    checkNodeSide(getNode(image.root), squareSide(image.width, image.height));
    return Object.freeze({
      width: image.width,
      height: image.height,
      root: image.root,
    });
  });
  const reached = new Set<number>();
  const visit = (id: number): void => {
    if (reached.has(id)) return;
    reached.add(id);
    const node = getNode(id);
    if (node.kind === "branch") node.children.forEach(visit);
  };
  pages.forEach((roots) => roots.forEach(visit));
  images.forEach((image) => visit(image.root));
  if (reached.size !== nodes.length) fail("unreachable nodes");
  const source: PixelSource = Object.freeze({
    pageSize: input.pageSize,
    leafSize: input.leafSize,
    node: getNode,
    page(id: number) {
      if (!Number.isInteger(id) || id < 1 || id > pages.length)
        fail("missing page reference");
      return pages[id - 1];
    },
    image(id: number) {
      if (!Number.isInteger(id) || id < 1 || id > images.length)
        fail("missing image reference");
      return images[id - 1];
    },
  });
  return Object.freeze({
    decoder: new PixelDecoder(source),
    copySnapshot: (): PixelStoreSnapshot =>
      Object.freeze({
        format: "noitamap-final-pixels",
        version: 1,
        pageSize: source.pageSize,
        leafSize: source.leafSize,
        nodes: Object.freeze(nodes.map((node) => cloneNode(node, (id) => id))),
        pages: Object.freeze(pages.map((roots) => Object.freeze([...roots]))),
        images: Object.freeze(
          images.map((image) => Object.freeze({ ...image })),
        ),
      }),
    exportSnapshot: (pageIds: Iterable<PageId>, imageIds?: Iterable<ImageId>) =>
      exportPixelSelection(source, pageIds, imageIds),
  });
}
