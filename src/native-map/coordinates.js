// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

export const CHUNK_SIZE = 512;
export const TILE_SIZE = 10;

export function shuffleTable(arr, prng) {
  for (let i = arr.length - 1; i >= 1; i--) {
    let j = prng.Random(0, i);
    let temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
}

export function getWorldCenter(isNGP, gameMode = "normal") {
  if (gameMode === "nightmare") return 32;
  return isNGP ? 32 : 35;
}
