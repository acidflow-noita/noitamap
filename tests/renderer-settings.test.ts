// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoredRenderer, setStoredRenderer } from "../src/renderer_settings";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("honors an explicit WebGL choice on the deployed preview and allows switching back", () => {
  vi.stubGlobal("window", {
    location: { hostname: "telescope-api-preview.noitamap.com" },
  });
  expect(getStoredRenderer()).toBe("canvas");
  setStoredRenderer("webgl");
  expect(getStoredRenderer()).toBe("webgl");
  setStoredRenderer("canvas");
  expect(getStoredRenderer()).toBe("canvas");
});
it("keeps a usable default when browser storage is blocked", () => {
  vi.mocked(localStorage.getItem).mockImplementation(() => {
    throw new Error("storage denied");
  });
  expect(getStoredRenderer()).toBe("canvas");
});
