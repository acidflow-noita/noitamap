#!/usr/bin/env node
/** Offline only: lossless map tiles from the owner's captured PNG. */
import sharp from "sharp";
import { createReadStream } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

export async function prepareCapturedMap(
  input,
  output,
  { originX = -17920, originY = -31744, tileSize = 512 } = {},
) {
  const root = resolve(output),
    source = resolve(input),
    info = await stat(source);
  await mkdir(root, { recursive: true });
  const hash = createHash("sha256");
  for await (const part of createReadStream(source)) hash.update(part);
  const sha256 = hash.digest("hex");
  try {
    const old = JSON.parse(await readFile(join(root, "source.json"), "utf8"));
    if (
      old.sha256 === sha256 &&
      old.tileSize === tileSize &&
      old.originX === originX &&
      old.originY === originY
    ) {
      await stat(join(root, "map.dzi"));
      console.log("Reusing the prepared captured-map tiles.");
      return old;
    }
  } catch {}
  const meta = await sharp(source, {
    limitInputPixels: false,
    sequentialRead: true,
  }).metadata();
  if (meta.format !== "png" || !meta.width || !meta.height)
    throw Error("Expected the captured PNG.");
  const temp = join(root, `.tiles-${process.pid}`);
  await mkdir(temp, { recursive: true });
  sharp.concurrency(2);
  sharp.cache({ memory: 64, files: 16, items: 32 });
  let peakRss = process.memoryUsage().rss;
  const started = Date.now();
  const monitor = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (peakRss > 3 * 1024 ** 3) {
      console.error(
        "Tiling exceeded the 3 GiB memory budget; stopping without publishing partial output.",
      );
      process.exit(1);
    }
    console.log(
      `Preparing tiles: ${Math.round((Date.now() - started) / 1000)}s, RSS ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MiB`,
    );
  }, 10000);
  try {
    await sharp(source, { limitInputPixels: false, sequentialRead: true })
      .webp({ lossless: true, effort: 1 })
      .tile({
        size: tileSize,
        overlap: 2,
        layout: "dz",
        depth: "onepixel",
        container: "fs",
      })
      .toFile(join(temp, "map.dz"));
    const maxLevel = Math.ceil(Math.log2(Math.max(meta.width, meta.height)));
    let tiles = 0;
    for (let level = 0; level <= maxLevel; level++) {
      const scale = 2 ** (maxLevel - level),
        expected =
          Math.ceil(Math.ceil(meta.width / scale) / tileSize) *
          Math.ceil(Math.ceil(meta.height / scale) / tileSize);
      const files = (
        await readdir(join(temp, "map_files", String(level)))
      ).filter((f) => f.endsWith(".webp"));
      if (files.length !== expected)
        throw Error(
          `Incomplete pyramid level ${level}: ${files.length}/${expected}`,
        );
      tiles += files.length;
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const data = {
      version: 1,
      sha256,
      sourceBytes: info.size,
      width: meta.width,
      height: meta.height,
      originX,
      originY,
      tileSize,
      overlap: 2,
      maxLevel,
      tiles,
      peakRss,
      elapsedMs: Date.now() - started,
    };
    await rm(join(temp, "map_files", "vips-properties.xml"), { force: true });
    // This is an offline draft directory. Replace only our previous generated map.
    await rm(join(root, "map_files"), { recursive: true, force: true });
    await rename(join(temp, "map_files"), join(root, "map_files"));
    await rename(join(temp, "map.dzi"), join(root, "map.dzi"));
    await rm(temp, { recursive: true, force: true });
    await writeFile(
      join(root, "source.json"),
      JSON.stringify(data, null, 2) + "\n",
    );
    console.log(JSON.stringify(data));
    return data;
  } finally {
    clearInterval(monitor);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((v) => {
      const i = v.indexOf("=");
      return [v.slice(2, i), v.slice(i + 1)];
    }),
  );
  await prepareCapturedMap(
    args.input || "task/guessr/full_map.png",
    args.out || "task/guessr/site/captured",
  );
}
