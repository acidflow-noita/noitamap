// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDrawerToggle } from "../src/drawer-toggle";
import { getStoredRenderer, setStoredRenderer } from "../src/renderer_settings";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const html = readFileSync(
    resolve(import.meta.dirname, "../index.html"),
    "utf8",
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.body.appendChild(doc.getElementById("perfModeDropdown")!);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const input = document.getElementById("drawerToggle") as HTMLInputElement;
  const container = document.getElementById("drawerControl")!;
  const reload = vi.fn();
  const control = createDrawerToggle(input, container, reload);
  return { input, container, reload, control };
}

it.each(["canvas", "webgl"] as const)(
  "saves the other drawer and requests reload when active=%s",
  (active) => {
    const { input, reload, control } = setup();
    expect(input.disabled).toBe(true);
    control.setActive(active);
    expect(input.checked).toBe(active === "webgl");
    const requested = active === "canvas" ? "webgl" : "canvas";
    input.checked = requested === "webgl";
    input.dispatchEvent(new Event("change"));
    expect(getStoredRenderer()).toBe(requested);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`${active} -> ${requested}`),
    );
    expect(reload).toHaveBeenCalledOnce();
  },
);

it("shows the actual Canvas fallback instead of claiming the saved WebGL choice is active", () => {
  setStoredRenderer("webgl");
  const { input, container, reload, control } = setup();
  control.setActive("canvas");
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(false);
  expect(container.title).toContain("Active: canvas; saved preference: webgl");
  expect(reload).not.toHaveBeenCalled();
  expect(input.parentElement!.className).toBe(
    document.getElementById("fullPixelToggle")!.parentElement!.className,
  );
});

it("keeps the active state and does not reload when saving the change fails", () => {
  const { input, reload, control } = setup();
  control.setActive("canvas");
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  input.checked = true;
  input.dispatchEvent(new Event("change"));
  expect(input.checked).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalled();
});
