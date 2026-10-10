import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { deserialize } from "node:v8";
import { writeBakedWorldMetadata, readBakedWorldMetadata, REPORT_INVENTORY_VERSION } from "../build_scripts/baked-world-metadata.mjs";
import { hydrateBakedGeneration } from "../src/telescope/baked-generation";
import { createReportInventorySnapshot, readReportInventorySnapshot, reportFindInventory, reportInventoryCount } from "../src/report-inventory";
import { getAllPOIsFlat } from "../src/telescope/poi-inventory";
import { planeAtWorldY } from "../src/telescope/terrain-planes";

async function runBake(root: string, out: string, extra: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      resolve(root, "build_scripts/build-full-pixel-bake.mjs"),
      "--seed=1483922992",
      `--out=${out}`,
      "--concurrency=2",
      "--prepare-only",
      ...extra,
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
  return { code, logs };
}

/** Run the REAL CLI/custom Vite chunking in an isolated copy without generated
 * scene packs. Local prepared assets previously hid the clean-CI build failure.
 * Also guards the material-atlas -> MATERIAL_DATA top-level-await regression. */
it("prepares missing scene assets and the CI seed through the actual native bake entrypoint", async () => {
  const source = resolve(import.meta.dirname, "..");
  const root = await mkdtemp(resolve(tmpdir(), "noitamap-native-entry-"));
  const out = resolve(root, "bake");
  try {
    for (const path of ["package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
      "src", "build_scripts", "public", "lib/noita-telescope", "lib/noita-telescope-vm"]) {
      // Real files preserve Vite's root-relative transforms; symlinked forks do not.
      await cp(resolve(source, path), resolve(root, path), { recursive: true, mode: constants.COPYFILE_FICLONE });
    }
    await symlink(resolve(source, "node_modules"), resolve(root, "node_modules"), "dir");
    const scenes = resolve(root, "build_data/telescope-scenes");
    await expect(stat(scenes)).rejects.toMatchObject({ code: "ENOENT" });

    const { code, logs } = await runBake(root, out);
    expect(code, logs).toBe(0);
    const manifest = JSON.parse(await readFile(resolve(scenes, "manifest.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.packs).sort()).toEqual(["approx", "full"]);
    const sceneFiles = ["manifest.json"];
    for (const pack of Object.values(manifest.packs) as any[]) {
      expect(pack.scenes).toBeGreaterThan(0);
      const bytes = await readFile(resolve(scenes, pack.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(pack.sha256);
      sceneFiles.push(pack.file);
    }
    const sceneTimes = await Promise.all(sceneFiles.map(async file => (await stat(resolve(scenes, file))).mtimeMs));
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

    // An up-to-date pack is reused, and the child script's successful early
    // exit must not terminate the parent baker before it validates the resumed
    // seed and writes its completion result. Avoid rendering decorations twice.
    await rm(resolve(out, "benchmark.json"));
    const reused = await runBake(root, out, ["--resume"]);
    expect(reused.code, reused.logs).toBe(0);
    expect(JSON.parse(await readFile(resolve(out, "benchmark.json"), "utf8"))).toMatchObject({
      seed: 1483922992, prepareOnly: true, resumed: true,
    });
    expect(await Promise.all(sceneFiles.map(async file => (await stat(resolve(scenes, file))).mtimeMs))).toEqual(sceneTimes);

    // A real preparation failure must stop the bake, even with old packs on disk.
    await rm(resolve(root, "public/pixel_scenes.zip"));
    const failedOut = resolve(root, "bake-failure"), failed = await runBake(root, failedOut);
    expect(failed.code, failed.logs).toBe(1);
    expect(failed.logs).toContain("pixel_scenes.zip");
    await expect(stat(resolve(failedOut, "runtime/bake.js"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(failedOut, "seed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 270000);
