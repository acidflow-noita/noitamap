import { SharedPixelStore, type PixelNodeId } from "../cooked-pixels";
import { compositeRGBA, readRGBA, writeRGBA } from "../composition/pixels";

export type FragmentOperation =
  "replace" | "over" | "masked-replace" | "masked-over";
type Quad = [number, number, number, number];
type Alpha = { min: number; max: number; hidden: boolean; zero: boolean };

/** Preparation-time algebra over immutable FINAL image fragments. Decisions,
 * RNG, material selection and dependencies have already been resolved by the
 * caller. Only intersected leaves are evaluated; untouched subtrees and repeated
 * compositions retain existing node IDs. The display decoder never calls this. */
export class FragmentComposer {
  private readonly composed = new Map<string, PixelNodeId>();
  private readonly cropped = new Map<string, PixelNodeId>();
  private readonly placed = new Map<string, PixelNodeId>();
  private readonly alphas = new Map<PixelNodeId, Alpha>();
  readonly stats = {
    /** Pixels decoded/scanned to establish cached alpha summaries. */
    alphaPixels: 0,
    /** Pixels visited by actual composition writes, excluding alpha scans. */
    leafPixels: 0,
    compositions: 0,
    reused: 0,
    crops: 0,
    placements: 0,
  };
  constructor(readonly store: SharedPixelStore) {}

  private children(id: number, side: number): Quad {
    const node = this.store.inspectNode(id, side);
    if (node.kind === "solid") return [id, id, id, id];
    if (node.kind === "branch") return [...node.children];
    const half = side / 2;
    return [0, 1, 2, 3].map((q) =>
      this.store.addBlock(
        this.store.readBlock(
          id,
          side,
          (q & 1) * half,
          (q >> 1) * half,
          half,
          half,
        ),
        half,
      ),
    ) as Quad;
  }

  private alpha(id: number, side: number): Alpha {
    const cached = this.alphas.get(id);
    if (cached) return cached;
    const node = this.store.inspectNode(id, side);
    let result: Alpha;
    if (node.kind === "solid") {
      const a = node.color >>> 24;
      result = {
        min: a,
        max: a,
        hidden: a === 0 && node.color !== 0,
        zero: node.color === 0,
      };
    } else if (node.kind === "branch") {
      const children = node.children.map((child) =>
        this.alpha(child, side / 2),
      );
      result = {
        min: Math.min(...children.map((c) => c.min)),
        max: Math.max(...children.map((c) => c.max)),
        hidden: children.some((c) => c.hidden),
        zero: children.every((c) => c.zero),
      };
    } else {
      const pixels = this.store.readBlock(id, side);
      this.stats.alphaPixels += side * side;
      result = { min: 255, max: 0, hidden: false, zero: true };
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3],
          nonzero = !!(pixels[i] || pixels[i + 1] || pixels[i + 2]);
        result.min = Math.min(result.min, a);
        result.max = Math.max(result.max, a);
        result.hidden ||= a === 0 && nonzero;
        result.zero &&= !a && !nonzero;
      }
    }
    this.alphas.set(id, result);
    return result;
  }

  combine(
    back: number,
    front: number,
    side: number,
    operation: FragmentOperation,
    mask?: number,
  ): number {
    if (
      !["replace", "over", "masked-replace", "masked-over"].includes(operation)
    )
      throw new Error("Invalid fragment operation");
    this.store.inspectNode(back, side);
    this.store.inspectNode(front, side);
    const masked = operation.startsWith("masked-");
    if (masked !== (mask !== undefined))
      throw new Error("Fragment mask contract");
    if (mask !== undefined) {
      this.store.inspectNode(mask, side);
      const a = this.alpha(mask, side);
      if (a.max === 0) return back;
      if (a.min === 255)
        return this.combine(
          back,
          front,
          side,
          operation === "masked-over" ? "over" : "replace",
        );
    }
    if (operation === "replace") return front;
    if (operation === "over") {
      const f = this.alpha(front, side);
      if (f.min === 255) return front;
      const b = this.alpha(back, side);
      // Preserve source RGB at alpha zero when the destination is transparent;
      // the reference compositor returns the entire source word in that case.
      if (b.max === 0) return front;
      if (f.max === 0 && (b.min > 0 || (f.zero && !b.hidden))) return back;
    }
    const key = `${side}/${back}/${front}/${operation}/${mask ?? 0}`;
    const prior = this.composed.get(key);
    if (prior !== undefined) {
      this.stats.reused++;
      return prior;
    }
    let root: number;
    if (side > this.store.leafSize) {
      const backs = this.children(back, side),
        fronts = this.children(front, side);
      const masks = mask === undefined ? undefined : this.children(mask, side);
      root = this.store.joinBlocks(
        side,
        backs.map((value, q) =>
          this.combine(value, fronts[q], side / 2, operation, masks?.[q]),
        ) as Quad,
      );
    } else {
      const dst = this.store.readBlock(back, side),
        src = this.store.readBlock(front, side);
      const m =
        mask === undefined ? undefined : this.store.readBlock(mask, side);
      for (let i = 0; i < dst.length; i += 4) {
        if (m && m[i + 3] !== 0 && m[i + 3] !== 255)
          throw new Error("Unresolved fractional fragment mask");
        if (m && !m[i + 3]) continue;
        if (operation === "masked-replace") dst.set(src.subarray(i, i + 4), i);
        else
          writeRGBA(dst, i, compositeRGBA(readRGBA(src, i), readRGBA(dst, i)));
      }
      this.stats.leafPixels += side * side;
      root = this.store.addBlock(dst, side);
    }
    this.stats.compositions++;
    this.composed.set(key, root);
    return root;
  }

  crop(
    source: number,
    sourceSide: number,
    x: number,
    y: number,
    side: number,
  ): number {
    this.store.inspectNode(source, sourceSide);
    if (
      ![x, y, side].every(Number.isSafeInteger) ||
      x < 0 ||
      y < 0 ||
      x + side > sourceSide ||
      y + side > sourceSide ||
      side < 1 ||
      !Number.isInteger(Math.log2(side))
    )
      throw new RangeError("Invalid fragment crop");
    const node = this.store.inspectNode(source, sourceSide);
    if (node.kind === "solid" || (x === 0 && y === 0 && side === sourceSide))
      return source;
    const key = `${source}/${sourceSide}/${x}/${y}/${side}`,
      cached = this.cropped.get(key);
    if (cached !== undefined) {
      this.stats.reused++;
      return cached;
    }
    let root: number;
    const half = sourceSide / 2,
      qx = Math.floor(x / half),
      qy = Math.floor(y / half);
    if (
      node.kind === "branch" &&
      x + side <= (qx + 1) * half &&
      y + side <= (qy + 1) * half
    )
      root = this.crop(
        node.children[qy * 2 + qx],
        half,
        x - qx * half,
        y - qy * half,
        side,
      );
    else if (side > this.store.leafSize) {
      const h = side / 2;
      root = this.store.joinBlocks(
        side,
        [0, 1, 2, 3].map((q) =>
          this.crop(source, sourceSide, x + (q & 1) * h, y + (q >> 1) * h, h),
        ) as Quad,
      );
    } else
      root = this.store.addBlock(
        this.store.readBlock(source, sourceSide, x, y, side, side),
        side,
      );
    this.stats.crops++;
    this.cropped.set(key, root);
    return root;
  }

  /** Integer placement. Fractional/rotated sprites must be resolved into a
   * prepared raster fragment first; rounding them here would change pixels. */
  place(
    back: number,
    side: number,
    front: number,
    sourceSide: number,
    x: number,
    y: number,
    operation: FragmentOperation,
    mask?: number,
  ): number {
    if (
      !["replace", "over", "masked-replace", "masked-over"].includes(operation)
    )
      throw new Error("Invalid fragment operation");
    this.store.inspectNode(back, side);
    this.store.inspectNode(front, sourceSide);
    if (mask !== undefined) this.store.inspectNode(mask, sourceSide);
    if (
      ![x, y].every(Number.isSafeInteger) ||
      Math.abs(x) > 2 ** 30 ||
      Math.abs(y) > 2 ** 30
    )
      throw new RangeError(
        "Fragment placement must have resolved integer coordinates",
      );
    if (operation.startsWith("masked-") !== (mask !== undefined))
      throw new Error("Fragment mask contract");
    const key = `${back}/${side}/${front}/${sourceSide}/${x}/${y}/${operation}/${mask ?? 0}`;
    const found = this.placed.get(key);
    if (found !== undefined) {
      this.stats.reused++;
      return found;
    }
    const visit = (
      id: number,
      size: number,
      ox: number,
      oy: number,
    ): number => {
      const left = Math.max(ox, x),
        top = Math.max(oy, y),
        right = Math.min(ox + size, x + sourceSide),
        bottom = Math.min(oy + size, y + sourceSide);
      if (right <= left || bottom <= top) return id;
      if (
        left === ox &&
        top === oy &&
        right === ox + size &&
        bottom === oy + size
      )
        return this.combine(
          id,
          this.crop(front, sourceSide, ox - x, oy - y, size),
          size,
          operation,
          mask === undefined
            ? undefined
            : this.crop(mask, sourceSide, ox - x, oy - y, size),
        );
      if (size > this.store.leafSize) {
        const half = size / 2;
        return this.store.joinBlocks(
          size,
          this.children(id, size).map((child, q) =>
            visit(child, half, ox + (q & 1) * half, oy + (q >> 1) * half),
          ) as Quad,
        );
      }
      const dst = this.store.readBlock(id, size),
        width = right - left,
        height = bottom - top;
      const src = this.store.readBlock(
        front,
        sourceSide,
        left - x,
        top - y,
        width,
        height,
      );
      const m =
        mask === undefined
          ? undefined
          : this.store.readBlock(
              mask,
              sourceSide,
              left - x,
              top - y,
              width,
              height,
            );
      for (let row = 0; row < height; row++)
        for (let col = 0; col < width; col++) {
          const s = (row * width + col) * 4,
            d = ((top - oy + row) * size + left - ox + col) * 4;
          if (m && m[s + 3] !== 0 && m[s + 3] !== 255)
            throw new Error("Unresolved fractional fragment mask");
          if (m && !m[s + 3]) continue;
          if (operation === "replace" || operation === "masked-replace")
            dst.set(src.subarray(s, s + 4), d);
          else
            writeRGBA(
              dst,
              d,
              compositeRGBA(readRGBA(src, s), readRGBA(dst, d)),
            );
        }
      this.stats.leafPixels += width * height;
      return this.store.addBlock(dst, size);
    };
    const result = visit(back, side, 0, 0);
    this.stats.placements++;
    this.placed.set(key, result);
    return result;
  }
}
