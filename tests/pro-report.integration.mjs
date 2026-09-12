/** Built-host + built-Pro regression. CDN libraries are fetched unchanged;
 * analytics/static-map tiles/auth responses are isolated test fixtures. The
 * generator, atlas, loot previews, report and map-card code are real. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
const root = resolve(import.meta.dirname, "..");
const hostBuild = resolve(process.argv[2] || resolve(root, "dist"));
const proBuild = resolve(
  process.argv[3] || resolve(root, "task/noitamap-pro/public"),
);
const artifacts =
  process.env.TEST_ARTIFACTS || "/tmp/noitamap-report-integration";
await mkdir(artifacts, { recursive: true });
const dependencyUrls = [
  "https://cdn.jsdelivr.net/npm/openseadragon@6.1.0/build/openseadragon/openseadragon.min.js",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css",
  "https://unpkg.com/openseadragon-annotations@1.0.5/dist/openseadragon-annotations.js",
  "https://cdn.jsdelivr.net/npm/openseadragon-opacity-slider/dist/openseadragon-opacity-slider.min.js",
  "https://unpkg.com/flexsearch@0.8.212/dist/flexsearch.bundle.min.js",
  "https://unpkg.com/eventemitter2@6.4.9/lib/eventemitter2.js",
];
const dependencies = new Map(
  await Promise.all(
    dependencyUrls.map(async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      assert.ok(response.ok, `${url}: ${response.status}`);
      return [url, Buffer.from(await response.arrayBuffer())];
    }),
  ),
);
const pixel = await sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 7, g: 13, b: 22, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = resolve(
    hostBuild,
    "." +
      (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)),
  );
  if (!file.startsWith(hostBuild + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    res.setHeader(
      "Content-Type",
      mime[extname(file)] || "application/octet-stream",
    );
    res.setHeader("Content-Length", info.size);
    res.setHeader("X-Archive-Meta", `${info.size}-${info.mtimeMs}`);
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    res.writeHead(404).end("Missing fixture asset");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage(),
    errors = [],
    missing = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      missing.push({ url: response.url(), status: response.status() });
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (url.startsWith("https://noitamap-pro.acidflow.stream/")) {
      const path = new URL(url).pathname;
      if (path.endsWith(".js"))
        return route.fulfill({
          body: await readFile(resolve(proBuild, "." + path)),
          contentType: "text/javascript",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
    }
    if (dependencies.has(url))
      return route.fulfill({
        body: dependencies.get(url),
        contentType: url.endsWith(".css") ? "text/css" : "text/javascript",
      });
    if (url.includes("current_seed.txt")) return route.fulfill({ body: "42" });
    if (url.includes("previous_seed.txt")) return route.fulfill({ body: "43" });
    if (url.endsWith("/manifest.json"))
      return route.fulfill({ body: "null", contentType: "application/json" });
    if (new URL(url).pathname.endsWith(".dzi"))
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          Image: {
            xmlns: "http://schemas.microsoft.com/deepzoom/2008",
            Format: "png",
            Overlap: 2,
            TileSize: 512,
            Size: { Width: 35840, Height: 73728 },
          },
        }),
      });
    if (route.request().resourceType() === "image")
      return route.fulfill({ body: pixel, contentType: "image/png" });
    if (route.request().resourceType() === "stylesheet")
      return route.fulfill({ body: "", contentType: "text/css" });
    if (route.request().resourceType() === "script")
      return route.fulfill({ body: "", contentType: "text/javascript" });
    return route.fulfill({
      body: JSON.stringify({ authenticated: false, user: null, drawings: [] }),
      contentType: "application/json",
    });
  });
  await page.goto(
    origin + "/?m=dy&se=306813029&u=all&nb=1&sr=1&reportPreview=v2",
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () =>
      window.noitamap?.getGeneration()?.seed === 306813029 &&
      window.__noitamap?.getAllDynamicPOIs?.().length > 1000,
    undefined,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => window.__noitamap?.isProFeatureReady?.("report"),
    undefined,
    { timeout: 45000 },
  );
  await page.evaluate(() => {
    const hooks = window.__noitamap;
    const state = {
      authenticated: true,
      isSubscriber: true,
      isFollower: true,
      username: "local-fixture",
      provider: "patreon",
    };
    hooks.authService.getState = () => state;
    hooks.authService.isAuthenticated = () => true;
    hooks.authService.isSubscriber = () => true;
    hooks.authService.subscribe = (cb) => {
      cb(state);
      return () => {};
    };
    hooks.getFlatPOIsForSeed = async () => hooks.getAllDynamicPOIs();
    hooks.handleSeedReportToggle(false);
    hooks.handleSeedReportToggle(true);
  });
  await page.locator("#seed-report-v2:not([hidden])").waitFor();
  await page
    .locator(".sr2-tabs button")
    .filter({ hasText: "World balance" })
    .click();
  const choose = async (metric) => {
    const button = page.locator(`.sr2-metric-button[data-metric="${metric}"]`);
    if ((await button.getAttribute("aria-expanded")) !== "true")
      await button.click();
  };
  const expand = async (key) =>
    page.evaluate((key) => {
      const detail = [
        ...document.querySelectorAll("details[data-disclosure]"),
      ].find((node) => node.dataset.disclosure === key);
      if (!detail) throw new Error("Disclosure missing: " + key);
      if (!detail.open) {
        detail.open = true;
        detail.dispatchEvent(new Event("toggle"));
      }
    }, key);
  const dimensions = () =>
    page.evaluate(() => {
      const panel = document.getElementById("seed-report-v2"),
        body = panel.querySelector(".sr2-body");
      return {
        width: panel.getBoundingClientRect().width,
        bodyWidth: body.clientWidth,
        scrollWidth: body.scrollWidth,
        primaryFont: parseFloat(
          getComputedStyle(panel.querySelector(".sr2-metric-button")).fontSize,
        ),
      };
    });
  const desktop = await dimensions();
  assert.ok(
    desktop.width >= 600 && desktop.width <= 680,
    JSON.stringify(desktop),
  );
  assert.ok(desktop.primaryFont >= 12, JSON.stringify(desktop));
  const coral = await page.evaluate(() =>
    window.__noitamap
      .getAllDynamicPOIs()
      .filter((poi) => poi.chestVariant === "coral")
      .map((poi) => ({ id: poi.id, pw: poi.pw, biome: poi.biome })),
  );
  assert.equal(coral.length, 3);
  assert.ok(
    coral.every((poi) => poi.biome === "song_room"),
    JSON.stringify(coral),
  );
  const raw = await page.evaluate(() =>
    Object.values(window.noitamap.getGeneration().poisByPW)
      .flat()
      .filter((poi) => poi.chestVariant === "coral")
      .map((poi) => poi.biome),
  );
  assert.ok(raw.every((biome) => biome === "song_room"));
  await choose("chests");
  await expand("all|chests|biomes|song_room");
  assert.equal(
    await page
      .locator(
        'details[data-disclosure="all|chests|biomes|song_room"] .sr2-record',
      )
      .count(),
    3,
  );
  assert.equal(
    await page
      .locator(
        'details[data-disclosure="all|chests|biomes|desert"] .sr2-record[data-poi-id*="_11519_-4886_"]',
      )
      .count(),
    0,
  );
  const mainCoral = page.locator(
    `.sr2-record[data-poi-id="${coral.find((poi) => poi.pw === 0).id}"]`,
  );
  await mainCoral.locator("details > summary").click();
  await page.waitForFunction(
    (id) => {
      const record = document.querySelector(`.sr2-record[data-poi-id="${id}"]`),
        images = [...record.querySelectorAll(".sr2-loot-image")];
      return (
        images.length === 5 &&
        images.every(
          (image) => image.complete && image.naturalWidth > 1 && !image.hidden,
        )
      );
    },
    coral.find((poi) => poi.pw === 0).id,
  );
  const coralLabels = await mainCoral
    .locator(".sr2-loot-label")
    .allTextContents();
  assert.ok(coralLabels.some((label) => label.includes("Divide by 2")));
  const kammi = await page.evaluate(() => {
    const chest = window.__noitamap
      .getAllDynamicPOIs()
      .find((poi) => poi.items?.some((item) => item.item === "kammi"));
    if (!chest) throw new Error("Fixture seed has no Kammi chest");
    return { id: chest.id, biome: chest.biome };
  });
  await expand(`all|chests|biomes|${kammi.biome}`);
  for (
    let i = 0;
    i < 30 &&
    (await page.locator(`.sr2-record[data-poi-id="${kammi.id}"]`).count()) ===
      0;
    i++
  )
    await page
      .locator(
        `details[data-disclosure="all|chests|biomes|${kammi.biome}"] .sr2-show-more`,
      )
      .click();
  const kammiCard = page.locator(`.sr2-record[data-poi-id="${kammi.id}"]`);
  await kammiCard.locator("details > summary").click();
  await page.waitForFunction((id) => {
    const record = document.querySelector(`.sr2-record[data-poi-id="${id}"]`);
    const image = record.querySelector(".sr2-loot-image");
    return (
      image?.complete &&
      image.naturalWidth > 1 &&
      !image.hidden &&
      record.textContent.includes("Kammi")
    );
  }, kammi.id);
  const artwork = await kammiCard
    .locator(".sr2-loot-image")
    .evaluate((image) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let alpha = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) alpha++;
      return {
        width: canvas.width,
        height: canvas.height,
        painted: alpha,
        src: image.src,
      };
    });
  assert.ok(
    artwork.painted > 0 && artwork.src.startsWith("blob:"),
    JSON.stringify(artwork),
  );
  await kammiCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, "kammi-preview.png") });
  // Broad visual coverage uses real archive/atlas data even for rare loot
  // that may not happen to occur in this one seed's chest contents.
  const previews = await page.evaluate(async () => {
    const list = [
      { type: "item", item: "kammi" },
      { type: "item", item: "kuu" },
      { type: "item", item: "chaos_die" },
      { type: "item", item: "shiny_orb" },
      { type: "item", item: "potion", material: "ambrosia" },
      { type: "item", item: "spell", spell: "NOLLA" },
      { type: "item", item: "full_heal" },
      { type: "wand", sprite: "wand_0001" },
    ];
    const results = [];
    for (const poi of list) {
      const preview = await window.__noitamap.getPOIPreview(poi);
      if (!preview.iconUrl)
        throw new Error("Missing real sprite: " + JSON.stringify(poi));
      const image = new Image();
      image.src = preview.iconUrl;
      await image.decode();
      results.push({
        item: poi.item ?? poi.type,
        name: preview.name,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    }
    return results;
  });
  assert.equal(previews[0].name, "Kammi");
  assert.equal(
    previews.find((p) => p.item === "potion").name,
    "Potion · Ambrosia",
  );
  // Real renderer is tested in drawing-fill.browser.mjs. Here exercise the
  // same hotkey against the full built host->lazy-Pro loading path.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('label[for="drawToggleBtn"]').click();
  await page.waitForFunction(
    () => window.__noitamap?.isProFeatureReady?.("drawing"),
    undefined,
    { timeout: 45000 },
  );
  await page.locator("#drawing-sidebar.open").waitFor();
  await page.mouse.move(300, 300);
  await page.keyboard.press("c");
  assert.equal(await page.locator("#fill-alpha-none").isChecked(), true);
  await page.mouse.move(250, 250);
  await page.mouse.down();
  await page.mouse.move(400, 400, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(700, 400);
  assert.equal(await page.locator("#fill-alpha-none").isChecked(), true);
  assert.equal(await page.locator("#fill-alpha-3").isChecked(), false);
  const download = page.waitForEvent("download");
  await page.locator("#export-json-btn").click();
  const file = await download;
  const drawing = JSON.parse(await readFile(await file.path(), "utf8"));
  const outline = (drawing.shapes ?? drawing).find(
    (shape) => shape.type === "circle",
  );
  if (!outline) {
    await page.screenshot({ path: resolve(artifacts, "drawing-missing.png") });
    console.log(
      "DRAWING DEBUG",
      JSON.stringify(
        {
          drawing,
          state: await page.evaluate(() => ({
            tool: document.querySelector('input[name="drawing-tool"]:checked')
              ?.id,
            fill: document.querySelector('input[name="fill-alpha"]:checked')
              ?.id,
            active: document.activeElement?.outerHTML,
            canvases: [...document.querySelectorAll("canvas")].map((el) => ({
              id: el.id,
              rect: el.getBoundingClientRect().toJSON(),
              style: el.style.cssText,
            })),
          })),
        },
        null,
        2,
      ),
    );
  }
  assert.ok(outline);
  assert.equal(outline.fillAlpha ?? 0, 0);
  assert.equal(outline.filled ?? false, false);
  await page.screenshot({ path: resolve(artifacts, "circle-no-fill.png") });
  await page.mouse.move(700, 400);
  await page.keyboard.press("Shift+C");
  assert.equal(await page.locator("#fill-alpha-3").isChecked(), true);
  await page.locator('label[for="seedReportToggleBtn"]').click();
  await page.locator("#seed-report-v2:not([hidden])").waitFor();
  const sizes = [];
  for (const width of [1920, 1440, 1024, 768, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await dimensions();
    assert.ok(
      size.scrollWidth <= size.bodyWidth + 1,
      JSON.stringify({ width, ...size }),
    );
    sizes.push({ viewport: width, ...size });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(missing, []);
  const result = {
    seed: 306813029,
    desktop,
    coral,
    coralLabels,
    artwork,
    previews,
    sizes,
    errors,
    missing,
  };
  await writeFile(
    resolve(artifacts, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(
    "PASS: built host/Pro real generated seed, song_room coral chest, authored Kammi and material sprites, wider readable panel, no overflow and full-host C/Shift+C/export controls.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
