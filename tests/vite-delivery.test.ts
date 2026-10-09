import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { deliveryPlugin } from "../build_scripts/vite-delivery";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(headers = "") {
  const root = await mkdtemp(join(tmpdir(), "noitamap-delivery-"));
  roots.push(root);
  const files: Record<string, string> = {
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js": 'console.log("fixture");',
    "public/game-translations/common.csv": "build input",
    "public/translations.csv": "unused duplicate",
    "public/assets/atlas.json": "{}",
    "public/data/translations.csv": "runtime translations",
    "public/assets/full_materials.json": "[]",
    "public/assets/spritesheet.png": "runtime sprites",
  };
  if (headers) files["public/_headers"] = headers;
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  return root;
}

async function compile(root: string, input = "index.html") {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [deliveryPlugin()],
    build: {
      assetsDir: "build",
      rollupOptions: { input: join(root, input) },
    },
  });
}

describe("production delivery output", () => {
  it("omits only build-only copies and caches the fingerprinted bucket", async () => {
    const existingHeaders = "/*\n  X-Content-Type-Options: nosniff\n";
    const root = await fixture(existingHeaders);
    await compile(root);
    const headers = await readFile(join(root, "dist/_headers"), "utf8");
    expect(headers).toContain(existingHeaders);
    expect(headers).toContain("/build/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(headers).not.toContain("/assets/*");
    for (const file of ["game-translations/common.csv", "translations.csv", "assets/atlas.json"]) {
      await expect(readFile(join(root, "dist", file))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "public", file), "utf8")).toBeTruthy();
    }
    for (const file of ["data/translations.csv", "assets/full_materials.json", "assets/spritesheet.png"])
      expect(await readFile(join(root, "dist", file), "utf8")).toBe(await readFile(join(root, "public", file), "utf8"));
  });

  it("preserves an existing cache policy without conflicting directives", async () => {
    const policy = "/*\n  Cache-Control: no-cache\n";
    const root = await fixture(policy);
    await compile(root);
    expect(await readFile(join(root, "dist/_headers"), "utf8")).toBe(policy);
  });

  it("leaves native bake and custom JavaScript entry builds alone", async () => {
    const root = await fixture();
    await compile(root, "main.js");
    await expect(readFile(join(root, "dist/_headers"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "dist/game-translations/common.csv"), "utf8")).toBe("build input");
    expect(await readFile(join(root, "dist/assets/atlas.json"), "utf8")).toBe("{}");
  });
});
