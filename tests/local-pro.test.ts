import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveLocalPro } from "../build_scripts/local-pro";

const fixtures: string[] = [];

async function checkoutFixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "noitamap-pro-layout-"));
  fixtures.push(dir);
  return resolve(dir, "noitamap");
}

async function addPro(root: string) {
  await mkdir(resolve(root, "src"), { recursive: true });
  await writeFile(
    resolve(root, "src/pro-entry.ts"),
    "export async function init() {}\n",
  );
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("local Pro checkout resolution", () => {
  it("keeps public-only checkouts on the hosted loader path", async () => {
    const root = await checkoutFixture();
    const local = resolveLocalPro(root);
    expect(local.available).toBe(false);
    expect(local.root).toBeUndefined();
    expect(local.aliases["virtual:noitamap-pro"]).toBe(
      resolve(root, "src/pro-unavailable.ts"),
    );
  });

  it.each(["task/noitamap-pro", "../noitamap-pro"])(
    "finds a checkout at %s",
    async (relativePath) => {
      const root = await checkoutFixture();
      const pro = resolve(root, relativePath);
      await addPro(pro);
      const local = resolveLocalPro(root);
      expect(local.available).toBe(true);
      expect(local.root).toBe(pro);
      expect(local.aliases["virtual:noitamap-pro"]).toBe(
        resolve(pro, "src/pro-entry.ts"),
      );
      expect(local.aliases["virtual:noitamap-public-report"]).toBe(
        resolve(pro, "src/public-report-entry.ts"),
      );
      expect(local.aliases["noitamap/data/spells.json"]).toBe(
        resolve(root, "src/data/spells.json"),
      );
    },
  );

  it("prefers this workspace's task checkout if both layouts exist", async () => {
    const root = await checkoutFixture();
    await addPro(resolve(root, "task/noitamap-pro"));
    await addPro(resolve(root, "../noitamap-pro"));
    expect(resolveLocalPro(root).root).toBe(resolve(root, "task/noitamap-pro"));
  });

  it("does not select an empty task directory over a working sibling checkout", async () => {
    const root = await checkoutFixture();
    await mkdir(resolve(root, "task/noitamap-pro"), { recursive: true });
    await addPro(resolve(root, "../noitamap-pro"));
    expect(resolveLocalPro(root).root).toBe(resolve(root, "../noitamap-pro"));
  });
});
