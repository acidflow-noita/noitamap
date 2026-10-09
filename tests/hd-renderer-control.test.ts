// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { initHDRendererToggle } from "../src/hd-renderer-control";
import {
  isHDRendererEnabled,
  setHDRendererEnabled,
} from "../src/renderer_settings";

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const sourceCopy = JSON.parse(
  readFileSync(resolve(root, "build_data/performance-ui.json"), "utf8"),
);

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  window.history.replaceState(
    {},
    "",
    "/?m=dy&se=42&x=123&y=456&z=7&u=none&sr=1#map",
  );
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.append(parsed.getElementById("perfModeDropdown")!);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("HD renderer Performance control", () => {
  it("uses the existing switch markup and labels within the dynamic-map Performance menu", () => {
    const toggle = document.getElementById(
      "hdRendererToggle",
    ) as HTMLInputElement;
    const label = document.querySelector<HTMLLabelElement>(
      'label[for="hdRendererToggle"]',
    )!;
    const host = document.getElementById("hdRendererPopover")!;
    expect(toggle.type).toBe("checkbox");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.className).toBe(
      document.getElementById("lightModeToggle")!.className,
    );
    expect(toggle.parentElement!.className).toBe(
      document.getElementById("lightModeToggle")!.parentElement!.className,
    );
    expect(toggle.closest(".dynamic-map-only")?.id).toBe("perfModeDropdown");
    expect(label.textContent?.trim()).toBe("HD renderer");
    expect(label.dataset.i18n).toBe("hdRenderer.title");
    expect(host.dataset.i18nTitle).toBe("hdRenderer.title");
    expect(host.dataset.i18nContent).toBe("hdRenderer.content");
    expect(host.dataset.bsContent).toBe(sourceCopy.en.content);
  });

  it("starts checked by default and reflects a saved disabled preference", () => {
    const reload = vi.fn(),
      saveViewport = vi.fn();
    initHDRendererToggle(saveViewport, reload);
    const toggle = document.getElementById(
      "hdRendererToggle",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    setHDRendererEnabled(false);
    // A new page restores the saved preference without scheduling a reload.
    const replacement = toggle.cloneNode() as HTMLInputElement;
    toggle.replaceWith(replacement);
    initHDRendererToggle(saveViewport, reload);
    expect(replacement.checked).toBe(false);
    vi.runAllTimers();
    expect(saveViewport).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["gpu", true, false],
    ["approx", false, true],
  ] as const)(
    "replaces the %s override, preserves navigation and flushes the camera before reload",
    (override, initial, next) => {
      const initialURL = new URL(window.location.href);
      initialURL.searchParams.set("terrain", override);
      window.history.replaceState({ retained: true }, "", initialURL);
      const saveViewport = vi.fn(() => {
        const current = new URL(window.location.href);
        current.searchParams.set("x", "789");
        window.history.replaceState(window.history.state, "", current);
      });
      const reload = vi.fn(() =>
        expect(new URL(window.location.href).searchParams.get("x")).toBe("789"),
      );
      initHDRendererToggle(saveViewport, reload);
      const toggle = document.getElementById(
        "hdRendererToggle",
      ) as HTMLInputElement;
      expect(toggle.checked).toBe(initial);
      toggle.focus();
      toggle.checked = next;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      expect(isHDRendererEnabled()).toBe(next);
      expect(document.activeElement).not.toBe(toggle);
      const expectedURL = new URL(initialURL);
      expectedURL.searchParams.delete("terrain");
      expect(window.location.href).toBe(expectedURL.href);
      expect(window.history.state).toEqual({ retained: true });
      vi.advanceTimersByTime(49);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(saveViewport).toHaveBeenCalledOnce();
      expect(reload).toHaveBeenCalledOnce();
      expect(saveViewport.mock.invocationCallOrder[0]).toBeLessThan(
        reload.mock.invocationCallOrder[0],
      );
      expectedURL.searchParams.set("x", "789");
      expect(window.location.href).toBe(expectedURL.href);
    },
  );

  it("ships the authored title and explanation for every supported locale", () => {
    const locales = readdirSync(resolve(root, "src/locales"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(sourceCopy).sort()).toEqual(locales);
    expect(locales).toHaveLength(16);
    for (const locale of locales) {
      for (const directory of ["src/locales", "public/locales"]) {
        const generated = JSON.parse(
          readFileSync(
            resolve(root, directory, locale, "translation.json"),
            "utf8",
          ),
        );
        expect(generated.hdRenderer, `${directory}/${locale}`).toEqual(
          sourceCopy[locale],
        );
      }
      if (locale !== "en")
        expect(sourceCopy[locale].content).not.toBe(sourceCopy.en.content);
    }
  });

  it("keeps the selected mode through reload when storage is blocked", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    const before = new URL(window.location.href);
    const reload = vi.fn(() => expect(isHDRendererEnabled()).toBe(false));
    initHDRendererToggle(vi.fn(), reload);
    const toggle = document.getElementById(
      "hdRendererToggle",
    ) as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    vi.runAllTimers();
    expect(reload).toHaveBeenCalledOnce();
    before.searchParams.set("terrain", "approx");
    expect(window.location.href).toBe(before.href);
    // The URL fallback also restores the unchecked switch on the new page.
    const replacement = toggle.cloneNode() as HTMLInputElement;
    toggle.replaceWith(replacement);
    initHDRendererToggle(vi.fn(), reload);
    expect(replacement.checked).toBe(false);
  });
});
