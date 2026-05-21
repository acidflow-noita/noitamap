#!/usr/bin/env node
/**
 * Build per-PW spider-chart stats for every historic daily seed.
 *
 * INPUT  : src/data/optional_data/dailySeeds.cleaned.csv (column "daily_seed")
 * OUTPUT : src/data/optional_data/daily-seed-stats.json
 *          { seeds: [seed, ...],
 *            stats: { [seed]: { "-1": SpiderAxes, "0": SpiderAxes, "1": SpiderAxes } },
 *            averages: { "-1": SpiderAxes, "0": SpiderAxes, "1": SpiderAxes },
 *            generatedAt: ISODate, count: number }
 *
 * EXECUTION
 *   - Spawns a Playwright Chromium and opens the locally-running
 *     noitamap dev server (default http://localhost:5173).
 *   - For each seed in the CSV, navigates to ?se=<seed>&ds=1, waits until
 *     indexing finishes, then reads window.__noitamap.getAllDynamicPOIs().
 *   - Aggregates via the same logic as noitamap-pro/src/seed-report/aggregate.ts
 *     and persists results incrementally so a long run can be Ctrl-C resumed.
 *
 * USAGE
 *   1. Start the dev server: `npm run dev` (in noitamap/)
 *   2. In another shell:    `node build_scripts/build-daily-seed-stats.cjs`
 *
 * Optional flags:
 *   --url=http://localhost:5173   override dev server URL
 *   --limit=N                     process only the first N seeds (smoke test)
 *   --restart                     ignore existing output and recompute everything
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OPT_DIR = path.join(ROOT, "src", "data", "optional_data");
const CSV_PATH = path.join(OPT_DIR, "dailySeeds.cleaned.csv");
const OUT_PATH = path.join(OPT_DIR, "daily-seed-stats.json");

// ─── Aggregation (mirror of noitamap-pro/src/seed-report/aggregate.ts) ──────
const HEART_ITEMS = new Set(["heart", "heart_bigger", "heart_extra", "full_heal"]);
const POTION_ITEMS = new Set(["potion", "potion_normal", "potion_random", "potion_secret"]);
const POUCH_ITEMS = new Set(["pouch", "powder_stash", "powder_stash_pouch"]);
const MIMIC_ITEMS = new Set([
  "mimic",
  "heart_mimic",
  "refresh_mimic",
  "mimic_potion",
  "potion_mimic_empty",
]);
const DANGEROUS_ENTITIES = new Set(["thundermage", "thundermage_big"]);
const RARE_MATERIAL_IDS = new Set([
  "ambrosia",
  "magic_liquid_hp_regeneration",
  "magic_liquid_hp_regeneration_unstable",
  "just_death",
  "urine",
]);

// Spell IDs that count as "high-value" — kept in sync with
// noitamap-pro/src/high-value/high-value-list.json + categories.ts
const HV_SPELL_CATEGORIES = [
  /^(ADD_TRIGGER|ADD_TIMER|ADD_DEATH_TRIGGER)$/,
  /(_TRIGGER|_TIMER)(_\d+)?$/,
  /^LASER_LUMINOUS_DRILL$/,
  /^DIVIDE_(2|3|4|10)$/,
  /^MATERIAL_(WATER|OIL)$/,
  /^(HEAL_BULLET|ANTIHEAL|REGENERATION_FIELD)$/,
  /^NOLLA$/,
  /^(ALPHA|GAMMA|TAU|MU|SIGMA|ZETA|PHI|OMEGA)$/,
  /^SUMMON_WANDGHOST$/,
];

function isHVSpell(spellId) {
  if (!spellId) return false;
  return HV_SPELL_CATEGORIES.some((rx) => rx.test(spellId));
}

const SPIDER_AXIS_ORDER = [
  "greatChests",
  "chests",
  "shops",
  "wands",
  "hearts",
  "potions",
  "pouches",
  "hvSpells",
  "rareMaterials",
  "mimics",
  "dangerousCreatures",
];

function emptyAxes() {
  const o = {};
  for (const k of SPIDER_AXIS_ORDER) o[k] = 0;
  return o;
}

function aggregateSpiderAxes(pois) {
  const out = {};
  function pwBucket(pw) {
    if (!out[pw]) out[pw] = emptyAxes();
    return out[pw];
  }
  for (const poi of pois) {
    const pw = poi.pw ?? 0;
    const a = pwBucket(pw);
    const t = poi.type;
    if (t === "great_chest") a.greatChests++;
    else if (t === "chest") a.chests++;
    else if (t === "shop") a.shops++;
    else if (t === "wand") a.wands++;
    else if (t === "item") {
      const it = poi.item;
      if (!it) continue;
      if (HEART_ITEMS.has(it)) a.hearts++;
      else if (POTION_ITEMS.has(it)) a.potions++;
      else if (POUCH_ITEMS.has(it)) a.pouches++;
      else if (MIMIC_ITEMS.has(it)) a.mimics++;
      else if (it === "spell" && poi.spell && isHVSpell(String(poi.spell))) a.hvSpells++;
    } else if (t === "spell") {
      if (poi.item && isHVSpell(String(poi.item))) a.hvSpells++;
    } else if (t === "entity") {
      const ent = poi.entity ? String(poi.entity).split("/").pop().replace(/\.xml$/i, "") : null;
      if (ent && DANGEROUS_ENTITIES.has(ent)) a.dangerousCreatures++;
    }
    if (poi.material && RARE_MATERIAL_IDS.has(poi.material)) a.rareMaterials++;
  }
  return out;
}

// ─── CSV ────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  // Minimal CSV reader — assumes no quoted commas, only quoted strings.
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

// ─── Output helpers ─────────────────────────────────────────────────────────
function loadExisting() {
  if (!fs.existsSync(OUT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch (e) {
    console.warn(`[stats] could not parse existing ${OUT_PATH}: ${e.message}`);
    return null;
  }
}

function computeAverages(stats) {
  const sums = { "-1": emptyAxes(), "0": emptyAxes(), "1": emptyAxes() };
  const counts = { "-1": 0, "0": 0, "1": 0 };
  for (const seed of Object.keys(stats)) {
    for (const pwKey of ["-1", "0", "1"]) {
      const ax = stats[seed][pwKey];
      if (!ax) continue;
      for (const k of SPIDER_AXIS_ORDER) sums[pwKey][k] += ax[k] ?? 0;
      counts[pwKey]++;
    }
  }
  const out = { "-1": emptyAxes(), "0": emptyAxes(), "1": emptyAxes() };
  for (const pwKey of ["-1", "0", "1"]) {
    if (counts[pwKey] === 0) continue;
    for (const k of SPIDER_AXIS_ORDER) out[pwKey][k] = sums[pwKey][k] / counts[pwKey];
  }
  return out;
}

function writeOutput(stats) {
  const seeds = Object.keys(stats).map(Number).sort((a, b) => a - b);
  const payload = {
    seeds,
    stats,
    averages: computeAverages(stats),
    count: seeds.length,
    axisOrder: SPIDER_AXIS_ORDER,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
}

// ─── Playwright orchestration ───────────────────────────────────────────────
async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? "true"] : [a, "true"];
    }),
  );
  const baseUrl = args.url || "http://localhost:5173";
  const limit = args.limit ? parseInt(args.limit, 10) : null;
  const restart = !!args.restart;

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[stats] missing input: ${CSV_PATH}`);
    process.exit(1);
  }

  let playwright;
  try {
    playwright = require("playwright");
  } catch (e) {
    console.error(
      "[stats] playwright not installed.\n" +
      "  cd noitamap && npm install --save-dev playwright && npx playwright install chromium",
    );
    process.exit(1);
  }

  const rows = parseCSV(fs.readFileSync(CSV_PATH, "utf8"));
  const allSeeds = rows
    .map((r) => parseInt(r.daily_seed, 10))
    .filter((n) => Number.isFinite(n));
  console.log(`[stats] loaded ${allSeeds.length} seeds from CSV`);

  const existing = restart ? null : loadExisting();
  const stats = existing?.stats ?? {};
  const queue = allSeeds.filter((s) => !stats[s]);
  console.log(`[stats] ${Object.keys(stats).length} already computed, ${queue.length} to go`);

  const todo = limit ? queue.slice(0, limit) : queue;
  if (todo.length === 0) {
    writeOutput(stats);
    console.log(`[stats] nothing to do — output is up to date at ${OUT_PATH}`);
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
      // Wait for the pro/main hooks to expose getAllDynamicPOIs AND for
      // indexing to finish (no-creatures filter must NOT apply here — use
      // getAllDynamicPOIs).
      await page.waitForFunction(() => {
        const hooks = window.__noitamap;
        if (!hooks) return false;
        if (typeof hooks.getAllDynamicPOIs !== "function") return false;
        const state = hooks.getIndexingState && hooks.getIndexingState();
        if (state !== "ready") return false;
        return hooks.getAllDynamicPOIs().length > 0;
      }, { timeout: 120_000 });

      const pois = await page.evaluate(() => window.__noitamap.getAllDynamicPOIs());
      const axes = aggregateSpiderAxes(pois);
      // Pad with empty PWs so downstream code can rely on -1/0/1 always present.
      stats[seed] = {
        "-1": axes["-1"] ?? emptyAxes(),
        "0": axes["0"] ?? emptyAxes(),
        "1": axes["1"] ?? emptyAxes(),
      };
      processed++;
      if (processed % 5 === 0 || processed === todo.length) {
        writeOutput(stats);
        const rate = processed / ((Date.now() - startedAt) / 1000);
        const remaining = todo.length - processed;
        console.log(
          `[stats] ${processed}/${todo.length} done (~${rate.toFixed(2)} seeds/s, ETA ${Math.round(remaining / rate)}s)`,
        );
      }
    } catch (e) {
      console.error(`[stats] seed ${seed} failed: ${e.message}`);
      writeOutput(stats); // persist progress even on failure
    }
  }

  writeOutput(stats);
  await browser.close();
  console.log(`[stats] done — wrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
