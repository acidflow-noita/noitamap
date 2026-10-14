import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";
const environment = installNativeTerrainEnvironment({
  ...workerData,
  fullPixels: true,
  workerScript: new URL(
    "../../build_scripts/native-terrain-worker.mjs",
    import.meta.url,
  ),
});
let result;
let archive;
async function mainAsset(path) {
  archive ??= JSZip.loadAsync(
    await readFile(resolve(workerData.root, "public/data.zip")),
  );
  const file = (await archive).file(path);
  return file ? file.async("uint8array") : null;
}
try {
  const api = await import(pathToFileURL(workerData.entry).href);
  result = {
    ...(await api.verifyNativeComposition({
      revision: "explicit-scene-fixture",
      async read(path) {
        if (
          path.startsWith("data/biome_impl/biome_map") ||
          path.startsWith("data/biome_maps/") ||
          path.startsWith("data/backgrounds/") ||
          path.startsWith("data/weather_gfx/")
        ) {
          const main = await mainAsset(
            path
              .replace(/^data\/biome_maps\//, "data/biome_impl/")
              .replace(/^data\/backgrounds\//, "data/"),
          );
          if (main) return main;
        }
        try {
          return Uint8Array.from(
            await readFile(
              resolve(workerData.root, "lib/noita-telescope-vm", path),
            ),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          const file = await mainAsset(path);
          if (!file)
            throw new Error(`Missing explicit composition asset: ${path}`);
          return file;
        }
      },
    })),
    diagnostics: environment.diagnostics,
  };
} catch (error) {
  result = { error: error.stack };
} finally {
  environment.close();
}
parentPort.postMessage(result);
parentPort.close();
