/** Sparse native-pixel masks. Runs are [row, start, length] triples. */
export interface LiquidMaskBlock {
  x: number; y: number; width: number; height: number; runs: Uint16Array;
}
const MAGIC = 0x534d514c; // LQMS, little endian
export const LIQUID_MASK_VERSION = 1;
/** Bake compositor preserves captured basin pixels above biome boundaries. */
export const CAPTURED_FLUID_VERSION = 1;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKS = 131072;

function validate(block: LiquidMaskBlock) {
  const { x, y, width, height, runs } = block;
  if (![x, y].every(n => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff) ||
    ![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 512) ||
    runs.length % 3 || runs.length > width * height * 3)
    throw new Error('Invalid liquid mask block');
  let row = -1, end = 0;
  for (let i = 0; i < runs.length; i += 3) {
    const r = runs[i], start = runs[i + 1], length = runs[i + 2];
    if (r >= height || !length || start + length > width || r < row || (r === row && start < end))
      throw new Error('Invalid liquid mask run');
    row = r; end = start + length;
  }
}

export function maskBlock(x: number, y: number, width: number, height: number, pixels: Uint8Array): LiquidMaskBlock | null {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 512) || pixels.length !== width * height)
    throw new Error('Invalid liquid mask pixels');
  const runs: number[] = [];
  for (let row = 0; row < height; row++) for (let col = 0; col < width;) {
    if (!pixels[row * width + col]) { col++; continue; }
    const start = col++;
    while (col < width && pixels[row * width + col]) col++;
    runs.push(row, start, col - start);
  }
  if (!runs.length) return null;
  const block = { x, y, width, height, runs: new Uint16Array(runs) };
  validate(block); return block;
}

export function encodeLiquidMask(blocks: readonly LiquidMaskBlock[]): Uint8Array {
  if (blocks.length > MAX_BLOCKS) throw new Error('Too many liquid mask blocks');
  let size = 12;
  for (const block of blocks) { validate(block); size += 16 + block.runs.byteLength; }
  if (size > MAX_BYTES) throw new Error('Liquid mask exceeds byte limit');
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true); view.setUint32(4, LIQUID_MASK_VERSION, true); view.setUint32(8, blocks.length, true);
  let offset = 12;
  for (const block of blocks) {
    view.setInt32(offset, block.x, true); view.setInt32(offset + 4, block.y, true);
    view.setUint16(offset + 8, block.width, true); view.setUint16(offset + 10, block.height, true);
    view.setUint32(offset + 12, block.runs.length / 3, true); offset += 16;
    for (const word of block.runs) { view.setUint16(offset, word, true); offset += 2; }
  }
  return bytes;
}

export function decodeLiquidMask(bytes: Uint8Array): LiquidMaskBlock[] {
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_BYTES) throw new Error('Invalid liquid mask length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== LIQUID_MASK_VERSION)
    throw new Error('Unsupported liquid mask');
  const count = view.getUint32(8, true);
  if (count > MAX_BLOCKS || count > (bytes.length - 12) / 16) throw new Error('Invalid liquid mask count');
  let offset = 12;
  const blocks: LiquidMaskBlock[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 16 > bytes.length) throw new Error('Truncated liquid mask');
    const x = view.getInt32(offset, true), y = view.getInt32(offset + 4, true);
    const width = view.getUint16(offset + 8, true), height = view.getUint16(offset + 10, true);
    const length = view.getUint32(offset + 12, true) * 3; offset += 16;
    if (length > width * height * 3 || offset + length * 2 > bytes.length) throw new Error('Truncated liquid mask runs');
    const runs = new Uint16Array(length);
    for (let n = 0; n < length; n++, offset += 2) runs[n] = view.getUint16(offset, true);
    const block = { x, y, width, height, runs }; validate(block); blocks.push(block);
  }
  if (offset !== bytes.length) throw new Error('Unexpected liquid mask bytes');
  return blocks;
}

/** Paint a native-pixel subrectangle without expanding whole-world masks. */
export function paintMaskBlock(block: LiquidMaskBlock, pixels: Uint8Array,
  x: number, y: number, width: number, height: number, value = 255) {
  for (let n = 0; n < block.runs.length; n += 3) {
    const row = block.y + block.runs[n] - y;
    if (row < 0 || row >= height) continue;
    const start = Math.max(0, block.x + block.runs[n + 1] - x);
    const end = Math.min(width, block.x + block.runs[n + 1] + block.runs[n + 2] - x);
    if (end > start) pixels.fill(value, row * width + start, row * width + end);
  }
}
