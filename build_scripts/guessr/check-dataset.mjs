#!/usr/bin/env node
import { chromium, firefox } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = resolve("task/guessr/dataset");
const index = JSON.parse(await readFile(root + "/locations.json", "utf8"));
const reports = [];
for (const kind of ["chromium", "firefox"]) {
  const browser = await (kind === "chromium"
    ? chromium.launch({ executablePath: "/usr/bin/chromium", headless: true })
    : firefox.launch({
        executablePath: "/usr/bin/firefox",
        channel: "moz-firefox",
        headless: true,
      }));
  const errors = [],
    requests = [],
    report = { browser: kind, version: browser.version() };
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(pathToFileURL(root + "/index.html").href);
    assert.equal(
      await page.locator("nav button").count(),
      index.locations.length,
    );
    const loaded = (selector, width) =>
      page.waitForFunction(
        ({ selector, width }) => {
          const image = document.querySelector(selector);
          return image instanceof HTMLCanvasElement
            ? image.dataset.ready === "true" && image.width === width
            : image?.complete && image.naturalWidth === width;
        },
        { selector, width },
      );
    for (let i = 0; i < index.locations.length; i++) {
      await page.locator("nav button").nth(i).click();
      await loaded("#current", 27);
      await loaded("#context", 1728);
      assert(
        (await page.locator("#name").innerText()).includes(
          index.locations[i].id,
        ),
      );
    }
    await page.locator("nav button").first().click();
    for (let level = 0; level <= 6; level++) {
      if (level) await page.locator("#zout").click();
      const width = 27 * 2 ** level,
        height = 12 * 2 ** level;
      await loaded("#current", width);
      for (const [direction, reverse, axis, distance] of [
        [
          "Travel east",
          "Travel west",
          "x",
          Math.min(
            Math.round(width * 0.9),
            864 - Math.floor(-width / 2) - width,
          ),
        ],
        [
          "Travel south",
          "Travel north",
          "y",
          Math.min(Math.round(height * 0.9), 384 - height / 2),
        ],
      ]) {
        if (level === 6) {
          assert(
            await page
              .getByRole("button", { name: direction, exact: true })
              .isDisabled(),
          );
          continue;
        }
        const before = Number(
          await page.locator("#camera-box").getAttribute(axis),
        );
        await page
          .getByRole("button", { name: direction, exact: true })
          .click();
        await loaded("#current", width);
        assert.equal(
          Number(await page.locator("#camera-box").getAttribute(axis)) - before,
          distance,
        );
        await page.locator("#reset").click();
        await loaded("#current", width);
        assert.equal(
          Number(await page.locator("#camera-box").getAttribute(axis)),
          before,
        );
      }
    }
    assert(await page.locator("#zout").isDisabled());
    assert.equal(await page.locator("#travel button:disabled").count(), 4);
    assert.equal(
      (await page.locator("#info").innerText()).includes("offset: 0, 0"),
      true,
    );
    assert(
      await page
        .locator(".camera-controls button")
        .evaluateAll((buttons) =>
          buttons.every(
            (b) =>
              !b.textContent.trim() &&
              b.querySelector("svg.bi") &&
              b.getAttribute("aria-label"),
          ),
        ),
    );
    const zoomBox = await page.locator(".camera-zoom").boundingBox(),
      travelBox = await page.locator("#travel").boundingBox();
    assert(travelBox.x >= zoomBox.x + zoomBox.width);
    await page.screenshot({
      path: root + `/gallery-${kind}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert(!requests.some((url) => !url.startsWith("file:")));
    assert.deepEqual(errors, []);
    Object.assign(report, {
      passed: true,
      locations: index.locations.length,
      zoomLevels: 7,
      travelBounds: true,
      ninetyPercentMovementWithinBounds: true,
      fullZoomOutDisablesMovement: true,
      iconOnlyControls: true,
      worksOffline: true,
      mobileOverflow: false,
    });
  } catch (error) {
    Object.assign(report, { passed: false, failure: String(error), errors });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
  reports.push(report);
  console.log(JSON.stringify(report));
}
await writeFile(
  root + "/gallery-check.json",
  JSON.stringify(reports, null, 2) + "\n",
);
