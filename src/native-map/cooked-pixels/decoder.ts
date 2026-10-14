import {
  checkNodeSide,
  checkRect,
  powerOfTwo,
  squareSide,
  writeColor,
  type ImageId,
  type PageId,
  type PixelBytes,
  type PixelNodeId,
  type PixelSource,
} from "./format";

/** Byte lookup/copy only. No preparation, persistence, reduction, or terrain imports. */
export class PixelDecoder {
  readonly pageSize: number;
  readonly maxPageLevel: number;
  readonly #source: PixelSource;

  constructor(source: PixelSource) {
    powerOfTwo(source.pageSize, "pageSize");
    this.#source = source;
    this.pageSize = source.pageSize;
    this.maxPageLevel = Math.log2(source.pageSize);
    Object.freeze(this);
  }

  pageRoot(id: PageId, level = 0): PixelNodeId {
    if (!Number.isInteger(level) || level < 0 || level > this.maxPageLevel)
      throw new RangeError("Invalid page mip level");
    const roots = this.#source.page(id);
    if (roots.length !== this.maxPageLevel + 1)
      throw new Error("Incomplete final page mip references");
    const root = roots[level];
    checkNodeSide(this.#source.node(root), this.pageSize / 2 ** level);
    return root;
  }

  /** Check every mip reference, not just the native root. */
  assertPage(id: PageId): void {
    for (let level = 0; level <= this.maxPageLevel; level++)
      this.pageRoot(id, level);
  }

  imageSize(id: ImageId): { width: number; height: number } {
    const { width, height, root } = this.#source.image(id);
    checkNodeSide(this.#source.node(root), squareSide(width, height));
    return { width, height };
  }

  readRect(
    id: PageId,
    level: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    const root = this.pageRoot(id, level),
      side = this.pageSize / 2 ** level;
    return this.readBlock(root, side, x, y, width, height);
  }

  readBlock(
    root: PixelNodeId,
    side: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    powerOfTwo(side, "block side");
    checkNodeSide(this.#source.node(root), side);
    checkRect(side, side, x, y, width, height);
    const out = new Uint8ClampedArray(width * height * 4);
    this.#copyNode(root, side, x, y, width, height, out, 0, width * 4);
    return out;
  }

  copyRect(
    id: PageId,
    level: number,
    x: number,
    y: number,
    width: number,
    height: number,
    out: PixelBytes,
    offset = 0,
    stride = width * 4,
  ): void {
    const root = this.pageRoot(id, level),
      side = this.pageSize / 2 ** level;
    checkRect(side, side, x, y, width, height);
    this.#checkTarget(out, offset, stride, width, height);
    this.#copyNode(root, side, x, y, width, height, out, offset, stride);
  }

  readImageRect(
    id: ImageId,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    const image = this.#source.image(id);
    checkRect(image.width, image.height, x, y, width, height);
    const out = new Uint8ClampedArray(width * height * 4);
    this.#copyNode(
      image.root,
      squareSide(image.width, image.height),
      x,
      y,
      width,
      height,
      out,
      0,
      width * 4,
    );
    return out;
  }

  #checkTarget(
    out: PixelBytes,
    offset: number,
    stride: number,
    width: number,
    height: number,
  ): void {
    if (
      !(out instanceof Uint8Array || out instanceof Uint8ClampedArray) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(stride) ||
      offset < 0 ||
      stride < width * 4 ||
      (height > 0 && offset + (height - 1) * stride + width * 4 > out.length)
    )
      throw new RangeError("Invalid pixel copy target");
  }

  #copyNode(
    id: PixelNodeId,
    side: number,
    x: number,
    y: number,
    width: number,
    height: number,
    out: PixelBytes,
    offset: number,
    stride: number,
  ): void {
    if (width === 0 || height === 0) return;
    const node = this.#source.node(id);
    if (node.kind === "branch") {
      const half = side / 2;
      for (let q = 0; q < 4; q++) {
        const left = (q & 1) * half,
          top = (q >> 1) * half;
        const x0 = Math.max(x, left),
          y0 = Math.max(y, top);
        const x1 = Math.min(x + width, left + half),
          y1 = Math.min(y + height, top + half);
        if (x1 > x0 && y1 > y0)
          this.#copyNode(
            node.children[q],
            half,
            x0 - left,
            y0 - top,
            x1 - x0,
            y1 - y0,
            out,
            offset + (y0 - y) * stride + (x0 - x) * 4,
            stride,
          );
      }
    } else if (node.kind === "literal") {
      for (let row = 0; row < height; row++) {
        const start = ((y + row) * side + x) * 4;
        out.set(
          node.bytes.subarray(start, start + width * 4),
          offset + row * stride,
        );
      }
    } else {
      for (let row = 0; row < height; row++)
        for (let col = 0; col < width; col++) {
          let color: number;
          if (node.kind === "solid") color = node.color;
          else {
            const bit = ((y + row) * side + x + col) * node.bits;
            const index =
              (node.indices[bit >> 3] >>> (bit & 7)) & ((1 << node.bits) - 1);
            color = node.colors[index];
          }
          writeColor(out, offset + row * stride + col * 4, color);
        }
    }
  }
}
