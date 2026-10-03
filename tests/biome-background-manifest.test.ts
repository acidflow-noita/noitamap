import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { dataArchivesPlugin } from "../build_scripts/vite-data-archives";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const exportsOf = (source: string) =>
  Object.fromEntries(
    [...source.matchAll(/export const (\w+) = (\{[^;]*\});/g)].map(
      ([, name, value]) => [name, JSON.parse(value)],
    ),
  );

it("versions standalone background bytes independently and watches changes/new images", async () => {
  const root = await mkdtemp(
    resolve(tmpdir(), "noitamap-background-manifest-"),
  );
  const directory = resolve(root, "public/biome_bg");
  try {
    await mkdir(directory, { recursive: true });
    const zip = new Uint8Array([1, 2, 3]);
    for (const file of ["data.zip", "pixel_scenes.zip", "wang_tiles.zip"])
      await writeFile(resolve(root, "public", file), zip);
    const firstPixels = new Uint8Array([8, 7, 6]),
      otherPixels = new Uint8Array([5, 4]);
    const image = resolve(directory, "background_wandcave.png");
    await writeFile(image, firstPixels);
    await writeFile(resolve(directory, "background_coalmine.png"), otherPixels);
    await writeFile(resolve(directory, "README.txt"), "Not an image");
    await mkdir(resolve(directory, "not-a-file.png"));
    const plugin = dataArchivesPlugin(root),
      context = { addWatchFile: vi.fn() };
    (plugin.buildStart as Function).call(context);
    expect(context.addWatchFile).toHaveBeenCalledWith(directory);
    context.addWatchFile.mockClear();
    const load = plugin.load as Function;
    const id = "\0virtual:noitamap-data-archives";
    const first = exportsOf(await load.call(context, id));
    expect(first.archiveRevisions).toEqual({
      main: digest(zip),
      pixel_scenes: digest(zip),
      wang_tiles: digest(zip),
    });
    expect(first.biomeBackgroundRevisions).toEqual({
      "background_coalmine.png": digest(otherPixels),
      "background_wandcave.png": digest(firstPixels),
    });
    expect(context.addWatchFile).not.toHaveBeenCalledWith(directory);
    expect(context.addWatchFile).toHaveBeenCalledWith(image);

    const updatedPixels = new Uint8Array([8, 7, 5]);
    await writeFile(image, updatedPixels);
    const second = exportsOf(await load.call(context, id));
    expect(second.archiveRevisions).toEqual(first.archiveRevisions);
    expect(second.biomeBackgroundRevisions).toEqual({
      ...first.biomeBackgroundRevisions,
      "background_wandcave.png": digest(updatedPixels),
    });

    const module = {},
      invalidateModule = vi.fn(),
      send = vi.fn();
    const update = plugin.hotUpdate as Function;
    const environment = {
      moduleGraph: { getModuleById: () => module, invalidateModule },
      hot: { send },
    };
    const changed = (file: string, type = 'update') => update.call({ environment }, { file, type });
    expect(changed(image)).toEqual([]);
    expect(invalidateModule).toHaveBeenCalledWith(module);
    expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });

    const added = resolve(directory, "background_new.png");
    await writeFile(added, otherPixels);
    expect(changed(added, 'create')).toEqual([]);
    expect(
      exportsOf(await load.call(context, id)).biomeBackgroundRevisions[
        "background_new.png"
      ],
    ).toBe(digest(otherPixels));
    await rm(added);
    expect(changed(added, 'delete')).toEqual([]);
    expect(exportsOf(await load.call(context, id)).biomeBackgroundRevisions).not.toHaveProperty('background_new.png');
    expect(
      changed(resolve(directory, "README.txt")),
    ).toBeUndefined();
    expect(
      changed(resolve(root, "other.png")),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
