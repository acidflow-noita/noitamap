export interface BiomePathBounds { x: number; y: number; width: number; height: number }

/** Bounds of the boundary overlay's authored absolute M/L/Z polygons. */
export function biomePathBounds(path: string): BiomePathBounds | null {
  const coordinates = path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  if (coordinates.length < 6 || coordinates.length % 2 || coordinates.some(n => !Number.isFinite(n))) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let index = 0; index < coordinates.length; index += 2) {
    left = Math.min(left, coordinates[index]); right = Math.max(right, coordinates[index]);
    top = Math.min(top, coordinates[index + 1]); bottom = Math.max(bottom, coordinates[index + 1]);
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
