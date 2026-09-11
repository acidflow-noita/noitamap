// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/i18n", () => ({
  default: { t: (_key: string, fallback: string) => fallback },
}));
import { DrawingUI } from "../src/drawing/drawing-ui";
import { hideDrawingSkeleton } from "../src/drawing/drawing-skeleton";
import { requestProSidebar } from "../src/pro-sidebar-intent";
let ui: DrawingUI,
  input: HTMLInputElement,
  load: ReturnType<typeof vi.fn>,
  changed: ReturnType<typeof vi.fn>,
  finish: (value: boolean) => void;
beforeEach(() => {
  requestProSidebar("drawing", false);
  requestProSidebar("report", false);
  document.body.innerHTML = '<div id="auth-container"></div>';
  vi.stubGlobal("bootstrap", {
    Popover: class {
      static getInstance() {
        return null;
      }
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  (window as any).__noitamap = {};
  const deferred = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  load = vi.fn(() => deferred);
  ui = new DrawingUI(document.getElementById("auth-container")!, {
    onEnableDrawing: load,
  });
  input = document.getElementById("drawToggleBtn") as HTMLInputElement;
  changed = vi.fn();
  input.addEventListener("change", changed);
});
afterEach(() => {
  requestProSidebar("drawing", false);
  requestProSidebar("report", false);
  hideDrawingSkeleton(true);
  document.body.replaceChildren();
  delete (window as any).__noitamap;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("shows loading feedback before fetching, and supports cancel/reopen while the fetch is pending", async () => {
  input.click();
  expect(document.querySelector("#drawing-sidebar-skel.open")).not.toBeNull();
  expect(load).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  input.click();
  expect(document.getElementById("drawing-sidebar-skel")).toBeNull();
  input.click();
  expect(document.querySelector("#drawing-sidebar-skel.open")).not.toBeNull();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  finish(true);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(input.checked).toBe(true);
});
it("can request drawing again after switching to report during the download", async () => {
  input.click();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  requestProSidebar("report", true);
  expect(document.getElementById("drawing-sidebar-skel")).toBeNull();
  input.click();
  expect(document.querySelector("#drawing-sidebar-skel.open")).not.toBeNull();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  finish(true);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});
it("restored drawing URLs use the same cancellable feedback", async () => {
  ui.openFromURL();
  expect(document.querySelector("#drawing-sidebar-skel.open")).not.toBeNull();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  requestProSidebar("report", true);
  finish(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(changed).not.toHaveBeenCalled();
  expect(input.checked).toBe(false);
  expect(document.getElementById("drawing-sidebar-skel")).toBeNull();
});
