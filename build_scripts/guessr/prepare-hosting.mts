/** Prepare reviewed local artifacts for Pages + a private Worker binding.
 * This command never provisions or deploys Cloudflare resources. */
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { exportImageSet } from "./export-image-set.mjs";
import { prepareWorkerData } from "./prepare-worker-data.mts";
import { prepareFeaturelessViews } from './featureless-views.mts';

const sourceDirectory = resolve("task/guessr/site/captured");
const referenceDirectory = resolve("task/guessr/reference-site");
const images = await exportImageSet();
await prepareFeaturelessViews();
const index = JSON.parse(await readFile(images.privateIndexPath, "utf8"));
const count = Object.values(index.levels).reduce(
  (sum: number, level: any) => sum + Object.keys(level.images).length,
  0,
);
if (count + 1 > 20000 || images.stats.assets + 2 > 20000)
  throw new Error(
    "Prepared assets exceed the Pages Free file limit; do not enable a paid plan.",
  );

let linked = 0,
  reused = 0;
for (const [level, data] of Object.entries(index.levels) as [
  string,
  { images: Record<string, string> },
][]) {
  for (const coordinate of Object.keys(data.images)) {
    const [x, y] = coordinate.split(",");
    const relative = join("map_files", level, `${x}_${y}.webp`);
    const source = join(sourceDirectory, relative),
      destination = join(referenceDirectory, relative);
    const original = await stat(source);
    const old = await stat(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (old && old.ino === original.ino && old.dev === original.dev) {
      reused++;
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = destination + "." + randomUUID() + ".tmp";
    try {
      try {
        await link(source, temporary);
      } catch (error: any) {
        if (!["EXDEV", "EPERM", "EACCES"].includes(error.code)) throw error;
        await copyFile(source, temporary);
      }
      await rename(temporary, destination);
      linked++;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
await writeFile(
  join(referenceDirectory, "_headers"),
  `/map_files/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=86400
  X-Content-Type-Options: nosniff
`,
);
const worker = await prepareWorkerData({
  publicConfigPath: "public/guessr/config.json",
  referenceRoot: process.env.GUESSR_REFERENCE_ROOT,
});
console.log(
  JSON.stringify(
    {
      deployed: false,
      clues: {
        directory: images.publicDirectory,
        files: images.stats.assets + 2,
        writtenImages: images.stats.writtenAssets,
      },
      reference: {
        directory: referenceDirectory,
        files: count + 1,
        linked,
        reused,
      },
      privateWorker: worker,
      note: "Two separate Pages projects keep each image set within the free 20,000-file limit. Private Worker data must never be uploaded to Pages.",
    },
    null,
    2,
  ),
);
