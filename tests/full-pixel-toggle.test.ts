// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFullPixelToggle } from "../src/full-pixel-toggle";
import { isGLTerrainEnabled, setGLTerrain } from "../src/renderer_settings";

const messages: Record<string, string> = {
  "fullPixels.title": "Render every pixel",
  "fullPixels.description":
    "Render this seed’s terrain at full pixel resolution. Changing this setting reloads the map.",
  "fullPixels.baked":
    "This daily map is already baked at full pixel resolution.",
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
});
function setup(enabled = false, resolved = true) {
  localStorage.clear();
  setGLTerrain(enabled);
  document.body.innerHTML =
    '<div id="control"><input id="toggle" type="checkbox"><label for="toggle">Render every pixel</label></div>';
  const input = document.querySelector("input")!,
    container = document.getElementById("control")!;
  const reload = vi.fn();
  const translate = vi.fn((key: string) => messages[key]);
  const control = createFullPixelToggle(input, container, translate, reload);
  if (resolved) control.setBaked(false);
  return { input, container, reload, translate, control };
}
afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
describe("full-pixel toggle for baked and arbitrary seeds", () => {
  it.each([false, true])(
    "hides completed bakes without changing the saved preference (%s)",
    (preference) => {
      const { input, container, control, reload } = setup(preference);
      control.setBaked(true);
      expect(input.checked).toBe(preference);
      expect(input.disabled).toBe(true);
      expect(container.hidden).toBe(true);
      expect(container.hasAttribute("tabindex")).toBe(false);
      expect(container.title).not.toBe(messages["fullPixels.baked"]);
      expect(isGLTerrainEnabled()).toBe(preference);
      // Guard synthetic changes too: a baked view cannot alter the saved preference.
      input.checked = false;
      input.dispatchEvent(new Event("change"));
      expect(input.checked).toBe(preference);
      expect(isGLTerrainEnabled()).toBe(preference);
      expect(reload).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "restores the live-seed preference after leaving a baked daily (%s)",
    (preference) => {
      const { input, container, control } = setup(preference);
      control.setBaked(true);
      control.setBaked(false);
      expect(input.disabled).toBe(false);
      expect(container.hidden).toBe(false);
      expect(input.checked).toBe(preference);
      expect(input.style.pointerEvents).toBe("");
      expect(container.hasAttribute("tabindex")).toBe(false);
      expect(container.title).toBe(messages["fullPixels.description"]);
    },
  );
  it("stays hidden while the bake probe is pending, rather than flashing on a baked daily", () => {
    const { container, input, reload } = setup(true, false);
    expect(container.hidden).toBe(true);
    input.dispatchEvent(new Event("change"));
    expect(reload).not.toHaveBeenCalled();
  });
  it("allows enabling/disabling for an unbaked seed and persists it before reloading", () => {
    const { input, reload } = setup();
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(isGLTerrainEnabled()).toBe(true);
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    expect(isGLTerrainEnabled()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("does not reveal the hidden control when the language changes", () => {
    const { control, input, container, translate } = setup();
    control.setBaked(true);
    translate.mockImplementation((key) => `translated:${key}`);
    control.refresh();
    expect(container.title).toBe("translated:fullPixels.description");
    expect(container.hidden).toBe(true);
    expect(input.getAttribute("aria-description")).toBe(container.title);
    expect(input.disabled).toBe(true);
  });
  it("keeps the control in the public dynamic-map UI, not inside dev-only markup", () => {
    const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const input = doc.getElementById("fullPixelToggle")!;
    expect(input).not.toBeNull();
    expect(input.closest(".dynamic-map-only")).not.toBeNull();
    expect(input.closest(".dev-only, [data-dev-only]")).toBeNull();
    expect(input.closest("[hidden]")?.id).toBe("fullPixelControl");
    expect(input.hasAttribute("disabled")).toBe(false);
  });
});
