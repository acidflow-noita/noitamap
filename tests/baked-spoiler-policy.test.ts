// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
beforeEach(() => {
  // Isolate the persisted preference. Vitest 3 / Node 26's global storage
  // getter is not browser storage, even under its jsdom environment.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());
describe("baked seed spoiler preference", () => {
  it("suspends rather than erases the saved preference on a baked seed", async () => {
    localStorage.setItem("noitamap-spoiler-free", "1");
    const policy = await import("../src/spoiler-free");
    const changed = vi.fn();
    policy.onSpoilerFreeChange(changed);
    expect(policy.isSpoilerFree()).toBe(true);
    policy.setBakedSeedView(true);
    expect(policy.isSpoilerFree()).toBe(false);
    expect(policy.isBakedSeedView()).toBe(true);
    expect(localStorage.getItem("noitamap-spoiler-free")).toBe("1");
    expect(policy.applySpoilerFree("wand:secret", { "wand:handgun": {} })).toBe(
      "wand:secret",
    );
    policy.setBakedSeedView(false);
    expect(policy.isSpoilerFree()).toBe(true);
    expect(policy.applySpoilerFree("wand:secret", { "wand:handgun": {} })).toBe(
      "wand:handgun",
    );
    expect(changed.mock.calls).toEqual([[false], [true]]);
  });
  it("handles the fast baked event before the UI has initialized", async () => {
    const policy = await import("../src/spoiler-free");
    window.dispatchEvent(
      new CustomEvent("bakedSeedChange", { detail: { baked: true } }),
    );
    expect(policy.isBakedSeedView()).toBe(true);
    policy.setSpoilerFree(true);
    expect(policy.isSpoilerFree()).toBe(false);
    window.dispatchEvent(
      new CustomEvent("bakedSeedChange", { detail: { baked: false } }),
    );
    expect(policy.isSpoilerFree()).toBe(true);
  });
});
