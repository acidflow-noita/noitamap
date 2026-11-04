#!/usr/bin/env node
/** Publish an existing lossless pyramid once, without exposing its tile coordinates. */
import sharp from "sharp";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateOutput } from "./private-output.mjs";
import { compactImageContent, imageContent } from "./image-content.mjs";

const OPAQUE_ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const HEADERS = `/images/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
/dataset.json
  Cache-Control: no-cache
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
`;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const opaque = () => randomBytes(16).toString("hex");
function within(parent, child) {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")))
  );
}

// Resolve existing ancestors too, so a symlink cannot put the private index in public output.
async function physical(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const link = await lstat(path).catch((failure) => {
      if (failure.code === "ENOENT") return null;
      throw failure;
    });
    if (link?.isSymbolicLink())
      return physical(resolve(dirname(path), await readlink(path)));
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physical(parent), relative(parent, path));
  }
}

async function optionalBytes(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, bytes, mode = 0o644) {
  const previous = await optionalBytes(path);
  if (previous?.equals(Buffer.from(bytes))) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.guessr-${opaque()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

function readCapture(raw) {
  for (const name of ["width", "height", "tileSize"])
    if (!Number.isSafeInteger(raw[name]) || raw[name] <= 0)
      throw Error(`Invalid capture ${name}.`);
  for (const name of ["originX", "originY", "overlap", "maxLevel"])
    if (!Number.isSafeInteger(raw[name]))
      throw Error(`Invalid capture ${name}.`);
  if (raw.overlap < 0 || raw.overlap >= raw.tileSize)
    throw Error("Invalid capture overlap.");
  if (raw.maxLevel !== Math.ceil(Math.log2(Math.max(raw.width, raw.height))))
    throw Error("Capture maxLevel does not cover the native image.");
  if (!DIGEST.test(raw.sha256))
    throw Error("Capture requires its source SHA-256.");
  return raw;
}

function checkWebpChunks(bytes, filename) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw Error(`Invalid WebP container: ${filename}`);
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length)
      throw Error(`Truncated WebP chunk: ${filename}`);
    const kind = bytes.toString("ascii", offset, offset + 4);
    if (kind === "EXIF" || kind === "XMP ")
      throw Error(
        `Private image metadata (${kind.trim()}) is not allowed: ${filename}`,
      );
    if (!["VP8 ", "VP8L", "VP8X", "ALPH", "ICCP"].includes(kind))
      throw Error(`Unsupported WebP chunk ${kind}: ${filename}`);
    const length = bytes.readUInt32LE(offset + 4);
    offset += 8 + length + (length % 2);
    if (offset > bytes.length)
      throw Error(`Truncated WebP payload: ${filename}`);
  }
}

/**
 * Public: dataset.json, _headers, images/<opaque ID>.webp.
 * Private: levels[level].images["column,row"] -> opaque ID, capture metadata,
 * and images[ID] -> source digest/dimensions. No recutting or re-encoding occurs.
 */
export async function exportImageSet({
  sourceDirectory = "task/guessr/site/captured",
  publicDirectory = "task/guessr/opaque-site",
  privateIndexPath = "task/guessr/private/image-set.json",
  onProgress = (_stats) => {},
} = {}) {
  const source = await physical(resolve(sourceDirectory));
  const destination = await physical(resolve(publicDirectory));
  const privatePath = await physical(privateOutput(privateIndexPath));
  privateOutput(privatePath);
  if (
    within(destination, privatePath) ||
    within(dirname(privatePath), destination) ||
    within(source, destination) ||
    within(destination, source)
  )
    throw Error(
      "Source, public images and private index must have separate paths.",
    );
  const capture = readCapture(
    JSON.parse(await readFile(join(source, "source.json"), "utf8")),
  );
  const descriptor = await readFile(join(source, "map.dzi"), "utf8");
  for (const [attribute, value] of Object.entries({
    Format: "webp",
    TileSize: capture.tileSize,
    Overlap: capture.overlap,
    Width: capture.width,
    Height: capture.height,
  })) {
    if (
      new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`).exec(
        descriptor,
      )?.[1] !== String(value)
    )
      throw Error(
        `Capture descriptor disagrees with source.json: ${attribute}.`,
      );
  }

  const previousBytes = await optionalBytes(privatePath);
  const previous = previousBytes
    ? JSON.parse(previousBytes.toString("utf8"))
    : null;
  if (previous && previous.schemaVersion !== 1)
    throw Error("Unsupported private image-set index.");
  const known = new Map();
  for (const [id, info] of Object.entries(previous?.images || {})) {
    if (!OPAQUE_ID.test(id) || !DIGEST.test(info.sha256))
      throw Error("Malformed private image-set record.");
    known.set(info.sha256, id);
  }

  // Check every expected coordinate before writing any public asset or manifest.
  const levels = {},
    tiles = [];
  for (let level = 0; level <= capture.maxLevel; level++) {
    const scale = 2 ** (capture.maxLevel - level);
    const width = Math.ceil(capture.width / scale),
      height = Math.ceil(capture.height / scale);
    const columns = Math.ceil(width / capture.tileSize),
      rows = Math.ceil(height / capture.tileSize);
    const directory = join(source, "map_files", String(level));
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT")
        throw Error(`Incomplete pyramid: missing level ${level}.`);
      throw error;
    }
    const actual = new Set(names.filter((name) => name.endsWith(".webp")));
    if (actual.size !== columns * rows)
      throw Error(
        `Incomplete pyramid level ${level}: ${actual.size}/${columns * rows} tiles.`,
      );
    const images = {};
    levels[level] = { width, height, columns, rows, images };
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        const name = `${x}_${y}.webp`;
        if (!actual.has(name))
          throw Error(`Incomplete pyramid: missing ${level}/${name}.`);
        const left = Math.max(0, x * capture.tileSize - capture.overlap);
        const top = Math.max(0, y * capture.tileSize - capture.overlap);
        tiles.push({
          level,
          x,
          y,
          path: join(directory, name),
          width:
            Math.min(width, (x + 1) * capture.tileSize + capture.overlap) -
            left,
          height:
            Math.min(height, (y + 1) * capture.tileSize + capture.overlap) -
            top,
        });
      }
  }
  if (capture.tiles !== undefined && capture.tiles !== tiles.length)
    throw Error(
      `Capture tile count disagrees with pyramid: ${capture.tiles}/${tiles.length}.`,
    );

  const images = {},
    fingerprint = createHash("sha256");
  fingerprint.update(
    JSON.stringify({
      sha256: capture.sha256,
      width: capture.width,
      height: capture.height,
      originX: capture.originX,
      originY: capture.originY,
      tileSize: capture.tileSize,
      overlap: capture.overlap,
      maxLevel: capture.maxLevel,
    }),
  );
  const stats = {
    tiles: tiles.length,
    assets: 0,
    bytes: 0,
    writtenAssets: 0,
    reusedAssets: 0,
    indexedContent: 0,
  };
  for (const tile of tiles) {
    const bytes = await readFile(tile.path);
    checkWebpChunks(bytes, tile.path);
    const digest = hash(bytes);
    const id = known.get(digest) || opaque();
    known.set(digest, id);
    if (!images[id]) {
      const metadata = await sharp(bytes).metadata();
      if (
        metadata.exif ||
        metadata.xmp ||
        metadata.iptc ||
        metadata.comments?.length
      )
        throw Error(`Private image metadata is not allowed: ${tile.path}`);
      if (
        metadata.format !== "webp" ||
        metadata.pages > 1 ||
        metadata.width !== tile.width ||
        metadata.height !== tile.height
      )
        throw Error(`Incorrect tile dimensions or format: ${tile.path}`);
      images[id] = {
        sha256: digest,
        width: metadata.width,
        height: metadata.height,
        bytes: bytes.length,
      };
      const target = join(destination, "images", `${id}.webp`);
      const written = await atomicWrite(target, bytes);
      stats[written ? "writtenAssets" : "reusedAssets"]++;
      stats.assets++;
      stats.bytes += bytes.length;
    } else if (
      images[id].width !== tile.width ||
      images[id].height !== tile.height
    ) {
      throw Error(`Incorrect reused tile dimensions: ${tile.path}`);
    }
    if (tile.level === capture.maxLevel && images[id].content === undefined) {
      const cached = [1, 2].includes(previous?.contentVersion)
        ? previous.images[id]?.content
        : undefined;
      if (cached !== undefined)
        images[id].content = compactImageContent(cached);
      else {
        const { data, info } = await sharp(bytes)
          .toColourspace("srgb")
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        images[id].content = compactImageContent(
          imageContent(data, info.width, info.height),
        );
        stats.indexedContent++;
      }
    }
    levels[tile.level].images[`${tile.x},${tile.y}`] = id;
    fingerprint.update(`${tile.level}/${tile.x}/${tile.y}:${digest}\n`);
    onProgress(stats);
  }
  const identity = fingerprint.digest("hex");
  const version =
    previous?.fingerprint === identity
      ? previous.version
      : `guessr-images-${opaque()}`;
  if (!/^guessr-images-[a-f0-9]{32}$/.test(version))
    throw Error("Malformed image-set version.");
  const dataset = {
    version,
    bounds: {
      x: capture.originX,
      y: capture.originY,
      width: capture.width,
      height: capture.height,
    },
    map: {
      width: capture.width,
      height: capture.height,
      tileSize: capture.tileSize,
      overlap: capture.overlap,
      maxLevel: capture.maxLevel,
      format: "webp",
    },
  };
  const index = {
    schemaVersion: 1,
    contentVersion: 2,
    version,
    capture,
    dataset,
    levels,
    images,
    fingerprint: identity,
  };
  // Assets are complete first. Each file is published by rename; dataset.json is last.
  await atomicWrite(privatePath, JSON.stringify(index, null, 2) + "\n", 0o600);
  await atomicWrite(join(destination, "_headers"), HEADERS);
  await atomicWrite(
    join(destination, "dataset.json"),
    JSON.stringify(dataset, null, 2) + "\n",
  );
  return {
    dataset,
    index,
    stats,
    publicDirectory: destination,
    privateIndexPath: privatePath,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = {};
  const names = {
    source: "sourceDirectory",
    public: "publicDirectory",
    private: "privateIndexPath",
  };
  for (const argument of process.argv.slice(2)) {
    const match = /^--(source|public|private)=(.+)$/.exec(argument);
    if (!match)
      throw Error(
        "Usage: export-image-set.mjs [--source=DIR] [--public=DIR] [--private=FILE]",
      );
    options[names[match[1]]] = match[2];
  }
  const result = await exportImageSet(options);
  console.log(
    JSON.stringify(
      {
        version: result.dataset.version,
        ...result.stats,
        publicDirectory: result.publicDirectory,
        privateIndexPath: result.privateIndexPath,
      },
      null,
      2,
    ),
  );
}
