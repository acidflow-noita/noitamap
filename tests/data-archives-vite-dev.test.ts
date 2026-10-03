import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { dataArchivesPlugin } from "../build_scripts/vite-data-archives";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

it.each([false, true])(
  "transforms the archive manifest through Vite import analysis (assets outside root: %s)",
  async (outsideRoot) => {
    const fixture = await mkdtemp(resolve(tmpdir(), "noitamap-archive-vite-"));
    const root = resolve(fixture, "map");
    const serverRoot = outsideRoot ? resolve(fixture, "pro") : root;
    const backgrounds = resolve(root, "public/biome_bg");
    let server: ViteDevServer | undefined;
    try {
      await mkdir(backgrounds, { recursive: true });
      await mkdir(serverRoot, { recursive: true });
      const archive = new Uint8Array([1, 4, 9]);
      const background = new Uint8Array([8, 7, 6]);
      for (const filename of ["data.zip", "pixel_scenes.zip", "wang_tiles.zip"])
        await writeFile(resolve(root, "public", filename), archive);
      const image = resolve(backgrounds, "background_cave.png");
      await writeFile(image, background);
      await writeFile(
        resolve(serverRoot, "entry.js"),
        'import { archiveRevisions } from "virtual:noitamap-data-archives"; export { archiveRevisions };',
      );
      server = await createServer({
        configFile: false,
        root: serverRoot,
        logLevel: "silent",
        plugins: [dataArchivesPlugin(root)],
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          middlewareMode: true,
          hmr: false,
          ws: false,
          fs: { allow: [fixture] },
        },
      });

      // Resolve the imported virtual module first, as a browser entry request
      // does. Vite attaches load-hook dependencies to that module graph node.
      await server.transformRequest("/entry.js");
      const result = await server.transformRequest(
        // Vite's HTTP middleware unwraps /@id/__x00__ before this API.
        "\0virtual:noitamap-data-archives",
      );
      expect(result?.code).toContain(digest(archive));
      expect(result?.code).toContain(digest(background));
      expect(result?.code).toContain('"background_cave.png"');

      const module = server.environments.client.moduleGraph.getModuleById(
        "\0virtual:noitamap-data-archives",
      );
      expect(module).toBeDefined();
      const importedIds = [...module!.importedModules].map((item) => item.id);
      expect(importedIds).not.toContain(normalizePath(backgrounds));
      expect(importedIds).toContain(normalizePath(image));
    } finally {
      await server?.close();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
