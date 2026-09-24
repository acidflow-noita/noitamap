import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { deserialize } from "node:v8";
import { writeBakedWorldMetadata, readBakedWorldMetadata, REPORT_INVENTORY_VERSION } from "../build_scripts/baked-world-metadata.mjs";
import { hydrateBakedGeneration } from "../src/telescope/baked-generation";
import { createReportInventorySnapshot, readReportInventorySnapshot, reportFindInventory, reportInventoryCount } from "../src/report-inventory";
import { getAllPOIsFlat } from "../src/telescope/poi-inventory";
import { planeAtWorldY } from "../src/telescope/terrain-planes";

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
    expect(snapshot.decor.mimicSpritesVersion).toBe(1);
    expect(snapshot.metadata).toMatchObject({ version: 1, seed: snapshot.seed, ngPlus: 0, isNGP: false,
      worldSize: 70, worldCenter: 35, biomeDataW: 70, biomeDataH: 48, mimicSpritesVersion: 1 });
    expect(readReportInventorySnapshot(snapshot.metadata.reportInventory, snapshot.seed, [-1, 0, 1])).not.toBeNull();
    expect(REPORT_INVENTORY_VERSION).toBe(3);
    expect(snapshot.metadata.reportInventory.version).toBe(REPORT_INVENTORY_VERSION);

    // Exercise the SAME writer as final production publication. Keep these
    // metadata-only files isolated: they are not finished terrain artifacts.
    const metadataRoot = resolve(out, "metadata-test"), files = [];
    for (const [world, pw] of [["left", -1], ["middle", 0], ["right", 1]] as const) {
      await writeBakedWorldMetadata(metadataRoot, world, snapshot.metadata, snapshot.seed);
      const file = await readBakedWorldMetadata(metadataRoot, world, snapshot.seed);
      files.push(file);
      expect(file.parallelWorlds).toEqual([pw]);
      expect(file.mimicSpritesVersion).toBe(1);
      expect(Object.keys(file.reportInventory.worlds)).toEqual([String(pw)]);
      expect(Object.keys(file.poisByPW).every(key => Number(key.split(",")[0]) === pw)).toBe(true);
      expect(Object.keys(file.pixelScenesByPW).every(key => Number(key.split(",")[0]) === pw)).toBe(true);
      const hydrated = hydrateBakedGeneration([file]), pois = getAllPOIsFlat(hydrated);
      expect(hydrated.reportInventory).toEqual(createReportInventorySnapshot(snapshot.seed, pois, [pw]));
      // Vertical planes are concatenated into each horizontal world's POI
      // bucket, so verify actual positions rather than demanding nine keys.
      for (const plane of [-1, 0, 1]) expect(pois.some(poi => planeAtWorldY(poi.worldY) === plane)).toBe(true);
      expect(reportInventoryCount(hydrated.reportInventory!, [pw], "spells")).toBeGreaterThan(0);
      expect(reportInventoryCount(hydrated.reportInventory!, [pw], "materials")).toBeGreaterThan(0);
      await expect(stat(resolve(metadataRoot, world, "manifest.json"))).rejects.toThrow();
    }
    const combined = hydrateBakedGeneration(files);
    expect(combined.reportInventory).toEqual(snapshot.metadata.reportInventory);
    expect(combined.reportInventory).toEqual(createReportInventorySnapshot(snapshot.seed, getAllPOIsFlat(combined), [-1, 0, 1]));
    const pois = getAllPOIsFlat(combined), finds = reportFindInventory(pois);
    for (const biome of ["mountain_tree", "ocarina"]) {
      const instruments = pois.filter(poi => poi.type === "shop" && poi.biome === biome);
      expect(instruments.length).toBeGreaterThan(0);
      expect(finds.some(poi => poi.type === "shop" && poi.biome === biome)).toBe(false);
    }
    await expect(stat(resolve(metadataRoot, "seed.txt"))).rejects.toThrow();

    // Refuse mismatched/incomplete reports before overwriting usable output.
    await expect(writeBakedWorldMetadata(metadataRoot, "middle", snapshot.metadata, snapshot.seed + 1)).rejects.toThrow();
    await expect(writeBakedWorldMetadata(metadataRoot, "middle", { ...snapshot.metadata, reportInventory: undefined }, snapshot.seed)).rejects.toThrow();
    for (const version of [1, 2]) {
      await expect(writeBakedWorldMetadata(metadataRoot, "middle", { ...snapshot.metadata,
        reportInventory: { ...snapshot.metadata.reportInventory, version } }, snapshot.seed)).rejects.toThrow(/report inventory/);
    }
    expect(await readBakedWorldMetadata(metadataRoot, "middle", snapshot.seed)).toEqual(files[1]);
    const legacy = { ...files[1] };
    delete legacy.mimicSpritesVersion;
    await writeFile(resolve(metadataRoot, "middle", "generation.json"), JSON.stringify(legacy));
    expect((await readBakedWorldMetadata(metadataRoot, "middle", snapshot.seed)).mimicSpritesVersion).toBeUndefined();
    for (const version of [1, 2]) {
      await writeFile(resolve(metadataRoot, "middle", "generation.json"), JSON.stringify({ ...files[1],
        reportInventory: { ...files[1].reportInventory, version } }));
      await expect(readBakedWorldMetadata(metadataRoot, "middle", snapshot.seed)).rejects.toThrow(/report inventory/);
    }
    // This reader is also used by the completed-bake resume path: lost or
    // corrupted metadata cannot be reported as an already-complete bake.
    await writeFile(resolve(metadataRoot, "middle", "generation.json"), JSON.stringify({ ...files[1], reportInventory: undefined }));
    await expect(readBakedWorldMetadata(metadataRoot, "middle", snapshot.seed)).rejects.toThrow(/report inventory/);
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
