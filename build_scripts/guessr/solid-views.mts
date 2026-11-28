import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cameraRect } from '../../src/guessr/clue-camera.ts';
import type { PrivateImageSet } from '../../src/guessr/image-game-server.ts';
import type { Bounds } from '../../src/guessr/rules.ts';
import { SOLID_START_LEVEL } from '../../src/guessr/starting-view.ts';

type NativeTile = { pixels: Uint32Array; width: number };

export async function prepareSolidViews(index: PrivateImageSet, imageDirectory: string) {
  if (index.solidViews?.imageVersion !== index.version || index.solidViews.level !== SOLID_START_LEVEL) {
    index.solidViews = await classifySolidViews(index, (id) => readFile(join(imageDirectory, id + '.webp')));
  }
  return index.solidViews;
}

type ReadImage = (id: string) => Promise<Uint8Array>;

async function readTileBand(index: PrivateImageSet, top: number, readImage: ReadImage) {
  const c = index.capture;
  const grid = index.levels[c.maxLevel].images;
  const columns = Math.ceil(c.width / c.tileSize);
  const decoded = new Map<string, Promise<NativeTile>>();
  const tileRow = Math.floor(top / c.tileSize);
  return Promise.all(
    Array.from({ length: columns }, (_, column) => {
      const id = grid[`${column},${tileRow}`],
        meta = index.images[id];
      if (!/^[a-f0-9]{32}$/.test(id ?? '') || !meta)
        throw Error('Missing native image for solid-view classification.');
      const left = column * c.tileSize;
      const width = Math.min(c.width, left + c.tileSize + c.overlap) - Math.max(0, left - c.overlap);
      const height = Math.min(c.height, top + c.tileSize + c.overlap) - Math.max(0, top - c.overlap);
      if (meta.width !== width || meta.height !== height)
        throw Error('Invalid native tile geometry for solid-view classification.');
      if (meta.content === 'empty') return undefined;
      let tile = decoded.get(id);
      if (!tile) {
        tile = readImage(id).then(async (image) => {
          const { data, info } = await sharp(image, { limitInputPixels: (c.tileSize + 2 * c.overlap) ** 2 })
            .toColourspace('srgb')
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          if (info.width !== width || info.height !== height || info.channels !== 4)
            throw Error('Native image dimensions differ from the solid-view index.');
          const rgba = data.byteOffset % 4 === 0 ? data : Uint8Array.from(data);
          return { width, pixels: new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4) };
        });
        decoded.set(id, tile);
      }
      return tile;
    }),
  );
}

/** Exact native-pixel centers whose fourth centered zoom is a single visible RGBA.
 * Read one tile band at a time and use each native core exactly once at seams. */
export async function classifySolidViews(index: PrivateImageSet, readImage: ReadImage) {
  const c = index.capture,
    view = cameraRect({ dx: 0, dy: 0, level: SOLID_START_LEVEL });
  const rectangles: Bounds[] = [];
  const evidence = { imageVersion: index.version, level: SOLID_START_LEVEL, rectangles };
  if (c.width < view.width || c.height < view.height) return evidence;
  const row = new Uint32Array(c.width),
    bytes = new Uint8Array(row.buffer);
  const lastRow = new Int32Array(c.width).fill(-2);
  const firstRow = new Int32Array(c.width),
    lastColor = new Uint32Array(c.width);
  let previous = new Map<number, Bounds>();
  for (let top = 0; top < c.height; top += c.tileSize) {
    const tiles = await readTileBand(index, top, readImage);
    for (let dy = 0; dy < Math.min(c.tileSize, c.height - top); dy++) {
      const y = top + dy;
      for (let column = 0; column < tiles.length; column++) {
        const x = column * c.tileSize,
          width = Math.min(c.tileSize, c.width - x),
          tile = tiles[column];
        if (!tile) {
          row.fill(0, x, x + width);
          continue;
        }
        const source = (dy + (top ? c.overlap : 0)) * tile.width + (column ? c.overlap : 0);
        row.set(tile.pixels.subarray(source, source + width), x);
      }
      const next = new Map<number, Bounds>();
      function add(left: number, right: number) {
        const old = previous.get(left),
          width = right - left;
        if (old && old.width === width) {
          old.height++;
          next.set(left, old);
        } else {
          const rect = { x: c.originX + left, y: c.originY + y - view.height + 1 - view.y, width, height: 1 };
          rectangles.push(rect);
          next.set(left, rect);
        }
      }
      // A run long enough to fill the view must contain a probe. After a color
      // boundary the earliest possible next full-width run ends one view away.
      for (let probe = view.width - 1; probe < row.length;) {
        const p = probe * 4,
          color = row[probe];
        if (!bytes[p + 3] || !(bytes[p] || bytes[p + 1] || bytes[p + 2])) {
          probe += view.width;
          continue;
        }
        let left = probe,
          right = probe + 1;
        while (left > 0 && row[left - 1] === color) left--;
        while (right < row.length && row[right] === color) right++;
        const end = right - view.width - view.x + 1;
        let start = -1;
        // At each horizontal center count consecutive rows of the same full-width color.
        for (let x = left - view.x; x < end; x++) {
          if (lastRow[x] !== y - 1 || lastColor[x] !== color) firstRow[x] = y;
          lastRow[x] = y;
          lastColor[x] = color;
          if (y - firstRow[x] + 1 >= view.height) {
            if (start < 0) start = x;
          } else if (start >= 0) {
            add(start, x);
            start = -1;
          }
        }
        if (start >= 0) add(start, end);
        probe = right + view.width - 1;
      }
      previous = next;
    }
  }
  return evidence;
}
