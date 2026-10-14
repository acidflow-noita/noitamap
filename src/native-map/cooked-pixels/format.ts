/** All IDs are local to a shared store (or its compact exported snapshot). */
export type PixelNodeId = number;
export type PageId = number;
export type ImageId = number;
export type RGBA = readonly [number, number, number, number];
export type PixelBytes = Uint8Array | Uint8ClampedArray;

export type PixelNode =
  | { readonly kind: "solid"; readonly color: number }
  | {
      readonly kind: "literal";
      readonly side: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "palette";
      readonly side: number;
      readonly colors: Uint32Array;
      readonly bits: 1 | 2 | 4 | 8;
      readonly indices: Uint8Array;
    }
  | {
      readonly kind: "branch";
      readonly side: number;
      /** Top left, top right, bottom left, bottom right. */
      readonly children: readonly [
        PixelNodeId,
        PixelNodeId,
        PixelNodeId,
        PixelNodeId,
      ];
    };

export interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly root: PixelNodeId;
}

/** Internal read interface. Implementations never expose their owned byte arrays. */
export interface PixelSource {
  readonly pageSize: number;
  readonly leafSize: number;
  node(id: PixelNodeId): PixelNode;
  page(id: PageId): readonly PixelNodeId[];
  image(id: ImageId): PixelImage;
}

/** Structured-clone/IndexedDB format, not a JSON encoding of typed arrays. */
export interface PixelStoreSnapshot {
  readonly format: "noitamap-final-pixels";
  readonly version: 1;
  readonly pageSize: number;
  readonly leafSize: number;
  /** One-based IDs; branch children precede parents, so cycles are impossible. */
  readonly nodes: readonly PixelNode[];
  readonly pages: readonly (readonly PixelNodeId[])[];
  readonly images: readonly PixelImage[];
}

export interface PixelSelectionSnapshot {
  readonly store: PixelStoreSnapshot;
  /** Remapped IDs in the same order as the requested selections, including duplicates. */
  readonly pageRefs: Uint32Array;
  readonly imageRefs: Uint32Array;
}

export function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be a positive safe integer`);
}

export function powerOfTwo(value: number, label: string): void {
  positiveInteger(value, label);
  // Keep dimensions and row offsets within the typed-array address space.
  if (!Number.isInteger(Math.log2(value)) || value > 32768)
    throw new RangeError(
      `${label} must be a power of two no greater than 32768`,
    );
}

export function squareSide(width: number, height: number): number {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  const side = 2 ** Math.ceil(Math.log2(Math.max(width, height)));
  powerOfTwo(side, "image side");
  return side;
}

export function validatePixels(
  bytes: PixelBytes,
  width: number,
  height: number,
): void {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (
    !(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray) ||
    bytes.length !== width * height * 4
  )
    throw new RangeError("Expected one complete RGBA byte array");
}

export function packColor(color: RGBA): number {
  if (
    color.length !== 4 ||
    color.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new RangeError("RGBA channels must be integers from 0 through 255");
  return (
    (color[0] | (color[1] << 8) | (color[2] << 16) | (color[3] << 24)) >>> 0
  );
}

export function colorAt(bytes: PixelBytes, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

export function writeColor(
  bytes: PixelBytes,
  offset: number,
  color: number,
): void {
  bytes[offset] = color & 255;
  bytes[offset + 1] = (color >>> 8) & 255;
  bytes[offset + 2] = (color >>> 16) & 255;
  bytes[offset + 3] = color >>> 24;
}

export function checkNodeSide(node: PixelNode, side: number): void {
  if (node.kind !== "solid" && node.side !== side)
    throw new RangeError("Pixel node dimensions do not match the reference");
}

export function checkRect(
  sideX: number,
  sideY: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    width < 0 ||
    height < 0 ||
    x + width > sideX ||
    y + height > sideY
  )
    throw new RangeError("Pixel rectangle is outside the completed image");
}
