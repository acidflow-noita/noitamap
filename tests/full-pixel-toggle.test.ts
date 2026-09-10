// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const main = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");

describe("no public live full-pixel toggle on any map or view", () => {
  it("removes the control from the shared markup, rather than only hiding it with CSS", () => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(
      doc.querySelector(
        '#fullPixelControl, #fullPixelToggle, label[for="fullPixelToggle"], [data-i18n="fullPixels.title"]',
      ),
    ).toBeNull();
    expect(doc.body.textContent).not.toContain("Render every pixel");
    // Keep unrelated performance/rendering controls intact.
    expect(doc.getElementById("simplisticBackgroundToggle")).not.toBeNull();
    expect(doc.getElementById("renderer-form")).not.toBeNull();
  });

  it("does not wire a controller, full-pixel loading strip, or browser console opt-in", () => {
    expect(main).not.toMatch(
      /createFullPixelToggle|fullPixelControl|fullPixelToggle/,
    );
    expect(main).not.toMatch(
      /setGLTerrain|getGLTerrain|setFullPixelTerrainForBake/,
    );
    expect(main).not.toMatch(/fullPixelTerrainBusy|fullPixelTerrainError/);
  });
});
