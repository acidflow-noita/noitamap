import { chromium, firefox } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { startPreview } from "./preview.mjs";
const kind = process.argv[2] || "chromium",
  output = `task/guessr/ui-revision/${kind}`;
await mkdir(output, { recursive: true });
let preview, browser;
const report = { browser: kind, checks: [], errors: [], httpErrors: [] };
try {
  preview = await startPreview({
    port: kind === "chromium" ? 5198 : 5199,
    pro: true,
    quiet: true,
  });
  browser = await (kind === "firefox"
    ? firefox.launch({
        executablePath:
          process.env.FIREFOX_PATH ||
          (existsSync("/usr/bin/firefox") ? "/usr/bin/firefox" : undefined),
        channel: "moz-firefox",
        headless: true,
      })
    : chromium.launch({
        executablePath:
          process.env.CHROMIUM_PATH ||
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        headless: true,
      }));
  report.version = browser.version();
  const context = await browser.newContext({
      viewport: { width: 1440, height: 950 },
    }),
    page = await context.newPage();
  let requests = [];
  page.on("pageerror", (e) => report.errors.push(String(e)));
  page.on("request", (r) => requests.push(r.url()));
  page.on("response", (r) => {
    if (r.status() >= 400)
      report.httpErrors.push({ status: r.status(), url: r.url() });
  });
  const screenshot = async (name) =>
    page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  const saved = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("noitamap-guessr-practice-v1")),
    );
  const pack = JSON.parse(await readFile("task/guessr/site/pack.json", "utf8"));
  const pin = async (p) => {
    const screenPoint = () =>
      page.evaluate((p) => {
        const svg = document.querySelector("#guess-map svg"),
          pt = svg.createSVGPoint();
        pt.x = p.x;
        pt.y = p.y;
        const xy = pt.matrixTransform(svg.getScreenCTM());
        return { x: xy.x, y: xy.y };
      }, p);
    // Browser input coordinates are quantized to screen pixels. At full-world
    // fit one screen pixel exceeds the perfect-score tolerance; zoom first.
    const coarse = await screenPoint();
    await page.mouse.move(coarse.x, coarse.y);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
    const point = await screenPoint();
    await page.mouse.click(point.x, point.y);
  };
  await page.goto(preview.origin + "/guess/");
  await page.getByRole("button", { name: "Start demo", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Challenge link or code" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("combobox", { name: "Time per round" }).count(),
    0,
  );
  assert(
    !(await page.locator("body").innerText()).match(
      /expedition|instinct|Somewhere in|field journal/i,
    ),
  );
  const colors = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return {
      background: css.backgroundColor,
      surface: css.getPropertyValue("--surface-1"),
      oldAccent: css.getPropertyValue("--accent"),
    };
  });
  assert(colors.surface.includes("0.208"));
  assert.equal(colors.oldAccent, "");
  report.colors = colors;
  await screenshot("home");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  assert.equal((await saved()).order.length, 3);
  assert.equal(await page.locator("#camera-box, .context-frame").count(), 0);
  const demoOrder = (await saved()).order;
  await page.clock.install();
  await page.clock.fastForward(120000);
  assert.equal((await saved()).stage, "guess");
  await page.clock.resume();
  assert.equal(await page.locator("#round-clock").count(), 0);
  for (let i = 0; i < 3; i++) {
    const s = await saved(),
      place = pack.places.find((p) => p.id === s.order[i]);
    await page.waitForFunction(
      () =>
        document.querySelector(".clue canvas")?.dataset.ready === "true" ||
        document.querySelector(".clue img")?.complete,
    );
    if (i === 0) {
      await screenshot("round");
      assert.deepEqual(
        await page
          .locator(".clue canvas")
          .evaluate((img) => [img.width, img.height]),
        [27, 12],
      );
      await page
        .getByRole("button", { name: "Zoom out", exact: false })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector(".clue canvas")?.width === 54 &&
          document.querySelector(".clue canvas")?.dataset.ready === "true",
      );
      await page
        .getByRole("button", { name: "Travel east", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem("noitamap-guessr-practice-v1")).clue
            .dx === 49,
      );
      await page
        .getByRole("button", { name: "Return to start", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem("noitamap-guessr-practice-v1")).clue
            .dx === 0,
      );
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector(".clue canvas")?.width === 27 &&
          document.querySelector(".clue canvas")?.dataset.ready === "true",
      );
      assert.equal(
        await page.locator(".clue-maximum").innerText(),
        "Maximum score: 4,800",
      );
      await page.reload();
      await page.getByRole("button", { name: "Submit guess" }).waitFor();
      assert.equal(
        await page.locator(".clue-maximum").innerText(),
        "Maximum score: 4,800",
      );
      const fullBounds = await page
        .locator("#guess-map svg")
        .getAttribute("viewBox");
      assert.equal(
        fullBounds,
        `${pack.bounds.x} ${pack.bounds.y} ${pack.bounds.width} ${pack.bounds.height}`,
      );
      // Zoom at the entrance until the actual native (level 17) tiles are requested.
      const mapBox = await page.locator("#guess-map").boundingBox();
      await page.mouse.move(
        mapBox.x + mapBox.width / 2,
        mapBox.y + mapBox.height * 0.43,
      );
      const nativeTile = page.waitForResponse(
        (r) => r.url().includes("/map_files/17/") && r.status() === 200,
      );
      for (let z = 0; z < 27; z++) await page.mouse.wheel(0, -120);
      await nativeTile;
      await screenshot("native-map");
      await page.getByRole("button", { name: "Fit map", exact: true }).click();
    }
    await pin(place);
    await page.getByRole("button", { name: "Submit guess" }).click();
    await page.locator(".round-result").waitFor();
    await page.locator(".game-actions").getByRole("button", {
      name: i === 2 ? "View results" : "Next round", exact: true,
    }).click();
  }
  assert.equal(
    (await saved()).results.reduce((n, r) => n + r.score, 0),
    14800,
  );
  await screenshot("results");
  await page.getByRole("button", { name: "Replay demo" }).click();
  assert.deepEqual((await saved()).order, demoOrder);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  assert(!requests.some((u) => u.includes("/api/") || u.includes("/auth/")));
  report.checks.push(
    "shared Noitamap theme, plain copy, removed share/timer controls, fixed three-round demo, no auto-skip, refresh and replay",
    "native 27x12 clues, charged zoom/travel and free return, penalties preserved on refresh, full heaven/hell bounds and native map tiles",
  );
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Start daily" }).click();
  await page.getByRole("button", { name: "Submit guess" }).waitFor();
  const attemptId = new URL(page.url()).searchParams.get("a");
  assert(attemptId);
  for (let i = 0; i < 5; i++) {
    await page.waitForFunction(
      () =>
        document.querySelector(".clue canvas")?.dataset.ready === "true" ||
        document.querySelector(".clue img")?.complete,
    );
    await pin(preview.questions[i]);
    await page.getByRole("button", { name: "Submit guess" }).click();
    await page.locator(".game-actions")
      .getByRole("button", {
        name: i === 4 ? "View results" : "Next round",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("#guess-map circle").count(), 2);
    await page.locator(".game-actions")
      .getByRole("button", {
        name: i === 4 ? "View results" : "Next round",
        exact: true,
      })
      .click();
  }
  await page.locator(".total").waitFor();
  assert.equal(
    (await page.locator(".total").innerText()).replaceAll(",", ""),
    "25000",
  );
  await screenshot("daily-results");
  const row = await preview.db
    .prepare("SELECT score,elapsed_ms FROM attempts WHERE id=?")
    .bind(attemptId)
    .first();
  assert.equal(row.score, 25000);
  assert.equal(row.elapsed_ms, 0);
  await page.locator("a.brand").click();
  await page.getByRole("button", { name: "Yesterday", exact: true }).click();
  assert(
    requests.some((u) =>
      u.includes(
        "/api/daily?day=" +
          new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      ),
    ),
  );
  report.checks.push(
    "daily has no timer; individual result shown after each guess; final score shown immediately; yesterday selected by date",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("a.brand").click();
  await screenshot("mobile-home");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await screenshot("mobile-round");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  report.checks.push("mobile layout without horizontal overflow");
  report.pass = !report.errors.length && !report.httpErrors.length;
} catch (e) {
  report.pass = false;
  report.failure = String(e);
  console.error(e);
} finally {
  await browser?.close();
  await preview?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
