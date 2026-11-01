#!/usr/bin/env node
/** Independent checks against the original PNG, bypassing the tile extractor. */
import sharp from "sharp";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const source = resolve("task/guessr/full_map.png"),
  site = resolve("task/guessr/site"),
  out = resolve("task/guessr/dataset");
await mkdir(out, { recursive: true });
const pack = JSON.parse(await readFile(join(site, "pack.json"), "utf8"));
const meta = JSON.parse(
  await readFile(join(site, "captured/source.json"), "utf8"),
);
const digest = createHash("sha256");
for await (const chunk of createReadStream(source)) digest.update(chunk);
const sha256 = digest.digest("hex");
if (sha256 !== meta.sha256)
  throw Error("Source PNG changed since tile preparation.");

const samples = pack.places.map((p) => ({ place: p, key: "0,0,0" }));
for (const id of [...pack.demo, "p-24", "p-28", "p-30"]) {
  const place = pack.places.find((p) => p.id === id);
  if (place) samples.push({ place, key: "1,-1,6" });
}
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 8, items: 16 });
let cursor = 0,
  peakRss = process.memoryUsage().rss;
const checks = [],
  started = Date.now();
const monitor = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 250);
try {
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < samples.length) {
        const { place, key } = samples[cursor++],
          [dx, dy] = key.split(",").map(Number),
          frame = place.views[key];
        const rect = {
          left: Math.floor(
            place.x + dx * pack.travelStep - pack.bounds.x - frame.width / 2,
          ),
          top: Math.floor(
            place.y + dy * pack.travelStep - pack.bounds.y - frame.height / 2,
          ),
          width: frame.width,
          height: frame.height,
        };
        const original = await sharp(source, {
          limitInputPixels: false,
          sequentialRead: true,
        })
          .extract(rect)
          .removeAlpha()
          .raw()
          .toBuffer();
        const clue = await sharp(join(site, frame.image))
          .removeAlpha()
          .raw()
          .toBuffer();
        const equal = original.equals(clue);
        checks.push({
          location: place.id,
          view: key,
          sourceRect: rect,
          bytes: original.length,
          equal,
        });
        console.log(
          `Original PNG ${checks.length}/${samples.length}: ${place.id}/${key} ${equal ? "MATCH" : "MISMATCH"}`,
        );
        if (!equal) throw Error(`Source RGB mismatch: ${place.id}/${key}`);
      }
    }),
  );
} finally {
  clearInterval(monitor);
}
checks.sort(
  (a, b) =>
    a.location.localeCompare(b.location) || a.view.localeCompare(b.view),
);
const result = {
  packVersion: pack.version,
  source: "../full_map.png",
  sha256,
  unchangedSinceTiling: true,
  checked: checks.length,
  matches: checks.filter((c) => c.equal).length,
  elapsedMs: Date.now() - started,
  peakRss,
  checks,
};
await writeFile(
  join(out, "source-validation.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify({ ...result, checks: undefined }));
