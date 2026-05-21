#!/usr/bin/env node
/**
 * Dump the full POI generation output for every historic daily seed.
 *
 * INPUT  : src/data/optional_data/dailySeeds.cleaned.csv (column "daily_seed")
 * OUTPUT : src/data/optional_data/historic-generations/<seed>.json
 *          per-seed JSON containing every POI emitted by telescope for PWs
 *          -1 / 0 / 1, with type, item, spell, material, biome, worldX/Y, etc.
 *
 * Mirrors build-daily-seed-stats.cjs (same dev-server + Playwright pattern)
 * but skips aggregation — the raw POI list is written verbatim so you can
 * spot-check what telescope produces before committing to derived stats.
 *
 * USAGE
 *   1. Start the dev server: `npm run dev`
 *   2. node build_scripts/dump-daily-seed-generations.cjs
 *
 * Optional flags:
 *   --url=http://localhost:5173   override dev server URL
 *   --limit=N                     process only the first N missing seeds
 *   --overwrite                   re-dump existing seeds instead of skipping
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OPT_DIR = path.join(ROOT, "src", "data", "optional_data");
const CSV_PATH = path.join(OPT_DIR, "dailySeeds.cleaned.csv");
const OUT_DIR = path.join(OPT_DIR, "historic-generations");

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((s) => s.replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((s) => s.replace(/^"|"$/g, ""));
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j];
    rows.push(row);
  }
  return rows;
}

function groupByPW(pois) {
  const out = { "-1": [], "0": [], "1": [] };
  for (const p of pois) {
    const key = String(p.pw ?? 0);
    if (!out[key]) out[key] = [];
    out[key].push(p);
  }
  return out;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? "true"] : [a, "true"];
    }),
  );
  const baseUrl = args.url || "http://localhost:5173";
  const limit = args.limit ? parseInt(args.limit, 10) : null;
  const overwrite = !!args.overwrite;

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[dump] missing input: ${CSV_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let playwright;
  try {
    playwright = require("playwright");
  } catch (e) {
    console.error(
      "[dump] playwright not installed.\n" +
      "  cd noitamap && npm install --save-dev playwright && npx playwright install chromium",
    );
    process.exit(1);
  }

  const rows = parseCSV(fs.readFileSync(CSV_PATH, "utf8"));
  const allSeeds = rows
    .map((r) => parseInt(r.daily_seed, 10))
    .filter((n) => Number.isFinite(n));

  const queue = overwrite
    ? allSeeds
    : allSeeds.filter((s) => !fs.existsSync(path.join(OUT_DIR, `${s}.json`)));
  console.log(`[dump] ${allSeeds.length} total seeds, ${queue.length} to dump`);

  const todo = limit ? queue.slice(0, limit) : queue;
  if (todo.length === 0) {
    console.log(`[dump] nothing to do — all seeds already dumped under ${OUT_DIR}`);
    return;
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.warn(`[browser] ${msg.text()}`);
  });

  let processed = 0;
  const startedAt = Date.now();
  for (const seed of todo) {
    const url = `${baseUrl}/?map=dynamic-main-branch&se=${seed}&ds=1`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForFunction(() => {
        const hooks = window.__noitamap;
        if (!hooks) return false;
        if (typeof hooks.getAllDynamicPOIs !== "function") return false;
        const state = hooks.getIndexingState && hooks.getIndexingState();
        if (state !== "ready") return false;
        return hooks.getAllDynamicPOIs().length > 0;
      }, { timeout: 120_000 });

      const pois = await page.evaluate(() => window.__noitamap.getAllDynamicPOIs());
      const byPW = groupByPW(pois);
      const payload = {
        seed,
        generatedAt: new Date().toISOString(),
        pwCounts: {
          "-1": byPW["-1"].length,
          "0": byPW["0"].length,
          "1": byPW["1"].length,
        },
        poisByPW: byPW,
      };
      fs.writeFileSync(path.join(OUT_DIR, `${seed}.json`), JSON.stringify(payload, null, 2));

      processed++;
      if (processed % 5 === 0 || processed === todo.length) {
        const rate = processed / ((Date.now() - startedAt) / 1000);
        const remaining = todo.length - processed;
        console.log(
          `[dump] ${processed}/${todo.length} (~${rate.toFixed(2)} seeds/s, ETA ${Math.round(remaining / rate)}s)`,
        );
      }
    } catch (e) {
      console.error(`[dump] seed ${seed} failed: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`[dump] done — files under ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
