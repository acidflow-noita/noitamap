/** A caller-owned rectangle. The cache copies IDs; scene/decal painters may
 * mutate this storage without changing cached terrain materials. */
export interface MaterialRectTarget {
  data: Int16Array;
  stride: number;
  offset?: number;
}
export type ReadMaterialRect = (
  x: number,
  y: number,
  width: number,
  height: number,
  target: MaterialRectTarget,
) => void;

/** Bounded lazy material cache shared by color rendering and its edge-neighbor
 * pass. A material resolved for a leaf must not be resolved a second time just
 * to decide edge stamps. Keys are absolute world pixels, including negatives. */
export function cacheMaterialAt(
  sample: (x: number, y: number) => number,
  maxBlocks = 64,
) {
  const size = 128,
    empty = -32768,
    nativeFallback = -32767;
  const blocks = new Map<string, Int16Array>();
  const stats = { resolved: 0, reused: 0, prefilled: 0 };
  let lastX = NaN,
    lastY = NaN,
    lastBlock: Int16Array | undefined;
  const getBlock = (bx: number, by: number) => {
    let block = lastX === bx && lastY === by ? lastBlock : undefined;
    if (!block) {
      const key = `${bx},${by}`;
      block = blocks.get(key);
      if (!block) {
        block = new Int16Array(size * size).fill(empty);
        blocks.set(key, block);
        if (blocks.size > maxBlocks) blocks.delete(blocks.keys().next().value!);
      }
      lastX = bx;
      lastY = by;
      lastBlock = block;
    }
    return block;
  };
  const materialAt = (x: number, y: number) => {
    const bx = Math.floor(x / size),
      by = Math.floor(y / size),
      block = getBlock(bx, by);
    const i = (y - by * size) * size + x - bx * size;
    if (block[i] !== empty && block[i] !== nativeFallback) {
      stats.reused++;
      return block[i];
    }
    stats.resolved++;
    return (block[i] = sample(x, y));
  };
  return {
    materialAt,
    stats,
    /** Read block-row spans instead of repeating block lookup per pixel. Only
     * this requested rectangle is resolved; native fallbacks remain lazy. */
    readRect(
      x: number,
      y: number,
      width: number,
      height: number,
      { data, stride, offset = 0 }: MaterialRectTarget,
    ) {
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 0 ||
        height < 0 ||
        !Number.isInteger(stride) ||
        stride < width ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (height > 0 && offset + (height - 1) * stride + width > data.length)
      )
        throw new RangeError("Invalid material rectangle target");
      for (let row = 0; row < height; row++) {
        const wy = y + row,
          by = Math.floor(wy / size);
        for (let col = 0; col < width;) {
          const wx = x + col,
            bx = Math.floor(wx / size),
            block = getBlock(bx, by);
          const start = (wy - by * size) * size + wx - bx * size;
          const count = Math.min(width - col, (bx + 1) * size - wx);
          stats.reused += count;
          for (let i = 0; i < count; i++) {
            const value = block[start + i];
            if (value !== empty && value !== nativeFallback) continue;
            stats.reused--;
            stats.resolved++;
            block[start + i] = sample(wx + i, wy);
          }
          data.set(
            block.subarray(start, start + count),
            offset + row * stride + col,
          );
          col += count;
        }
      }
    },
    /** Native -1 is an unhandled query, not the JS resolver's final -1. */
    prefill(
      x: number,
      y: number,
      width: number,
      height: number,
      values: Int32Array,
    ) {
      if (values.length !== width * height)
        throw new RangeError("Invalid material prefill");
      for (let row = 0; row < height; row++) {
        const wy = y + row,
          by = Math.floor(wy / size);
        for (let col = 0; col < width;) {
          const wx = x + col,
            bx = Math.floor(wx / size),
            block = getBlock(bx, by);
          const start = (wy - by * size) * size + wx - bx * size;
          const count = Math.min(width - col, (bx + 1) * size - wx);
          for (let i = 0; i < count; i++) {
            if (block[start + i] !== empty) continue;
            const value = values[row * width + col + i];
            block[start + i] = value < 0 ? nativeFallback : value;
            if (value >= 0) stats.prefilled++;
          }
          col += count;
        }
      }
    },
    /** Attempted native fallbacks remain lazy but do not trigger repeat batches. */
    hasMissing(x: number, y: number, width: number, height: number) {
      for (let row = 0; row < height; row++) {
        const wy = y + row,
          by = Math.floor(wy / size);
        for (let col = 0; col < width;) {
          const wx = x + col,
            bx = Math.floor(wx / size),
            block = blocks.get(`${bx},${by}`);
          if (!block) return true;
          const start = (wy - by * size) * size + wx - bx * size;
          const count = Math.min(width - col, (bx + 1) * size - wx);
          for (let i = 0; i < count; i++)
            if (block[start + i] === empty) return true;
          col += count;
        }
      }
      return false;
    },
  };
}
