import { type CookedMapSnapshot } from "../cooked-pixels/map-decoder";
import { restorePixelStore } from "../cooked-pixels/snapshot";
import type {
  PixelImage,
  PixelNode,
  PixelStoreSnapshot,
} from "../cooked-pixels/format";
import type { PreparedWorldArtifact } from "../prepared-world/artifact";

export interface PreparedLibraryRecord {
  readonly format: "noitamap-prepared-library";
  readonly version: 1;
  readonly key: string;
  readonly artifact: PreparedWorldArtifact;
}

export interface CompletedMapRecord {
  readonly format: "noitamap-completed-map";
  readonly version: 1;
  readonly key: string;
  readonly libraryKey?: string;
  readonly manifest: CookedMapSnapshot["manifest"];
  readonly pageSize: number;
  readonly leafSize: number;
  /** Negative node refs address the immutable prepared library; positive refs
   * address this record's private nodes. Zero is always invalid. */
  readonly nodes: readonly PixelNode[];
  readonly pages: readonly (readonly number[])[];
  readonly images: readonly PixelImage[];
  readonly pageRefs: Uint32Array;
  readonly upperMipRefs: Uint32Array;
}

function equalBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hash(bytes: ArrayLike<number>): number {
  let value = 2166136261;
  for (let i = 0; i < bytes.length; i++)
    value = Math.imul(value ^ bytes[i], 16777619) >>> 0;
  return value;
}
function key(node: PixelNode): string {
  if (node.kind === "solid") return `s/${node.color}`;
  if (node.kind === "branch")
    return `b/${node.side}/${node.children.join(",")}`;
  if (node.kind === "literal") return `l/${node.side}/${hash(node.bytes)}`;
  return `p/${node.side}/${node.bits}/${hash(node.colors)}/${hash(node.indices)}`;
}
function equal(a: PixelNode, b: PixelNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "solid" && b.kind === "solid") return a.color === b.color;
  if (a.kind === "branch" && b.kind === "branch")
    return a.side === b.side && equalBytes(a.children, b.children);
  if (a.kind === "literal" && b.kind === "literal")
    return a.side === b.side && equalBytes(a.bytes, b.bytes);
  return (
    a.kind === "palette" &&
    b.kind === "palette" &&
    a.side === b.side &&
    a.bits === b.bits &&
    equalBytes(a.colors, b.colors) &&
    equalBytes(a.indices, b.indices)
  );
}
function remapNode(
  node: PixelNode,
  reference: (id: number) => number,
): PixelNode {
  return node.kind === "branch"
    ? {
        ...node,
        children: node.children.map(reference) as [
          number,
          number,
          number,
          number,
        ],
      }
    : node;
}

export function validateLibrary(record: PreparedLibraryRecord): void {
  if (
    !record ||
    record.format !== "noitamap-prepared-library" ||
    record.version !== 1 ||
    !record.key ||
    record.artifact?.format !== "noitamap-prepared-world" ||
    record.artifact.version !== 1 ||
    !record.artifact.recipe?.revision
  )
    throw new Error("Invalid prepared library record");
  restorePixelStore(record.artifact.pixels);
}

/** Share only exact nodes already present in the explicitly prepared library. */
export function encodeMapRecord(
  keyValue: string,
  snapshot: CookedMapSnapshot,
  library?: PreparedLibraryRecord,
): { record: CompletedMapRecord; sharedNodes: number } {
  if (!keyValue) throw new Error("Completed map requires a storage identity");
  const source = snapshot.pixels,
    shared = library?.artifact.pixels;
  if (
    shared &&
    (shared.pageSize !== source.pageSize || shared.leafSize !== source.leafSize)
  )
    throw new Error("Prepared library pixel dimensions differ from the map");
  const dictionary = new Map<string, { id: number; node: PixelNode }[]>();
  shared?.nodes.forEach((node, index) => {
    const value = remapNode(node, (id) => -id),
      lookup = key(value),
      bucket = dictionary.get(lookup) ?? [];
    bucket.push({ id: index + 1, node: value });
    dictionary.set(lookup, bucket);
  });
  const mapped: number[] = [0],
    nodes: PixelNode[] = [];
  let sharedNodes = 0;
  source.nodes.forEach((node) => {
    const value = remapNode(node, (id) => mapped[id]);
    const found = dictionary
      .get(key(value))
      ?.find((candidate) => equal(candidate.node, value));
    if (found) {
      mapped.push(-found.id);
      sharedNodes++;
    } else mapped.push(nodes.push(value));
  });
  return {
    sharedNodes,
    record: {
      format: "noitamap-completed-map",
      version: 1,
      key: keyValue,
      libraryKey: library?.key,
      manifest: snapshot.manifest,
      pageSize: source.pageSize,
      leafSize: source.leafSize,
      nodes,
      pages: source.pages.map((roots) => roots.map((id) => mapped[id])),
      images: source.images.map((image) => ({
        ...image,
        root: mapped[image.root],
      })),
      pageRefs: new Uint32Array(snapshot.pageRefs),
      upperMipRefs: new Uint32Array(snapshot.upperMipRefs),
    },
  };
}

/** Reconstitute the validated byte graph; never evaluate a recipe or regenerate. */
export function decodeMapRecord(
  record: CompletedMapRecord,
  library?: PreparedLibraryRecord,
): CookedMapSnapshot {
  if (
    !record ||
    record.format !== "noitamap-completed-map" ||
    record.version !== 1 ||
    !record.key ||
    !Array.isArray(record.nodes) ||
    !Array.isArray(record.pages) ||
    !Array.isArray(record.images)
  )
    throw new Error("Invalid completed map record");
  if (record.libraryKey !== library?.key)
    throw new Error("Missing or mismatched prepared library");
  if (library) validateLibrary(library);
  const shared = library?.artifact.pixels;
  if (
    shared &&
    (shared.pageSize !== record.pageSize || shared.leafSize !== record.leafSize)
  )
    throw new Error("Stored library pixel dimensions differ from the map");
  const sharedNodes = shared?.nodes.length ?? 0,
    sharedPages = shared?.pages.length ?? 0,
    sharedImages = shared?.images.length ?? 0;
  const reference = (id: number, before = record.nodes.length + 1): number => {
    if (
      !Number.isSafeInteger(id) ||
      id === 0 ||
      (id < 0 ? -id > sharedNodes : id >= before)
    )
      throw new Error("Invalid stored pixel node reference");
    return id < 0 ? -id : sharedNodes + id;
  };
  const pixels: PixelStoreSnapshot = {
    format: "noitamap-final-pixels",
    version: 1,
    pageSize: record.pageSize,
    leafSize: record.leafSize,
    nodes: [
      ...(shared?.nodes ?? []),
      ...record.nodes.map((node, index) =>
        remapNode(node, (id) => reference(id, index + 1)),
      ),
    ],
    pages: [
      ...(shared?.pages ?? []),
      ...record.pages.map((roots: readonly number[]) =>
        roots.map((id: number) => reference(id)),
      ),
    ],
    images: [
      ...(shared?.images ?? []),
      ...record.images.map((image) => ({
        ...image,
        root: reference(image.root),
      })),
    ],
  };
  if (
    !(record.pageRefs instanceof Uint32Array) ||
    !(record.upperMipRefs instanceof Uint32Array)
  )
    throw new Error("Invalid completed map reference tables");
  const remapRefs = (refs: Uint32Array, count: number, offset: number) =>
    Uint32Array.from(refs, (id) => {
      if (!id || id > count || id + offset > 0xffffffff)
        throw new Error("Missing completed map reference");
      return id + offset;
    });
  return {
    format: "noitamap-cooked-map",
    version: 1,
    manifest: record.manifest,
    pixels,
    pageRefs: remapRefs(record.pageRefs, record.pages.length, sharedPages),
    upperMipRefs: remapRefs(
      record.upperMipRefs,
      record.images.length,
      sharedImages,
    ),
  };
}
