import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { prepareCapturedMap } from "../build_scripts/guessr/prepare-captured-map.mjs";
import { exportImageSet } from "../build_scripts/guessr/export-image-set.mjs";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "guessr-image-set-"));
  temporary.push(root);
  const width = 43,
    height = 71;
  const input = join(root, "secret-seed-12345.png");
  await sharp(
    Buffer.from(
      Array.from(
        { length: width * height * 3 },
        (_, i) => (i * 31 + Math.floor(i / 129)) % 256,
      ),
    ),
    { raw: { width, height, channels: 3 } },
  )
    .png()
    .toFile(input);
  const sourceDirectory = join(root, "source"),
    publicDirectory = join(root, "public"),
    privateIndexPath = join(root, "private", "index.json");
  const capture = await prepareCapturedMap(input, sourceDirectory, {
    originX: -40,
    originY: -50,
    tileSize: 16,
  });
  return { root, sourceDirectory, publicDirectory, privateIndexPath, capture };
}

describe("opaque whole-map image set", () => {
  it("exports every pyramid coordinate without changing a byte or exposing the private lookup", async () => {
    const f = await fixture();
    const result = await exportImageSet(f);
    const index = JSON.parse(await readFile(f.privateIndexPath, "utf8"));
    const dataset = JSON.parse(
      await readFile(join(f.publicDirectory, "dataset.json"), "utf8"),
    );
    expect(dataset).toEqual({
      version: result.dataset.version,
      bounds: { x: -40, y: -50, width: 43, height: 71 },
      map: {
        width: 43,
        height: 71,
        tileSize: 16,
        overlap: 2,
        maxLevel: 7,
        format: "webp",
      },
    });
    expect(dataset).toEqual(index.dataset);
    let tiles = 0;
    for (let level = 0; level <= f.capture.maxLevel; level++) {
      const info = index.levels[level];
      expect(Object.keys(info.images)).toHaveLength(info.columns * info.rows);
      for (let y = 0; y < info.rows; y++)
        for (let x = 0; x < info.columns; x++) {
          const id = info.images[`${x},${y}`];
          expect(id).toMatch(/^[a-f0-9]{32}$/);
          expect(
            await readFile(join(f.publicDirectory, "images", `${id}.webp`)),
          ).toEqual(
            await readFile(
              join(
                f.sourceDirectory,
                "map_files",
                String(level),
                `${x}_${y}.webp`,
              ),
            ),
          );
          tiles++;
        }
    }
    expect(tiles).toBe(f.capture.tiles);
    expect(result.stats.tiles).toBe(tiles);
    expect(await readdir(f.publicDirectory)).toEqual([
      "_headers",
      "dataset.json",
      "images",
    ]);
    const published = await readFile(
      join(f.publicDirectory, "dataset.json"),
      "utf8",
    );
    for (const forbidden of [
      "capture",
      "source",
      "sha256",
      "levels",
      "images",
      "seed",
      "index",
      "content",
    ])
      expect(published).not.toContain(`"${forbidden}"`);
    expect((await stat(f.privateIndexPath)).mode & 0o777).toBe(0o600);
    const files = await readdir(join(f.publicDirectory, "images"));
    expect(files.every((name) => /^[a-f0-9]{32}\.webp$/.test(name))).toBe(true);
    expect(files).toHaveLength(result.stats.assets);
    expect(
      await readFile(join(f.publicDirectory, "_headers"), "utf8"),
    ).toContain("immutable");
  });

  it("reuses stable image IDs, manifest version and existing files on a rerun", async () => {
    const f = await fixture(),
      first = await exportImageSet(f);
    const indexBytes = await readFile(f.privateIndexPath),
      datasetBytes = await readFile(join(f.publicDirectory, "dataset.json"));
    const id = Object.keys(first.index.images)[0],
      file = join(f.publicDirectory, "images", `${id}.webp`),
      before = await stat(file);
    const second = await exportImageSet(f);
    expect(second.dataset).toEqual(first.dataset);
    expect(second.index).toEqual(first.index);
    expect(second.stats).toMatchObject({
      writtenAssets: 0,
      reusedAssets: first.stats.assets,
      indexedContent: 0,
    });
    expect(await readFile(f.privateIndexPath)).toEqual(indexBytes);
    expect(await readFile(join(f.publicDirectory, "dataset.json"))).toEqual(
      datasetBytes,
    );
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("upgrades an existing export with private native-pixel metadata without changing public assets", async () => {
    const f = await fixture(),
      first = await exportImageSet(f);
    const old = JSON.parse(await readFile(f.privateIndexPath, "utf8"));
    delete old.contentVersion;
    for (const image of Object.values(old.images) as any[])
      delete image.content;
    await writeFile(f.privateIndexPath, JSON.stringify(old));
    const upgraded = await exportImageSet(f);
    expect(upgraded.dataset).toEqual(first.dataset);
    expect(upgraded.stats.writtenAssets).toBe(0);
    expect(upgraded.stats.indexedContent).toBeGreaterThan(0);
    const upgradedIndex = JSON.parse(await readFile(f.privateIndexPath, "utf8"));
    expect(upgradedIndex.contentVersion).toBe(2);
    for (const id of Object.values(
      upgradedIndex.levels[f.capture.maxLevel].images,
    ) as string[]) {
      expect(upgradedIndex.images[id].content).toBeDefined();
    }
  });

  it("rejects an incomplete pyramid before publishing and preserves an earlier complete publication", async () => {
    const f = await fixture();
    const sourceTile = join(
      f.sourceDirectory,
      "map_files",
      String(f.capture.maxLevel),
      "0_0.webp",
    );
    const tile = await readFile(sourceTile);
    await rm(sourceTile);
    await expect(exportImageSet(f)).rejects.toThrow("Incomplete pyramid");
    await expect(
      stat(join(f.publicDirectory, "dataset.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.privateIndexPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(sourceTile, tile);
    await exportImageSet(f);
    const manifest = await readFile(join(f.publicDirectory, "dataset.json")),
      index = await readFile(f.privateIndexPath);
    await rm(sourceTile);
    await expect(exportImageSet(f)).rejects.toThrow("Incomplete pyramid");
    expect(await readFile(join(f.publicDirectory, "dataset.json"))).toEqual(
      manifest,
    );
    expect(await readFile(f.privateIndexPath)).toEqual(index);
  });

  it("rejects wrong dimensions and EXIF/XMP instead of altering source images", async () => {
    const f = await fixture();
    const path = join(
      f.sourceDirectory,
      "map_files",
      String(f.capture.maxLevel),
      "0_0.webp",
    );
    const original = await readFile(path);
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .webp({ lossless: true })
      .toFile(path);
    await expect(exportImageSet(f)).rejects.toThrow(
      "Incorrect tile dimensions",
    );
    const tagged = await sharp(original)
      .withExif({ IFD0: { ImageDescription: "seed12345 x0 y0" } })
      .webp({ lossless: true })
      .toBuffer();
    await writeFile(path, tagged);
    await expect(exportImageSet(f)).rejects.toThrow("Private image metadata");
    expect(await readFile(path)).toEqual(tagged);
    const payload = Buffer.from("private seed and coordinates");
    const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
    chunk.write("XMP ", 0, "ascii");
    chunk.writeUInt32LE(payload.length, 4);
    payload.copy(chunk, 8);
    const withXmp = Buffer.concat([original, chunk]);
    withXmp.writeUInt32LE(withXmp.length - 8, 4);
    await writeFile(path, withXmp);
    await expect(exportImageSet(f)).rejects.toThrow("Private image metadata");
    expect(await readFile(path)).toEqual(withXmp);
    await expect(
      stat(join(f.publicDirectory, "dataset.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the private coordinate index separate even through a symlink", async () => {
    const f = await fixture();
    await expect(
      exportImageSet({
        ...f,
        privateIndexPath: join(f.publicDirectory, "secret.json"),
      }),
    ).rejects.toThrow("separate paths");
    await expect(
      exportImageSet({ ...f, publicDirectory: f.root }),
    ).rejects.toThrow("separate paths");
    const alias = join(f.root, "alias");
    await symlink(f.publicDirectory, alias);
    await expect(
      exportImageSet({ ...f, privateIndexPath: join(alias, "secret.json") }),
    ).rejects.toThrow("separate paths");
  });
});
