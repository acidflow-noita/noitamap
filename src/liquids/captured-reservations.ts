import blocks from './assets/captured-fluid-reservations.json';
import type { StaticTerrainMask } from '../telescope/static-terrain-mask';
import type { MaskBounds } from './mask-index';

export interface WorldSpan { x: number; width: number }

// These pixels belong to the reviewed background capture, not the active
// seed's altar variant. Only the fluid above procedural biome boundaries is
// reserved; the surrounding air, stone and the rest of each biome stay intact.
const masks: StaticTerrainMask[] = blocks.map(block => {
  const bits = new Uint8Array(Math.ceil(block.width * block.height / 8));
  for (let i = 0; i < block.runs.length; i += 3) {
    const start = block.runs[i] * block.width + block.runs[i + 1];
    for (let p = start; p < start + block.runs[i + 2]; p++) bits[p >> 3] |= 1 << (p & 7);
  }
  return { x: block.x, y: block.y, width: block.width, height: block.height, bits };
});

// Merge consecutive equal runs once. All sixteen basins together need only
// 32 rectangles, including their half-filled first surface row.
const rectangles: MaskBounds[] = [];
for (const block of blocks) {
  let previous: MaskBounds | undefined;
  for (let i = 0; i < block.runs.length; i += 3) {
    const x = block.x + block.runs[i + 1], y = block.y + block.runs[i], width = block.runs[i + 2];
    if (previous && previous.x === x && previous.width === width && previous.y + previous.height === y) previous.height++;
    else { previous = { x, y, width, height: 1 }; rectangles.push(previous); }
  }
}

export function capturedFluidMasks(worlds?: readonly number[]): StaticTerrainMask[] {
  return worlds ? masks.filter(mask => worlds.includes(Math.floor((mask.x + 17920) / 35840))) : [...masks];
}

/** Intersect with the caller's existing clip, using main-world drawing coords. */
export function clipCapturedFluids(context: CanvasRenderingContext2D, bounds: MaskBounds, worldOffsetX = 0) {
  const x = bounds.x + worldOffsetX;
  const visible = rectangles.filter(r => r.x < x + bounds.width && r.x + r.width > x &&
    r.y < bounds.y + bounds.height && r.y + r.height > bounds.y);
  if (!visible.length) return;
  context.beginPath();
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  for (const r of visible) {
    const left = Math.max(x, r.x), top = Math.max(bounds.y, r.y);
    context.rect(left - worldOffsetX, top, Math.min(x + bounds.width, r.x + r.width) - left,
      Math.min(bounds.y + bounds.height, r.y + r.height) - top);
  }
  context.clip('evenodd');
}

/** Old baked images already cover these pixels. Suppress the captured mask
 * there until the bake advertises preservation; a generated mask may then
 * paint its own verified fluid over this cleared area. */
export function clearCapturedFluids(pixels: Uint8Array, bounds: MaskBounds, worlds: readonly WorldSpan[]) {
  for (const r of rectangles) {
    const top = Math.max(bounds.y, r.y), bottom = Math.min(bounds.y + bounds.height, r.y + r.height);
    if (top >= bottom) continue;
    for (const world of worlds) {
      const left = Math.max(bounds.x, r.x, world.x);
      const right = Math.min(bounds.x + bounds.width, r.x + r.width, world.x + world.width);
      if (left >= right) continue;
      for (let y = top; y < bottom; y++) pixels.fill(0, (y - bounds.y) * bounds.width + left - bounds.x,
        (y - bounds.y) * bounds.width + right - bounds.x);
    }
  }
}
