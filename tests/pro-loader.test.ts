// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
// The controller takes an injected module loader; this test never imports Pro.
vi.mock("../src/pro-module", () => ({ loadProModule: vi.fn() }));
import { createProLoader } from "../src/pro-loader";

afterEach(() => {
  delete (window as any).noitamap_pro_loaded;
  vi.restoreAllMocks();
});

describe("Pro loading lifecycle", () => {
  it("coalesces concurrent bootstrap loads and initializes once", async () => {
    const init = vi.fn(async () => {});
    const importModule = vi.fn(async () => ({ init }));
    const load = createProLoader({} as NoitamapProHooks, importModule);
    expect(await Promise.all([load(), load(), load()])).toEqual([
      true,
      true,
      true,
    ]);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(await load()).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("does not mark failed initialization ready and permits retry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const init = vi
      .fn()
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValue(undefined);
    const load = createProLoader({} as NoitamapProHooks, async () => ({
      init,
    }));
    expect(await load()).toBe(false);
    expect((window as any).noitamap_pro_loaded).not.toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "init failed" }),
    );
    expect(await load()).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("requests only the desired feature and retries a failed feature without reinitializing bootstrap", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const init = vi.fn(async () => {});
    const loadProFeature = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValue(undefined);
    const load = createProLoader(
      { loadProFeature } as unknown as NoitamapProHooks,
      async () => ({ init }),
    );
    expect(await load("report")).toBe(false);
    expect(await load("report")).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(loadProFeature.mock.calls).toEqual([["report"], ["report"]]);
  });

  it("continues to support a deployed pre-split Pro module", async () => {
    const init = vi.fn(async () => {});
    const load = createProLoader({} as NoitamapProHooks, async () => ({
      init,
    }));
    expect(await load("drawing")).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
  });
});
