/** Offline classification of the complete exploration window. No clue images
 * are created, and no image analysis runs in a Worker or a player's browser. */
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featurelessKind, type AreaDefinition, type ViewDifficulty } from '../../src/guessr/area-rules.ts';
import { viewSize } from '../../src/guessr/clue-camera.ts';
import type { PrivateImageSet } from '../../src/guessr/image-game-server.ts';
import type { Bounds } from '../../src/guessr/rules.ts';
import { privateOutput } from './private-output.mjs';
import { withProgress } from './progress.mts';

export const FEATURELESS_CELL = 32;
export interface Texture { data: Uint8Array; width: number; height: number }
const mod = (n: number, size: number) => (n % size + size) % size;

/** Capture-aware EDR appearance envelope, restricted to reviewed solid-wall
 * ownership. It includes rock_hard_border/rock_hard texture and edge-stamp
 * colours, with the captured map's shading and chromatic edge variation.
 * Black holes, lava, water, gold and unknown colours veto the entire cell. */
export function edrPixel(r: number, g: number, b: number, a: number) {
  return a === 255 && r >= 18 && r <= 128 && g <= 105 && b <= 100
    && r - g >= 2 && r - g <= 45 && g - b >= -3 && g - b <= 14
    && r - b >= 12 && r - b <= 50;
}

/** Hell is matched against the actual, world-aligned repeating artwork. Small
 * 8px patches tolerate capture resampling, but a foreground object or a wrong
 * texture phase rejects the cell. This is not a low-contrast/colour-count test. */
export function plainCell(image: Texture, left: number, top: number, worldX: number, worldY: number,
  kind: ViewDifficulty, hell: Texture): boolean {
  const size = FEATURELESS_CELL;
  if (left < 0 || top < 0 || left + size > image.width || top + size > image.height) return false;
  if (kind === 'featureless-edr') {
    for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
      const p = (y * image.width + x) * 4, d = image.data;
      if (!edrPixel(d[p], d[p + 1], d[p + 2], d[p + 3])) return false;
    }
    return true;
  }
  for (let by = 0; by < size; by += 8) for (let bx = 0; bx < size; bx += 8) {
    let difference = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
      const p = ((top + y) * image.width + left + x) * 4, d = image.data;
      const q = (mod(worldY + y, hell.height) * hell.width + mod(worldX + x, hell.width)) * 4;
      if (d[p + 3] !== 255) return false;
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(d[p + c] - hell.data[q + c]);
        if (delta > 32) return false;
        difference += delta;
      }
    }
    if (difference > 4.5 * 8 * 8 * 3) return false;
  }
  return true;
}

/** Every possible native-pixel centre in an emitted cell must have a wholly
 * plain widest view. Rounding grows the tested footprint, never shrinks it. */
export function featurelessCentres(grid: Uint8Array, columns: number, rows: number, value: number,
  originX: number, originY: number): Bounds[] {
  const stride = columns + 1, sums = new Uint32Array(stride * (rows + 1));
  for (let y = 0; y < rows; y++) {
    let row = 0;
    for (let x = 0; x < columns; x++) {
      row += grid[y * columns + x] === value ? 1 : 0;
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + row;
    }
  }
  const size = FEATURELESS_CELL, widest = viewSize(6), halfX = Math.ceil(widest.width / 2 / size), halfY = Math.ceil(widest.height / 2 / size);
  const needed = (halfX * 2 + 1) * (halfY * 2 + 1), result: Bounds[] = [];
  let previous = new Map<string, Bounds>();
  for (let y = halfY; y < rows - halfY; y++) {
    let start = -1;
    const next = new Map<string, Bounds>();
    for (let x = halfX; x <= columns - halfX; x++) {
      const left = x - halfX, right = x + halfX + 1, top = y - halfY, bottom = y + halfY + 1;
      const fits = x < columns - halfX && sums[bottom * stride + right] - sums[top * stride + right]
        - sums[bottom * stride + left] + sums[top * stride + left] === needed;
      if (fits) { if (start < 0) start = x; }
      else if (start >= 0) {
        const key = `${start},${x}`, old = previous.get(key);
        const rectangle = old ?? { x: originX + start * size, y: originY + y * size, width: (x - start) * size, height: 0 };
        rectangle.height += size; if (!old) result.push(rectangle); next.set(key, rectangle); start = -1;
      }
    }
    previous = next;
  }
  return result;
}

export async function classifyFeaturelessViews(index: PrivateImageSet, areas: readonly AreaDefinition[],
  readImage: (id: string) => Promise<Uint8Array>, hell: Texture) {
  const c = index.capture, size = FEATURELESS_CELL;
  if (c.tileSize % size || c.originX % size || c.originY % size || hell.width !== 256 || hell.height !== 256)
    throw new Error('Unsupported featureless-view geometry or Hell artwork.');
  const columns = Math.ceil(c.width / size), rows = Math.ceil(c.height / size), owners = new Uint8Array(columns * rows);
  const relevant = areas.filter(a => featurelessKind(a) && a.runs?.length && Number.isInteger(a.originY));
  const jobs = new Set<string>();
  for (const area of relevant) {
    const value = featurelessKind(area) === 'featureless-edr' ? 1 : 2;
    for (const [row, begin, end] of area.runs!) {
      const left = Math.max(0, Math.ceil((-17920 + begin * 512 - c.originX) / size));
      const right = Math.min(columns, Math.floor((-17920 + end * 512 - c.originX) / size));
      const top = Math.max(0, Math.ceil((area.originY! + row * 512 - c.originY) / size));
      const bottom = Math.min(rows, Math.floor((area.originY! + (row + 1) * 512 - c.originY) / size));
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const p = y * columns + x;
        owners[p] = !owners[p] || owners[p] === value ? value : 255;
        jobs.add(`${Math.floor(x * size / c.tileSize)},${Math.floor(y * size / c.tileSize)}`);
      }
    }
  }
  const plain = new Uint8Array(owners.length), tiles = [...jobs];
  let cursor = 0;
  await withProgress('Classifying EDR and Hell views', tiles.length, async progress => Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < tiles.length) {
      const coordinate = tiles[cursor++], [column, row] = coordinate.split(',').map(Number), id = index.levels[c.maxLevel].images[coordinate];
      if (!/^[a-f0-9]{32,64}$/.test(id ?? '')) throw new Error('Missing native image for view classification.');
      const bytes = await readImage(id);
      const { data, info } = await sharp(bytes, { limitInputPixels: (c.tileSize + 2 * c.overlap) ** 2 })
        .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const metadata = index.images[id];
      if (info.width !== metadata.width || info.height !== metadata.height) throw new Error('View-classification image dimensions do not match.');
      const image = { data, width: info.width, height: info.height };
      for (let by = 0; by < c.tileSize / size; by++) for (let bx = 0; bx < c.tileSize / size; bx++) {
        const x = column * c.tileSize / size + bx, y = row * c.tileSize / size + by;
        if (x >= columns || y >= rows) continue;
        const p = y * columns + x, owner = owners[p];
        if (owner !== 1 && owner !== 2) continue;
        if (plainCell(image, bx * size + (column ? c.overlap : 0), by * size + (row ? c.overlap : 0),
          c.originX + x * size, c.originY + y * size, owner === 1 ? 'featureless-edr' : 'hell-background-only', hell)) plain[p] = owner;
      }
      progress.advance();
    }
  })), { unit: 'tiles' });
  const classified: Record<string, Bounds[]> = {};
  for (const area of relevant) classified[area.id] = featurelessCentres(plain, columns, rows,
    featurelessKind(area) === 'featureless-edr' ? 1 : 2, c.originX, c.originY);
  return { schemaVersion: 1 as const, imageVersion: index.version, cellSize: size, areas: classified };
}

export async function prepareFeaturelessViews(options: { indexPath?: string; inventoryPath?: string; imageDirectory?: string } = {}) {
  const indexPath = privateOutput(resolve(options.indexPath ?? 'task/guessr/private/image-set.json'));
  const [index, inventory, textureBytes] = await Promise.all([
    readFile(indexPath, 'utf8').then(JSON.parse) as Promise<PrivateImageSet>,
    readFile(options.inventoryPath ?? 'task/guessr/area-inventory/inventory.json', 'utf8').then(JSON.parse),
    readFile(new URL('../../public/biome_bg/background_the_end.png', import.meta.url)),
  ]);
  if (index.capture.sha256 !== inventory.capture.sha256) throw new Error('Classification masks and images must use the same capture.');
  const { data, info } = await sharp(textureBytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imageDirectory = resolve(options.imageDirectory ?? 'task/guessr/opaque-site/images');
  const evidence = await classifyFeaturelessViews(index, inventory.puzzleAreas,
    id => readFile(resolve(imageDirectory, id + '.webp')), { data, width: info.width, height: info.height });
  const policy = createHash('sha256').update('featureless-view-v1').update(textureBytes).digest('hex');
  const updated = { ...index, viewDifficulty: { ...evidence, policy } }, temporary = indexPath + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(updated), { mode: 0o600, flag: 'wx' }); await rename(temporary, indexPath); }
  finally { await rm(temporary, { force: true }); }
  return Object.fromEntries(Object.entries(evidence.areas).map(([id, rectangles]) => [id,
    { rectangles: rectangles.length, positions: rectangles.reduce((n, r) => n + r.width * r.height, 0) }]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(v => { const n = v.indexOf('='); return [v.slice(2, n), v.slice(n + 1)]; }));
  console.log(JSON.stringify(await prepareFeaturelessViews({ indexPath: args.index, inventoryPath: args.inventory, imageDirectory: args.images }), null, 2));
}
