import { parentPort, workerData } from "node:worker_threads";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { saveCore, makeParent, writeOverlap } from "./terrain-pyramid.mjs";
import { pathToFileURL } from "node:url";
import { deserialize, serialize } from "node:v8";
import sharp from "sharp";
import { installNativeTerrainEnvironment } from "./native-terrain-environment.mjs";
const env = installNativeTerrainEnvironment({
  ...workerData,
  workerScript: new URL(import.meta.url),
  fullPixels: true,
});
try {
  if (workerData.role === "web-worker") {
    globalThis.postMessage = (data, transfers = []) =>
      parentPort.postMessage(data, transfers);
    await import(pathToFileURL(workerData.entry).href);
    parentPort.on("message", (data) => globalThis.onmessage({ data }));
    parentPort.postMessage({ __ready: true });
  } else {
    const api = await import(pathToFileURL(workerData.entry).href);
    if (workerData.role === "prepare") {
      const snapshot = await api.prepareBake(workerData.seed);
      await env.waitImages();
      env.restoreProcess();
      const decorDir = workerData.snapshot + ".decor";
      await mkdir(decorDir, { recursive: true });
      let done = 0;
      for (const cell of snapshot.decor.cells) {
        const url = await api.exportBakeDecoration(cell.cx, cell.cy);
        if (!url)
          throw new Error(`Missing decoration cell ${cell.cx},${cell.cy}`);
        await writeFile(
          `${decorDir}/${cell.cx}_${cell.cy}.png`,
          Buffer.from(url.split(",")[1], "base64"),
        );
        if (++done % 100 === 0)
          console.log(
            `[full-pixel bake] decorations ${done}/${snapshot.decor.cells.length}`,
          );
      }
      await writeFile(workerData.snapshot, serialize(snapshot));
      parentPort.postMessage({
        type: "prepared",
        seed: snapshot.seed,
        width: snapshot.width,
        height: snapshot.height,
        version: snapshot.version,
      });
      env.close();
    } else {
      const snapshot =
        workerData.role === "render"
          ? deserialize(await readFile(workerData.snapshot))
          : null;
      const renderer = snapshot ? await api.openBakeRenderer(snapshot) : null;
      env.restoreProcess();
      sharp.concurrency(1);
      const decorCache = new Map();
      async function decorate(pixels, job) {
        if (!snapshot?.decor) return pixels;
        const size = snapshot.decor.cellSize,
          dir = workerData.snapshot + ".decor";
        const allowed = new Set(
          snapshot.decor.cells.map((c) => `${c.cx}_${c.cy}`),
        );
        for (
          let cy = Math.floor(job.y / size);
          cy <= Math.floor((job.y + job.height - 1) / size);
          cy++
        )
          for (
            let cx = Math.floor(job.x / size);
            cx <= Math.floor((job.x + job.width - 1) / size);
            cx++
          ) {
            const key = `${cx}_${cy}`;
            if (!allowed.has(key)) continue;
            let image = decorCache.get(key);
            if (!image) {
              const { data, info } = await sharp(
                await readFile(resolve(dir, key + ".png")),
              )
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              image = { data, width: info.width, height: info.height };
              decorCache.set(key, image);
              while (decorCache.size > 6)
                decorCache.delete(decorCache.keys().next().value);
            }
            const x0 = Math.max(job.x, cx * size),
              x1 = Math.min(job.x + job.width, (cx + 1) * size),
              y0 = Math.max(job.y, cy * size),
              y1 = Math.min(job.y + job.height, (cy + 1) * size);
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++) {
                const s = ((y - cy * size) * image.width + x - cx * size) * 4,
                  d = ((y - job.y) * job.width + x - job.x) * 4,
                  a = image.data[s + 3];
                if (!a) continue;
                const wa = pixels[d + 3] * (255 - a),
                  total = a * 255 + wa;
                for (let c = 0; c < 3; c++)
                  pixels[d + c] = Math.round(
                    (image.data[s + c] * a * 255 + pixels[d + c] * wa) / total,
                  );
                pixels[d + 3] = Math.round(total / 255);
              }
          }
        return pixels;
      }
      parentPort.postMessage({ type: "ready" });
      parentPort.on("message", async (job) => {
        try {
          if (job.kind === "render") {
            const pixels = await decorate(
              renderer.render(job.x, job.y, job.width, job.height),
              job,
            );
            await saveCore(job.path, pixels, job.width, job.height);
          } else if (job.kind === "parent") await makeParent(job);
          else if (job.kind === "overlap") await writeOverlap(job);
          else throw new Error(`Unknown bake task ${job.kind}`);
          parentPort.postMessage({ type: "done", id: job.id });
        } catch (error) {
          parentPort.postMessage({
            type: "error",
            id: job.id,
            error: error.stack,
          });
        }
      });
    }
  }
} catch (error) {
  parentPort.postMessage({ type: "error", error: error.stack });
  env.close();
}
