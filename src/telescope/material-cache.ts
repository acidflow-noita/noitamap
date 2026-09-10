/** Bounded lazy material cache shared by color rendering and its edge-neighbor
 * pass. A material resolved for a leaf must not be resolved a second time just
 * to decide edge stamps. Keys are absolute world pixels, including negatives. */
export function cacheMaterialAt(
  sample: (x: number, y: number) => number,
  maxBlocks = 64,
) {
  const size = 128,
    empty = -32768;
  const blocks = new Map<string, Int16Array>();
  const stats = { resolved: 0, reused: 0 };
  let lastX = NaN,
    lastY = NaN,
    lastBlock: Int16Array | undefined;
  const materialAt = (x: number, y: number) => {
    const bx = Math.floor(x / size),
      by = Math.floor(y / size);
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
    const i = (y - by * size) * size + x - bx * size;
    if (block[i] !== empty) {
      stats.reused++;
      return block[i];
    }
    stats.resolved++;
    return (block[i] = sample(x, y));
  };
  return { materialAt, stats };
}
