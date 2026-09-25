import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { sceneInputFingerprint } from "./telescope-scene-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  target = resolve(root, "build_data/telescope-scenes");
const provenance = await sceneInputFingerprint(root);
try {
  const old = JSON.parse(
    await readFile(resolve(target, "manifest.json"), "utf8"),
  );
  if (old.provenance === provenance && old.version === 1) {
    for (const pack of Object.values(old.packs)) {
      const bytes = await readFile(resolve(target, pack.file));
      if (createHash("sha256").update(bytes).digest("hex") !== pack.sha256)
        throw new Error("Damaged prepared scenes");
    }
    console.log(
      "[scene assets] Source fingerprint unchanged; reusing both prepared scene packs.",
    );
    process.exit(0);
  }
} catch {
  /* Missing/stale assets are rebuilt from their public source inputs. */
}
const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-scene-bake-"));
try {
  await build({
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: bundle,
      copyPublicDir: false,
      rollupOptions: {
        input: resolve(root, "build_scripts/telescope-scene-fixture.ts"),
        preserveEntrySignatures: "strict",
        output: { entryFileNames: "scenes.js", manualChunks: () => undefined },
      },
    },
  });
  const manifest = { version: 1, provenance, packs: {} };
  await mkdir(target, { recursive: true });
  // Independent forks use two actual native threads, with no shared mutable
  // Telescope module state. The payload is transferred instead of cloned.
  await Promise.all(
    [false, true].map(async (fullPixels) => {
      const result = await new Promise((done, reject) => {
        const worker = new Worker(
          new URL("./telescope-scene-worker.mjs", import.meta.url),
          {
            workerData: { root, bundle, fullPixels, provenance },
            stdout: true,
            stderr: true,
          },
        );
        let output = "",
          result;
        for (const stream of [worker.stdout, worker.stderr])
          stream.on("data", (chunk) => {
            output = (output + chunk).slice(-6000);
          });
        const timeout = setTimeout(() => {
          void worker.terminate();
          reject(new Error("Scene bake timed out\n" + output));
        }, 120000);
        worker.on("message", (value) => {
          result = value;
        });
        worker.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        worker.on("exit", (code) => {
          clearTimeout(timeout);
          code || !result || result.error
            ? reject(
                new Error(
                  (result?.error || `Scene bake exit ${code}`) + "\n" + output,
                ),
              )
            : done(result);
        });
      });
      const key = fullPixels ? "full" : "approx",
        file = `${key}.bin.gz`;
      const compressed = gzipSync(result.bytes, { level: 9 });
      await writeFile(resolve(target, file), compressed);
      manifest.packs[key] = {
        file,
        scenes: result.scenes,
        packedBytes: result.bytes.length,
        compressedBytes: compressed.length,
        sourceBytes: result.sourceBytes,
        restoredBytes: result.restoredBytes,
        sha256: createHash("sha256").update(compressed).digest("hex"),
      };
      console.log(
        `[scene assets] ${key}: ${result.scenes} scenes; ${result.bytes.length} packed bytes, ${compressed.length} compressed bytes, ${result.restoredBytes} retained bytes; every scene byte/metadata field verified`,
      );
    }),
  );
  await writeFile(
    resolve(target, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
} finally {
  await rm(bundle, { recursive: true, force: true });
}
