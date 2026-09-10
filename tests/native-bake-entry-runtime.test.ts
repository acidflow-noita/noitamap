import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { deserialize } from "node:v8";

/** This deliberately runs the REAL CLI and its custom Vite chunking. The
 * renderer fixtures use different entrypoints/chunks and did not catch the
 * material-atlas -> MATERIAL_DATA top-level-await regression from CI. */
it("prepares the CI seed through the actual native bake entrypoint", async () => {
  const root = resolve(import.meta.dirname, "..");
  const out = await mkdtemp(resolve(tmpdir(), "noitamap-native-entry-"));
  try {
    const child = spawn(
      process.execPath,
      [
        "--enable-source-maps",
        resolve(root, "build_scripts/build-full-pixel-bake.mjs"),
        "--seed=1483922992",
        `--out=${out}`,
        "--concurrency=2",
        "--prepare-only",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    const append = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-60000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 240000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });
    expect(code, logs).toBe(0);
    const prepared = JSON.parse(
      await readFile(resolve(out, "prepared.json"), "utf8"),
    );
    expect(prepared).toMatchObject({
      seed: 1483922992,
      width: 35840,
      height: 73728,
    });
    const snapshot = deserialize(
      await readFile(resolve(out, "generation.bin")),
    );
    expect(snapshot.seed).toBe(1483922992);
    expect(Object.keys(snapshot.planes).sort()).toEqual(["-1", "0", "1"]);
    for (const plane of Object.values(snapshot.planes) as any[]) {
      expect(plane.tileLayers.length).toBeGreaterThan(0);
      expect(plane.biomeData.pixels.length).toBeGreaterThan(0);
    }
    expect(Object.keys(snapshot.sceneData.sources).length).toBeGreaterThan(0);
    expect(snapshot.decor.cells.length).toBeGreaterThan(0);
    expect(
      await stat(resolve(out, "seed.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 270000);
