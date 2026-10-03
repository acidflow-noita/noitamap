import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ignoreTaskScratch } from "../build_scripts/vite-watch";

const root = resolve("/workspace/noitamap");

describe("Vite scratch-directory watch exclusions", () => {
  it("prunes scratch checkouts while retaining nested Pro and public sources", () => {
    const ignored = ignoreTaskScratch(root, resolve(root, "task/noitamap-pro"));
    for (const path of [
      "task/graham-tooling",
      "task/graham-tooling/work/research-compat/pfx/dosdevices/z:/usr/share",
      "task/noita-particle-animations",
      "task/noitamap-pro-backup/src/pro-entry.ts",
    ]) {
      expect(ignored(resolve(root, path)), path).toBe(true);
    }
    for (const path of [
      ".",
      "task",
      "task/noitamap-pro",
      "task/noitamap-pro/src/pro-entry.ts",
      "src/main.ts",
      "public/data",
      "lib/noita-telescope/js",
      "build_scripts/vite-watch.ts",
      "task-other/source.ts",
    ]) {
      expect(ignored(resolve(root, path)), path).toBe(false);
    }
  });

  it.each([undefined, resolve(root, "../noitamap-pro")])(
    "prunes the entire task tree when Pro is absent or a sibling (%s)",
    (proRoot) => {
      const ignored = ignoreTaskScratch(root, proRoot);
      expect(ignored(resolve(root, "task"))).toBe(true);
      expect(ignored(resolve(root, "task/graham-tooling"))).toBe(true);
      expect(ignored(resolve(root, "src/main.ts"))).toBe(false);
      expect(ignored(resolve(root, "../noitamap-pro/src/pro-entry.ts"))).toBe(false);
    },
  );
});
