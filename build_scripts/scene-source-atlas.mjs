import UPNG from 'upng-js';
import { encode } from 'fast-png';

/** Source material masks/art, before seed-specific shading. No resizing,
 * premultiplication, rotation, or color conversion is applied. */
export function createSceneSourceAtlas(add) {
  const size = 1024, sheets = [], images = {}, duplicates = new Map();
  let pixels = new Uint8Array(size * size * 4), x = 0, y = 0, row = 0, used = false;
  const flush = () => {
    if (!used) return;
    sheets.push(add(encode({ data: pixels, width: size, height: size, channels: 4 }), 'png', 'scene-atlas'));
    pixels = new Uint8Array(size * size * 4); x = y = row = 0; used = false;
  };
  return {
    add(group, path, bytes, identity) {
      if (!path.endsWith('.png') || bytes.length < 24) return;
      // Spells/perks/entities already use the existing marker spritesheet.
      if (group === 'main' && !/^data\/(biome_impl|weather_gfx|background_gfx|buildings_gfx)\//.test(path)) return;
      const key = `${group}/${path}`;
      const previous = duplicates.get(identity);
      if (previous) { images[key] = previous; return; }
      const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
      const image = { width: decoded.width, height: decoded.height, tiles: [] };
      for (let oy = 0; oy < decoded.height; oy += size) for (let ox = 0; ox < decoded.width; ox += size) {
        const w = Math.min(size, decoded.width - ox), h = Math.min(size, decoded.height - oy);
        if (x + w > size) { x = 0; y += row; row = 0; }
        if (y + h > size) flush();
        for (let r = 0; r < h; r++) {
          const offset = ((oy + r) * decoded.width + ox) * 4;
          pixels.set(rgba.subarray(offset, offset + w * 4), ((y + r) * size + x) * 4);
        }
        image.tiles.push([sheets.length, x, y, ox, oy, w, h]);
        x += w; row = Math.max(row, h); used = true;
      }
      images[key] = image; duplicates.set(identity, image);
    },
    finish() {
      flush();
      return add(Buffer.from(JSON.stringify({ version: 1, size, sheets, images })), 'json', 'scene-atlas');
    },
  };
}
