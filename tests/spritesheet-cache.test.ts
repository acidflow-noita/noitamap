import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { spritesheetInputFingerprint, hasCurrentSpritesheet, saveSpritesheetCache } =
  createRequire(import.meta.url)("../build_scripts/spritesheet-cache.cjs");
const inputs = [
  "public/data.zip",
  "build_scripts/build-spritesheet.cjs",
  "build_scripts/spell-card-sprites.cjs",
  "build_scripts/spritesheet-cache.cjs",
  "package-lock.json",
  "src/material-icons/Materialpotion_water.png",
];
const outputs = [
  "public/assets/spritesheet.png",
  "public/assets/atlas.json",
  "src/data/atlas.json",
  "src/data/spritesheet-revision.json",
];
let root: string;
let fingerprint: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "noitamap-spritesheet-cache-"));
  for (const file of [...inputs, ...outputs]) {
    const target = join(root, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "before");
  }
  fingerprint = spritesheetInputFingerprint(root);
  saveSpritesheetCache(root, fingerprint);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("spritesheet build cache", () => {
  it("reuses unchanged inputs and all four intact outputs without rewriting them", () => {
    const before = outputs.map(file => statSync(join(root, file)).mtimeMs);
    expect(spritesheetInputFingerprint(root)).toBe(fingerprint);
    expect(hasCurrentSpritesheet(root, fingerprint)).toBe(true);
    expect(outputs.map(file => statSync(join(root, file)).mtimeMs)).toEqual(before);
  });

  it.each(inputs)("invalidates changed input bytes even with unchanged size and mtime: %s", file => {
    const target = join(root, file);
    const before = statSync(target);
    writeFileSync(target, "after!");
    utimesSync(target, before.atime, before.mtime);
    const changed = spritesheetInputFingerprint(root);
    expect(changed).not.toBe(fingerprint);
    expect(hasCurrentSpritesheet(root, changed)).toBe(false);
  });

  it("invalidates added and removed material icons", () => {
    const extra = join(root, "src/material-icons/Materialpouch_sand.png");
    writeFileSync(extra, "new icon");
    expect(hasCurrentSpritesheet(root, spritesheetInputFingerprint(root))).toBe(false);
    rmSync(extra);
    expect(spritesheetInputFingerprint(root)).toBe(fingerprint);
    rmSync(join(root, inputs.at(-1)!));
    expect(hasCurrentSpritesheet(root, spritesheetInputFingerprint(root))).toBe(false);
  });

  it.each(outputs)("rejects a corrupt or missing output: %s", file => {
    const target = join(root, file);
    const original = readFileSync(target);
    writeFileSync(target, "after!");
    expect(hasCurrentSpritesheet(root, fingerprint)).toBe(false);
    writeFileSync(target, original);
    expect(hasCurrentSpritesheet(root, fingerprint)).toBe(true);
    rmSync(target);
    expect(hasCurrentSpritesheet(root, fingerprint)).toBe(false);
  });

  it("treats missing, partial, and incompatible cache records as misses", () => {
    const cache = join(root, "node_modules/.cache/noitamap/spritesheet.json");
    for (const data of ["{", "{}", JSON.stringify({ version: 2, fingerprint })]) {
      writeFileSync(cache, data);
      expect(hasCurrentSpritesheet(root, fingerprint)).toBe(false);
    }
    rmSync(cache);
    expect(hasCurrentSpritesheet(root, fingerprint)).toBe(false);
  });
});
