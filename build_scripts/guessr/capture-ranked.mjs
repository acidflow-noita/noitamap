#!/usr/bin/env node
/** Local authoring, not a deployment. Generates unpublished seeds locally and
 * captures the exact main-map renderer. Never put its output in public CI. */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomInt } from "node:crypto";
import sharp from "sharp";
import { privateOutput } from "./private-output.mjs";

export async function captureRanked({
  url,
  out,
  day,
  graphics = "auto",
  executablePath = process.env.CHROMIUM_PATH,
}) {
  const host = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) {
    throw Error(
      "Use a local Noitamap server. Private seeds must not enter public URLs or analytics.",
    );
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day
  )
    throw Error("Invalid day.");
  const output = privateOutput(out);
  // Refuse to overwrite a previously reviewed challenge collection.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  const seed = randomInt(1, 2147483647);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args:
      graphics === "software"
        ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        : [],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 1100 },
      deviceScaleFactor: 1,
    });
    await context.route(
      /googletagmanager|google-analytics|cloudflareinsights/,
      (route) => route.abort(),
    );
    const page = await context.newPage();
    host.pathname = "/";
    host.search = "";
    for (const [key, value] of Object.entries({
      m: "dy",
      se: seed,
      nb: 1,
      x: 0,
      y: 700,
      z: 1000,
    }))
      host.searchParams.set(key, String(value));
    host.searchParams.set("terrain-presentation", "gpu");
    await page.goto(host.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForFunction(
      (seed) =>
        window.noitamap?.getGeneration()?.seed === seed &&
        !document.querySelector("#dynamicGenerateButton .spinner-border") &&
        !document
          .getElementById("map-loading-strip")
          ?.classList.contains("visible"),
      seed,
      { timeout: 180000 },
    );
    const questions = [];
    // Native procedural areas only; no fixed rooms or public daily seeds.
    const areas = [
      ["Mines", -400, 600],
      ["Coal Pits", -400, 2130],
      ["Snowy Depths", 0, 3900],
      ["Underground Jungle", 0, 7400],
      ["The Vault", 0, 9500],
    ];
    for (const [index, [biome, centreX, centreY]] of areas.entries()) {
      const x = centreX + randomInt(-350, 351),
        y = centreY + randomInt(-75, 76);
      const camera = await page.evaluate(
        ({ x, y }) => {
          const hooks = window.__noitamap,
            viewer = hooks.osd.viewer ?? hooks.osd;
          const source = viewer.world._items.find(
            (item) => item.source.__instantViewport,
          )?.source;
          if (!source || source.instantStats?.backend !== "main-gpu")
            throw Error(
              "A full-detail GPU viewport is required for private captures.",
            );
          for (const item of viewer.world._items)
            if (item._isMarkerLayer) item.setOpacity(0);
          viewer.element.dataset.guessrCapture = "true";
          const size = viewer.container.getBoundingClientRect();
          viewer.viewport.zoomTo(1 / size.width, undefined, true);
          const point = viewer.viewport.getCenter(true);
          point.x = x;
          point.y = y;
          viewer.viewport.panTo(point, true);
          viewer.forceRedraw();
          return { frame: source.instantViewportStats.frames };
        },
        { x, y },
      );
      await page.waitForFunction(
        ({ frame }) => {
          const hooks = window.__noitamap,
            viewer = hooks.osd.viewer ?? hooks.osd;
          const source = viewer.world._items.find(
            (item) => item.source.__instantViewport,
          )?.source;
          return (
            source?.instantViewportStats.frames > frame &&
            !source.isInstantTerrainBusy() &&
            viewer.world._items.every(
              (item) =>
                item.opacity === 0 ||
                !item.getDrawArea() ||
                item.source.__instantViewport ||
                item.getFullyLoaded(),
            )
          );
        },
        camera,
        { timeout: 90000 },
      );
      const geometry = await page.evaluate(() => {
        const hooks = window.__noitamap,
          viewer = hooks.osd.viewer ?? hooks.osd;
        const bounds = viewer.viewport.getBounds(true),
          rect = viewer.container.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          pixelWidth: rect.width,
          pixelHeight: rect.height,
        };
      });
      const scale = geometry.width / geometry.pixelWidth;
      if (
        Math.abs(scale - 1) > 0.001 ||
        Math.abs(geometry.x + geometry.width / 2 - x) > 0.01 ||
        Math.abs(geometry.y + geometry.height / 2 - y) > 0.01
      )
        throw Error(
          "Capture camera did not reach native scale and the requested centre.",
        );
      await page.mouse.move(0, 0);
      const image = await page
        .locator('[data-guessr-capture="true"]')
        .screenshot({ animations: "disabled" });
      const info = await sharp(image).metadata();
      if (info.width < 1024 || info.height < 768)
        throw Error("The viewport is too small for a native clue.");
      const left = Math.floor((info.width - 1024) / 2),
        top = Math.floor((info.height - 768) / 2);
      const pixels = await sharp(image)
        .extract({ left, top, width: 1024, height: 768 })
        .webp({ lossless: true })
        .toBuffer();
      const stats = await sharp(pixels).stats();
      if (stats.channels.slice(0, 3).every((c) => c.stdev < 5))
        throw Error(
          "A captured clue was empty or featureless. Review the local renderer.",
        );
      const filename = `round-${index + 1}.webp`;
      await writeFile(join(output, filename), pixels);
      questions.push({
        image: filename,
        name: `Exploring the ${biome}`,
        biome,
        seed,
        x: geometry.x + left + 512,
        y: geometry.y + top + 384,
      });
      console.log(`Captured private clue ${index + 1}/5 at native detail.`);
    }
    const pack = {
      version: 1,
      visibility: "private",
      days: [
        {
          day,
          title: "A new world to discover",
          enabled: false,
          roundSeconds: 90,
          bounds: { x: -17920, y: -6144, width: 36352, height: 26112 },
          questions,
        },
      ],
    };
    await writeFile(
      join(output, "questions.json"),
      JSON.stringify(pack, null, 2) + "\n",
    );
    return join(output, "questions.json");
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((value) => {
      const at = value.indexOf("=");
      return [value.slice(2, at), value.slice(at + 1)];
    }),
  );
  if (!args.url || !args.out || !args.day)
    throw Error(
      "Use --url=http://127.0.0.1:5173 --out=task/guessr/private/new-pack --day=YYYY-MM-DD",
    );
  const input = await captureRanked(args);
  console.log(
    `Private draft saved to ${input}. Review before enabling. Nothing uploaded.`,
  );
}
