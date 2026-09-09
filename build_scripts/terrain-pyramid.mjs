import sharp from "sharp";
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
export const TILE = 512,
  OVERLAP = 2;
export const maxLevel = (width, height) =>
  Math.ceil(Math.log2(Math.max(width, height)));
export const levelSize = (width, height, max, level) => ({
  width: Math.ceil(width / 2 ** (max - level)),
  height: Math.ceil(height / 2 ** (max - level)),
});
export function coreShape(width, height, x, y) {
  return {
    width: Math.min(TILE, width - x * TILE),
    height: Math.min(TILE, height - y * TILE),
  };
}
export async function atomicWrite(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + ".tmp";
  await writeFile(temp, buffer);
  await rename(temp, path);
}
export async function completeFile(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** Premultiplied-alpha 2:1 box reduction. Every final source pixel contributes;
 * transparent neighbors cannot inject black RGB or change cloud colors. */
export function reduce2(pixels, width, height) {
  const w = Math.ceil(width / 2),
    h = Math.ceil(height / 2),
    out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx,
            sy = y * 2 + dy;
          if (sx >= width || sy >= height) continue;
          const i = (sy * width + sx) * 4,
            alpha = pixels[i + 3];
          a += alpha;
          r += pixels[i] * alpha;
          g += pixels[i + 1] * alpha;
          b += pixels[i + 2] * alpha;
        }
      const i = (y * w + x) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / 4);
      }
    }
  return { data: out, width: w, height: h };
}
export async function saveCore(path, pixels, width, height) {
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 1, adaptiveFiltering: false })
    .toBuffer();
  await atomicWrite(path, png);
}
const decoded = new Map();
async function loadCore(path) {
  let entry = decoded.get(path);
  if (entry) {
    decoded.delete(path);
    decoded.set(path, entry);
    return entry;
  }
  const { data, info } = await sharp(await readFile(path))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  entry = { data, width: info.width, height: info.height };
  decoded.set(path, entry);
  while (decoded.size > 24) decoded.delete(decoded.keys().next().value);
  return entry;
}
export function corePath(dir, world, level, x, y) {
  return resolve(dir, world, String(level), `${x}_${y}.png`);
}
async function gather(
  dir,
  world,
  level,
  levelWidth,
  levelHeight,
  left,
  top,
  width,
  height,
) {
  const data = Buffer.alloc(width * height * 4);
  for (
    let y = Math.floor(top / TILE);
    y <= Math.floor((top + height - 1) / TILE);
    y++
  )
    for (
      let x = Math.floor(left / TILE);
      x <= Math.floor((left + width - 1) / TILE);
      x++
    ) {
      if (x < 0 || y < 0 || x * TILE >= levelWidth || y * TILE >= levelHeight)
        continue;
      const image = await loadCore(corePath(dir, world, level, x, y));
      const x0 = Math.max(left, x * TILE),
        x1 = Math.min(left + width, x * TILE + image.width);
      const y0 = Math.max(top, y * TILE),
        y1 = Math.min(top + height, y * TILE + image.height);
      for (let wy = y0; wy < y1; wy++)
        image.data.copy(
          data,
          ((wy - top) * width + x0 - left) * 4,
          ((wy - y * TILE) * image.width + x0 - x * TILE) * 4,
          ((wy - y * TILE) * image.width + x1 - x * TILE) * 4,
        );
    }
  return data;
}
export async function makeParent(job) {
  const { data, width, height } = reduce2(
    await gather(
      job.cores,
      job.world,
      job.level + 1,
      job.childWidth,
      job.childHeight,
      job.tx * TILE * 2,
      job.ty * TILE * 2,
      job.width * 2,
      job.height * 2,
    ),
    job.width * 2,
    job.height * 2,
  );
  await saveCore(job.path, data, width, height);
}
export async function writeOverlap(job) {
  const left = Math.max(0, job.tx * TILE - OVERLAP),
    top = Math.max(0, job.ty * TILE - OVERLAP);
  const right = Math.min(job.levelWidth, (job.tx + 1) * TILE + OVERLAP),
    bottom = Math.min(job.levelHeight, (job.ty + 1) * TILE + OVERLAP);
  const width = right - left,
    height = bottom - top;
  const pixels = await gather(
    job.cores,
    job.world,
    job.level,
    job.levelWidth,
    job.levelHeight,
    left,
    top,
    width,
    height,
  );
  await atomicWrite(
    job.path,
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, effort: 0 })
      .toBuffer(),
  );
}
