/** The three captured backgrounds cover 105 chunks on each side of world zero. */
export const CAPTURE_X_LIMIT = 105 * 512;

export function captureWorlds(gameMode?: string, isNGP = false): number[] {
  return isNGP || gameMode === "nightmare" ? [0, -1, 1, -2, 2] : [-1, 0, 1];
}

export function visibleWorldSpan(pw: number, worldWidth: number, gameMode?: string, isNGP = false) {
  const origin = (pw - 0.5) * worldWidth;
  if (!isNGP && gameMode !== "nightmare") return { minX: origin, width: worldWidth };
  const minX = Math.max(-CAPTURE_X_LIMIT, origin);
  return { minX, width: Math.max(0, Math.min(CAPTURE_X_LIMIT, origin + worldWidth) - minX) };
}

/** A side deployment includes the captured strip of its next neighbour on 64-chunk maps. */
export function bakedWorldMembers(pw: number, gameMode?: string, isNGP = false): number[] {
  return (isNGP || gameMode === "nightmare") && pw !== 0 ? [pw, 2 * pw] : [pw];
}

export function bakedWorldSpan(pw: number, worldWidth: number, gameMode?: string, isNGP = false) {
  const slices = bakedWorldMembers(pw, gameMode, isNGP).map(world => visibleWorldSpan(world, worldWidth, gameMode, isNGP));
  const minX = Math.min(...slices.map(slice => slice.minX));
  return { minX, width: Math.max(...slices.map(slice => slice.minX + slice.width)) - minX };
}
