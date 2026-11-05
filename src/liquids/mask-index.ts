import Flatbush from 'flatbush';
import { paintMaskBlock, type LiquidMaskBlock } from './mask-codec';

export interface MaskBounds { x: number; y: number; width: number; height: number }
export const MAX_MASK_PIXELS = 16 * 1024 * 1024;
export function assertMaskBounds(bounds: MaskBounds) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.width < 1 || bounds.height < 1 ||
    bounds.width * bounds.height > MAX_MASK_PIXELS) throw new Error('Liquid mask viewport exceeds budget');
}
export class LiquidMaskIndex {
  private index: Flatbush | null;
  constructor(private blocks: readonly LiquidMaskBlock[]) {
    this.index = blocks.length ? new Flatbush(blocks.length) : null;
    for (const block of blocks) this.index!.add(block.x, block.y, block.x + block.width, block.y + block.height);
    this.index?.finish();
  }
  paint(pixels: Uint8Array, bounds: MaskBounds) {
    for (const id of this.index?.search(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height) ?? [])
      paintMaskBlock(this.blocks[id], pixels, bounds.x, bounds.y, bounds.width, bounds.height);
  }
}

/** Find/crop occupied pixels off the draw thread. Empty views allocate no GPU textures. */
export function cropLiquidMask(pixels: Uint8Array, bounds: MaskBounds, exclusions: readonly MaskBounds[] = []) {
  assertMaskBounds(bounds);
  if (pixels.length !== bounds.width * bounds.height) throw new Error('Invalid viewport liquid mask');
  for (const rect of exclusions) {
    const x0 = Math.max(0, Math.floor(rect.x - bounds.x)), x1 = Math.min(bounds.width, Math.ceil(rect.x + rect.width - bounds.x));
    const y0 = Math.max(0, Math.floor(rect.y - bounds.y)), y1 = Math.min(bounds.height, Math.ceil(rect.y + rect.height - bounds.y));
    if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) pixels.fill(0, y * bounds.width + x0, y * bounds.width + x1);
  }
  let left = bounds.width, right = 0, top = bounds.height, bottom = 0;
  for (let y = 0; y < bounds.height; y++) {
    const row = pixels.subarray(y * bounds.width, (y + 1) * bounds.width);
    const start = row.indexOf(255);
    if (start < 0) continue;
    left = Math.min(left, start); right = Math.max(right, row.lastIndexOf(255) + 1);
    top = Math.min(top, y); bottom = y + 1;
  }
  if (right <= left || bottom <= top) return null;
  const width = right - left, height = bottom - top, cropped = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    cropped.set(pixels.subarray((top + y) * bounds.width + left, (top + y) * bounds.width + right), y * width);
  return { x: bounds.x + left, y: bounds.y + top, width, height, pixels: cropped };
}
