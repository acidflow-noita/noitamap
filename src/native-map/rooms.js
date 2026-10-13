// Derived from noita-telescope by Lymm (MIT); see LICENSE.
// Source: Lymm 7fce46be8a5587fa88693d468046e236f862f5c7; algorithms unchanged
// except explicit input/state ownership and removal of discarded raster output.

export function blockOutRooms(pixels, width, height, blockedColors) {
  let rooms = [];
  for (let y = 4; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const color =
        (pixels[idx] << 16) | (pixels[idx + 1] << 8) | pixels[idx + 2];
      if (color === 0x000000 || color === 0xffffff) continue;
      if (!blockedColors.includes(color)) continue;

      let startX = x + 1;
      let startY = y + 1;
      let endX = x + 1;
      let endY = y + 1;
      let foundEnd = false;
      while (!foundEnd && endX < width) {
        if (endX >= width) break;
        const tempIdx = (startY * width + endX) * 3;
        const tempColor =
          (pixels[tempIdx] << 16) |
          (pixels[tempIdx + 1] << 8) |
          pixels[tempIdx + 2];
        if (tempColor === 0x000000 || tempColor === 0x323232) {
          endX++;
          continue;
        }
        endX--;
        foundEnd = true;
      }
      if (endX >= width) endX = width - 1;
      foundEnd = false;
      while (!foundEnd && endY < height) {
        if (endY >= height) break;
        const tempIdx = (endY * width + startX) * 3;
        const tempColor =
          (pixels[tempIdx] << 16) |
          (pixels[tempIdx + 1] << 8) |
          pixels[tempIdx + 2];
        if (tempColor === 0x000000 || tempColor === 0x323232) {
          endY++;
          continue;
        }
        endY--;
        foundEnd = true;
      }
      if (endY >= height) endY = height - 1;

      if (endX > startX && endY > startY) {
        //console.log(`Blocking out room from (${startX}, ${startY}) to (${endX}, ${endY})`);

        // Block out the room with pixels to block pathfinding
        for (let by = startY; by <= endY; by++) {
          for (let bx = startX; bx <= endX; bx++) {
            const bIdx = (by * width + bx) * 3;
            // Magenta for debug
            pixels[bIdx] = 0xff;
            pixels[bIdx + 1] = 0x01;
            pixels[bIdx + 2] = 0xff;
          }
        }
      }

      rooms.push({ color, startX, startY, endX, endY });
    }
  }
  return rooms;
}
