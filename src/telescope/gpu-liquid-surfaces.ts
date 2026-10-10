import { LIQUID_SURFACE_REACH, type LiquidSurface } from './liquid-surfaces';

type EngineTable = { width: number; height: number; data: Float32Array };

/** Insert sparse pool records before the final Wang-parameter row. Reuse the
 * engine-table sampler: live terrain already uses WebGL2's minimum 16 units.
 * Each chunk header is (record offset, count, ownership | reach << 3, Y mask).
 * The 16-bit Y mask skips surface-list reads outside relevant 32px strips.
 * Pool records are (left, right, surface Y, material), in main-world pixels. */
export function packLiquidSurfaces(
  table: EngineTable,
  surfaces: readonly LiquidSurface[],
  owners: readonly ArrayLike<number>[],
  worldColumns: number,
  textureLimit: number,
) {
  const chunks = worldColumns * 48, worldWidth = worldColumns * 512, center = worldWidth / 2;
  if (owners.length !== 3 || owners.some(owner => owner.length !== chunks))
    throw new Error('Invalid liquid-surface ownership');
  const bins: LiquidSurface[][] = Array.from({ length: chunks }, () => []);
  for (const surface of surfaces) {
    // The lattice's -5px anchor can put a surface across the PW boundary.
    // Split/wrap its interval so lookup never depends on viewport/tile edges.
    for (const shift of [-worldWidth, 0, worldWidth]) {
      const left = Math.max(-center, surface.left + shift);
      const right = Math.min(center, surface.right + shift);
      if (left >= right) continue;
      const record = { ...surface, left, right };
      const top = Math.max(0, Math.floor((surface.y - LIQUID_SURFACE_REACH + 7168) / 512));
      const bottom = Math.min(47, Math.floor((surface.y + LIQUID_SURFACE_REACH - 1 + 7168) / 512));
      for (let y = top; y <= bottom; y++)
        for (let x = Math.floor((left + center) / 512); x <= Math.floor((right - 1 + center) / 512); x++)
          bins[y * worldColumns + x].push(record);
    }
  }
  const records = bins.reduce((sum, bin) => sum + bin.length, chunks);
  const rows = Math.ceil(records / table.width), liquidRow = table.height - 1;
  const height = table.height + rows;
  if (height > textureLimit || table.width > textureLimit)
    throw new Error('Liquid-surface table exceeds GPU capacity');
  const data = new Float32Array(table.width * height * 4);
  const start = liquidRow * table.width * 4;
  data.set(table.data.subarray(0, start));
  // Shader Wang lookups still use the final row, exactly as before.
  data.set(table.data.subarray(start), (height - 1) * table.width * 4);
  let next = chunks;
  bins.forEach((bin, chunk) => {
    let ownership = 0;
    for (let plane = 0; plane < 3; plane++) if (owners[plane][chunk] >= 0) ownership |= 1 << plane;
    let yMask = 0;
    const rowY = Math.floor(chunk / worldColumns) * 512 - 7168;
    for (const s of bin) {
      const top = Math.max(0, Math.floor((s.y - LIQUID_SURFACE_REACH - rowY) / 32));
      const bottom = Math.min(15, Math.floor((s.y + LIQUID_SURFACE_REACH - 1 - rowY) / 32));
      for (let y = top; y <= bottom; y++) yMask |= 1 << y;
    }
    data.set([next, bin.length, ownership | (LIQUID_SURFACE_REACH << 3), yMask], start + chunk * 4);
    for (const s of bin) data.set([s.left, s.right, s.y, s.material], start + next++ * 4);
  });
  return { width: table.width, height, data, liquidRow, bytes: rows * table.width * 16, surfaces: surfaces.length };
}
