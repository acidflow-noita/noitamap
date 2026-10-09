import type { PixelScene } from './telescope-adapter';
import type { TerrainTexture } from './terrain-backgrounds';

export const GOLD_ROOM_KEY = 'general/solid_wall_hidden_cavern';
export const GOLD_ROOM_REPAIR_KEY = 'noitamap/captured-gold-room-v1';

// The 2025-01-25 dynamic base captures seed 78633191's upper gold room in
// each PW. Include the rock edge stamps (up to 20px beyond the material mask).
const CAPTURED_X = -6 * 512 - 30;
const EDGE_REACH = 20;

export function isCapturedGoldRoom(scene: Pick<PixelScene, 'key' | 'x' | 'y'>, worldSize: number): boolean {
  return worldSize === 70 && scene.key === GOLD_ROOM_KEY && scene.y === 0 &&
    Number.isInteger((scene.x - CAPTURED_X) / 35840);
}

/** Repair only when we are actually drawing a replacement room elsewhere.
 * No generated room means no assumption about NG+/Nightmare geometry. */
export function capturedGoldRepairs(scenes: readonly PixelScene[], worldSize: number): PixelScene[] {
  if (worldSize !== 70) return [];
  const repairs = new Map<number, PixelScene>();
  for (const scene of scenes) {
    if (scene.key !== GOLD_ROOM_KEY || ![0, 16 * 512, 17 * 512, 22 * 512].includes(scene.y)) continue;
    const pw = Math.floor((scene.x + 17920) / 35840);
    const x = CAPTURED_X + pw * 35840;
    if (isCapturedGoldRoom(scene, worldSize)) continue;
    repairs.set(pw, {
      ...scene, key: GOLD_ROOM_REPAIR_KEY, name: 'captured_gold_room_repair', variantKey: undefined,
      x: x - EDGE_REACH, y: -EDGE_REACH,
      width: scene.width + EDGE_REACH * 2, height: scene.height + EDGE_REACH * 2,
    });
  }
  return [...repairs.values()];
}

/** Original EDR texels at their captured world phase, restricted to the old
 * room and its edge stamps. Never recolor or resample the surrounding chunk. */
export function capturedGoldRepairPixels(
  raw: { width: number; height: number; imgElement: Uint8Array | Uint8ClampedArray },
  texture: TerrainTexture,
  scene: Pick<PixelScene, 'x' | 'y' | 'width' | 'height'>,
): Uint8ClampedArray {
  const { width, height } = scene;
  if (width !== raw.width + 2 * EDGE_REACH || height !== raw.height + 2 * EDGE_REACH)
    throw new Error('Captured gold room dimensions changed');
  const distance = new Uint16Array(width * height).fill(EDGE_REACH + 1);
  for (let y = 0; y < raw.height; y++) for (let x = 0; x < raw.width; x++) {
    const i = (y * raw.width + x) * 4, p = raw.imgElement;
    if (p[i + 3] && (p[i] || p[i + 1] || p[i + 2]))
      distance[(y + EDGE_REACH) * width + x + EDGE_REACH] = 0;
  }
  // Chebyshev distance includes diagonal edge stamps; two linear sweeps avoid
  // checking a 41x41 neighbourhood for every output pixel.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
    if (y) distance[i] = Math.min(distance[i], distance[i - width] + 1,
      x ? distance[i - width - 1] + 1 : EDGE_REACH + 1,
      x + 1 < width ? distance[i - width + 1] + 1 : EDGE_REACH + 1);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
    if (y + 1 < height) distance[i] = Math.min(distance[i], distance[i + width] + 1,
      x ? distance[i + width - 1] + 1 : EDGE_REACH + 1,
      x + 1 < width ? distance[i + width + 1] + 1 : EDGE_REACH + 1);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (distance[p] > EDGE_REACH) continue;
    const tx = ((scene.x + x) % texture.width + texture.width) % texture.width;
    const ty = ((scene.y + y) % texture.height + texture.height) % texture.height;
    const t = (ty * texture.width + tx) * 4;
    out.set(texture.data.subarray(t, t + 4), p * 4);
  }
  return out;
}
