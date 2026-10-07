// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
let canOpenPOIFromCanvas: typeof import('../src/drawing/poi-interaction').canOpenPOIFromCanvas;
let drawingOwnsMapPointer: typeof import('../src/drawing/poi-interaction').drawingOwnsMapPointer;
let setDrawingMapOwnership: typeof import('../src/drawing/poi-interaction').setDrawingMapOwnership;
let onDrawingMapOwnershipChange: typeof import('../src/drawing/poi-interaction').onDrawingMapOwnershipChange;

beforeEach(async () => {
  vi.resetModules();
  ({ canOpenPOIFromCanvas, drawingOwnsMapPointer, setDrawingMapOwnership, onDrawingMapOwnershipChange } = await import('../src/drawing/poi-interaction'));
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe("drawing owns map interactions", () => {
  it("allows normal quick POI clicks, but never the click emitted after a drag", () => {
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
    expect(canOpenPOIFromCanvas({ quick: false })).toBe(false);
    expect(
      canOpenPOIFromCanvas({ quick: true, preventDefaultAction: true }),
    ).toBe(false);
  });
  it("preserves the old guard for an already-loaded legacy Pro bundle", () => {
    vi.stubGlobal('__noitamap', { isProFeatureReady: () => true });
    document.body.innerHTML =
      '<input type="checkbox" id="drawToggleBtn" checked>';
    const event = { quick: true };
    expect(canOpenPOIFromCanvas(event)).toBe(false);
    expect(event).toEqual({ quick: true }); // Drawing/OSD still own the gesture.
    document.querySelector<HTMLInputElement>("input")!.checked = false;
    expect(canOpenPOIFromCanvas(event)).toBe(true);
  });
  it.each([
    "drawing-sidebar",
    "drawing-toolbar",
  ])("keeps a legacy open %s guarded until Pro can report its state", (id) => {
    document.body.innerHTML = `<div id="${id}" class="${id.includes("sidebar") ? "drawing-sidebar" : "drawing-toolbar"} open"></div>`;
    expect(drawingOwnsMapPointer()).toBe(true);
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(false);
    document.getElementById(id)!.classList.remove("open");
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
  });
  it("does not block normal interaction merely because the drawing module is mounted", () => {
    document.body.innerHTML =
      '<div class="drawing-sidebar"></div><div class="drawing-toolbar"></div>';
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
  });

  it('leaves POIs available through an initial skeleton, cancelled or failed loading', () => {
    document.body.innerHTML = '<input id="drawToggleBtn" type="checkbox" checked>'
      + '<div id="drawing-sidebar-skel" class="drawing-sidebar open"></div>'
      + '<div id="drawing-toolbar-skel" class="drawing-toolbar open"></div>';
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
    document.body.replaceChildren();
    expect(drawingOwnsMapPointer()).toBe(false);
  });

  it('allows the reported empty/login menu even with a checked toggle and open panels', () => {
    document.body.innerHTML = '<input id="drawToggleBtn" type="checkbox" checked>'
      + '<div class="drawing-sidebar open"></div><div class="drawing-toolbar open"></div>';
    setDrawingMapOwnership(false);
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
    expect(canOpenPOIFromCanvas({ quick: false })).toBe(false);
  });

  it('blocks actual editing/read-only drawings and releases the map when Pro closes or clears them', () => {
    setDrawingMapOwnership(false);
    const change = vi.fn(), unsubscribe = onDrawingMapOwnershipChange(change);
    setDrawingMapOwnership(true);
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(false);
    setDrawingMapOwnership(true);
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
    setDrawingMapOwnership(false);
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
    expect(change).toHaveBeenLastCalledWith(false);
    unsubscribe(); setDrawingMapOwnership(true);
    expect(change).toHaveBeenCalledTimes(2);
  });
});
it("uses the report's opaque surface for both drawing panels and their shared skeleton classes", () => {
  const css = readFileSync("public/css/drawing-sidebar.css", "utf8");
  for (const selector of ["drawing-sidebar", "drawing-toolbar"]) {
    const rule = css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))![1];
    expect(rule).toContain("background: var(--surface-1, #111827)");
    expect(rule).not.toMatch(/glass-bg|backdrop-filter/);
  }
});
