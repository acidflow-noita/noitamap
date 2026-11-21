/** Nightmare uses a 64-chunk world. Its captured background extends to ±105 chunks. */
export const NIGHTMARE_CAPTURE_LIMIT = 105 * 512;

export function captureWorlds(gameMode?: string): number[] {
  return gameMode === "nightmare" ? [0, -1, 1, -2, 2] : [-1, 0, 1];
}

export function visibleWorldSpan(pw: number, worldWidth: number, gameMode?: string) {
  const origin = (pw - 0.5) * worldWidth;
  if (gameMode !== "nightmare") return { minX: origin, width: worldWidth };
  const minX = Math.max(-NIGHTMARE_CAPTURE_LIMIT, origin);
  return { minX, width: Math.max(0, Math.min(NIGHTMARE_CAPTURE_LIMIT, origin + worldWidth) - minX) };
}

/** A side deployment contains its full native world and the visible strip of its next neighbour. */
export function bakedWorldMembers(pw: number, gameMode?: string): number[] {
  return gameMode === "nightmare" && pw !== 0 ? [pw, 2 * pw] : [pw];
}

export function bakedWorldSpan(pw: number, worldWidth: number, gameMode?: string) {
  const slices = bakedWorldMembers(pw, gameMode).map(world => visibleWorldSpan(world, worldWidth, gameMode));
  const minX = Math.min(...slices.map(slice => slice.minX));
  return { minX, width: Math.max(...slices.map(slice => slice.minX + slice.width)) - minX };
}
