import { it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paintMaskBlock } from "../src/liquids/mask-codec";
import {
  liquidMaskCheckpointPath, encodeLiquidMaskCheckpoint, completeLiquidMaskCheckpoint,
  writeBakedWorldLiquidMask, readBakedWorldLiquidMask,
} from "../build_scripts/baked-world-metadata.mjs";

it("packages actual sparse masks only after complete, versioned leaf coverage and validates resumed publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "noitamap-liquid-package-"));
  const region = { x: -512, y: -123, width: 516, height: 4 }, seed = 1234, renderId = "test-liquid1";
  const a = { x: -512, y: -123, width: 512, height: 4, path: join(root, "a.png") };
  const b = { x: 0, y: -123, width: 4, height: 4, path: join(root, "b.png") };
  const first = new Uint8Array(a.width * a.height), second = new Uint8Array(16);
  first.fill(255, 511, 515); first[3 * 512 + 400] = 255;
  try {
    // Existing image-only checkpoints never stand in for a known-empty mask.
    await writeFile(a.path, "core"); await writeFile(b.path, "core");
    expect(await completeLiquidMaskCheckpoint(a)).toBe(false);
    await writeFile(liquidMaskCheckpointPath(a.path), encodeLiquidMaskCheckpoint(a, first));
    expect(await completeLiquidMaskCheckpoint(a)).toBe(true);
    await expect(writeBakedWorldLiquidMask(root, "middle", seed, renderId, region, [a, b])).rejects.toThrow();
    await expect(readFile(join(root, "middle/liquid-mask.bin"))).rejects.toThrow();
    await writeFile(liquidMaskCheckpointPath(b.path), encodeLiquidMaskCheckpoint(b, second));
    const descriptor = await writeBakedWorldLiquidMask(root, "middle", seed, renderId, region, [b, a]);
    expect(descriptor).toMatchObject({ version: 1, capturedVersion: 1, path: "liquid-mask.bin", seed, renderId });
    expect(descriptor.bytes).toBeLessThan(first.length + second.length);
    expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
    const blocks = await readBakedWorldLiquidMask(root, "middle", seed, renderId, descriptor);
    expect(blocks).toHaveLength(1);
    const actual = new Uint8Array(region.width * region.height);
    for (const block of blocks) paintMaskBlock(block, actual, region.x, region.y, region.width, region.height);
    for (let y = 0; y < 4; y++) {
      expect(actual.slice(y * 516, y * 516 + 512)).toEqual(first.slice(y * 512, (y + 1) * 512));
      expect(actual.slice(y * 516 + 512, (y + 1) * 516)).toEqual(second.slice(y * 4, (y + 1) * 4));
    }
    expect(await readdir(join(root, "middle"))).toEqual(["liquid-mask.bin"]);
    const previous = await readFile(join(root, "middle/liquid-mask.bin"));
    await expect(writeBakedWorldLiquidMask(root, "middle", seed, renderId, region, [a])).rejects.toThrow(/inventory/);
    await expect(writeBakedWorldLiquidMask(root, "middle", seed, renderId, region, [a, a])).rejects.toThrow(/coverage/);
    await writeFile(liquidMaskCheckpointPath(b.path), encodeLiquidMaskCheckpoint({ ...b, x: 99 }, new Uint8Array(16).fill(255)));
    expect(await completeLiquidMaskCheckpoint(b)).toBe(false);
    await expect(writeBakedWorldLiquidMask(root, "middle", seed, renderId, region, [a, b])).rejects.toThrow(/match/);
    expect(await readFile(join(root, "middle/liquid-mask.bin"))).toEqual(previous);
    await expect(readBakedWorldLiquidMask(root, "middle", seed + 1, renderId, descriptor)).rejects.toThrow(/descriptor/);
    await expect(readBakedWorldLiquidMask(root, "middle", seed, "old-render", descriptor)).rejects.toThrow(/descriptor/);
    previous[previous.length - 1] ^= 1;
    await writeFile(join(root, "middle/liquid-mask.bin"), previous);
    await expect(readBakedWorldLiquidMask(root, "middle", seed, renderId, descriptor)).rejects.toThrow(/digest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
