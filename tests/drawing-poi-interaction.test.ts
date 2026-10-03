// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  canOpenPOIFromCanvas,
  drawingOwnsMapPointer,
} from "../src/drawing/poi-interaction";

afterEach(() => document.body.replaceChildren());
describe("drawing owns map interactions", () => {
  it("allows normal quick POI clicks, but never the click emitted after a drag", () => {
    expect(canOpenPOIFromCanvas({ quick: true })).toBe(true);
    expect(canOpenPOIFromCanvas({ quick: false })).toBe(false);
    expect(
      canOpenPOIFromCanvas({ quick: true, preventDefaultAction: true }),
    ).toBe(false);
  });
  it("blocks POIs immediately when the drawing toggle is checked", () => {
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
    "drawing-sidebar-skel",
    "drawing-toolbar-skel",
  ])("blocks for an open %s even without a checked toggle", (id) => {
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
});
it("uses the report's opaque surface for both drawing panels and their shared skeleton classes", () => {
  const css = readFileSync("public/css/drawing-sidebar.css", "utf8");
  for (const selector of ["drawing-sidebar", "drawing-toolbar"]) {
    const rule = css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))![1];
    expect(rule).toContain("background: var(--surface-1, #111827)");
    expect(rule).not.toMatch(/glass-bg|backdrop-filter/);
  }
});
