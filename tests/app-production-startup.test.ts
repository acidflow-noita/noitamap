import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { build } from "vite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
let bundle: string;
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production");
  bundle = await mkdtemp(resolve(tmpdir(), "noitamap-app-startup-"));
  await build({
    configFile: resolve(root, "vite.config.ts"),
    publicDir: false,
    logLevel: "error",
    build: { outDir: bundle },
  });
}, 30_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  if (bundle) await rm(bundle, { recursive: true, force: true });
});

it.each([{ map: 'r', renderer: 'canvas' }, { map: 'dy', renderer: 'canvas' }, { map: 'dy', renderer: 'webgl' }])(
  "starts the deployed $map UI with requested drawer $renderer and tile metadata stalled",
  async ({ map, renderer }) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--experimental-vm-modules",
        resolve(root, "tests/helpers/app-production-startup.mjs"),
        root,
        bundle,
        map,
        renderer,
      ],
      { timeout: 10_000 },
    );
    const result = JSON.parse(
      await readFile(resolve(bundle, `startup-${map}-${renderer}.json`), "utf8"),
    );
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    // This Node harness deliberately refuses WebGL contexts. The real OSD
    // drawer and UI must agree on Canvas even when the stored choice is WebGL.
    expect(result.activeDrawer).toBe('canvas');
    expect(result.canvasDrawer).toBe(true);
    expect(result.switchChecked).toBe(false);
    expect(result.switchDisabled).toBe(false);
    expect(result.drawerLogs).toContainEqual(expect.stringContaining(`requested=${renderer}, active=canvas`));
    if (renderer === 'webgl') expect(result.drawerLogs).toContainEqual(expect.stringContaining('fallback'));
    expect(
      result.requested.some((url: string) =>
        url.endsWith("/currentVersion.txt"),
      ),
    ).toBe(true);
    expect(
      result.requested.some((url: string) => url.includes("cdn.jsdelivr.net")),
    ).toBe(false);
  },
  15_000,
);
