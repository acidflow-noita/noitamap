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
    h = Math.ceil(height / 2);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row0 = y * 2 * width * 4,
      row1 = row0 + width * 4;
    const secondRow = y * 2 + 1 < height;
    for (let x = 0; x < w; x++) {
      const p0 = row0 + x * 8,
        p1 = p0 + 4,
        p2 = row1 + x * 8,
        p3 = p2 + 4;
      const secondCol = x * 2 + 1 < width,
        target = (y * w + x) * 4;
      const a0 = pixels[p0 + 3],
        a1 = secondCol ? pixels[p1 + 3] : 0;
      const a2 = secondRow ? pixels[p2 + 3] : 0,
        a3 = secondRow && secondCol ? pixels[p3 + 3] : 0;
      const alpha = a0 + a1 + a2 + a3;
      if (!alpha) continue;
      if (alpha === 1020) {
        out[target] =
          (pixels[p0] + pixels[p1] + pixels[p2] + pixels[p3] + 2) >> 2;
        out[target + 1] =
          (pixels[p0 + 1] +
            pixels[p1 + 1] +
            pixels[p2 + 1] +
            pixels[p3 + 1] +
            2) >>
          2;
        out[target + 2] =
          (pixels[p0 + 2] +
            pixels[p1 + 2] +
            pixels[p2 + 2] +
            pixels[p3 + 2] +
            2) >>
          2;
        out[target + 3] = 255;
      } else {
        for (let c = 0; c < 3; c++) {
          let sum = pixels[p0 + c] * a0;
          if (a1) sum += pixels[p1 + c] * a1;
          if (a2) sum += pixels[p2 + c] * a2;
          if (a3) sum += pixels[p3 + c] * a3;
          out[target + c] = Math.round(sum / alpha);
        }
        out[target + 3] = (alpha + 2) >> 2;
      }
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
