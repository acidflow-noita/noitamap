#!/usr/bin/env node
/**
 * Bake per-PW dot-plot axes AND per-biome report counts for every historic
 * daily seed. The output drives:
 *   - the "Average baseline" dot on the seed-report per-PW dot plot
 *     (averages.axes per PW)
 *   - per-biome averages for the report table baseline
 *     (averages.biomes per PW per biome slug)
 *
 * INPUT  : src/data/optional_data/dailySeeds.cleaned.csv (column "daily_seed")
 * OUTPUT : src/data/optional_data/daily-seed-stats.json
 *   {
 *     seeds: [seed, ...],
 *     stats: {
 *       [seed]: {
 *         axes:         { "-1": Axes, "0": Axes, "1": Axes },
 *         axesMainPath: { "-1": Axes, "0": Axes, "1": Axes }, // main-path biomes only
 *         biomes: {
 *           "-1": { [biomeSlug]: BiomeCounts },
 *           "0":  { ... },
 *           "1":  { ... }
 *         }
 *       }
 *     },
 *     averages: {
 *       axes:         { "-1": Axes, "0": Axes, "1": Axes },
 *       axesMainPath: { "-1": Axes, "0": Axes, "1": Axes },
 *       biomes: {
 *         "-1": { [biomeSlug]: BiomeCounts },
 *         "0":  { ... },
 *         "1":  { ... }
 *       }
 *     },
 *     count, axisOrder, biomeMetrics, generatedAt
 *   }
 *
 * SECONDARY OUTPUT (committed, shippable): the axes averages (full world AND
 * main-path-only) are baked into noitamap-pro/src/seed-report/daily-seed-baseline.json
 * so the pro seed report can ship the "Average baseline" series (which tracks
 * the "main path only" toggle) without the gitignored json.
 *
 * EXECUTION
 *   - Launches a headless Playwright Chromium.
 *   - A pool of N pages (default 4, --concurrency=N) processes seeds in
 *     parallel. Each page navigates to `?se=<seed>&u=all`, waits for indexing,
 *     reads window.__noitamap.getAllDynamicPOIs(), and aggregates.
 *   - Progress is persisted incrementally (every PERSIST_EVERY_MS) so a
 *     long run can be Ctrl-C'd and resumed.
 *
 * USAGE
 *   1. Start the dev server: `npm run dev` (in noitamap/)
 *   2. In another shell:    `node build_scripts/build-daily-seed-stats.cjs`
 *
 * Optional flags:
 *   --url=http://localhost:5173   override dev server URL
 *   --limit=N                     process only the first N pending seeds (smoke test)
 *   --concurrency=N               number of parallel pages (default 4)
 *   --restart                     ignore existing output and recompute everything
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OPT_DIR = path.join(ROOT, "src", "data", "optional_data");
const CSV_PATH = path.join(OPT_DIR, "dailySeeds.cleaned.csv");
const OUT_PATH = path.join(OPT_DIR, "daily-seed-stats.json");
// Small, shippable extract (axes averages only) consumed by the pro seed
// report's "Average baseline" series. The full OUT_PATH json is gitignored
// and far too large to ship, so we bake just the averages into pro's source.
const PRO_BASELINE_PATH = path.resolve(
  ROOT, "..", "noitamap-pro", "src", "seed-report", "daily-seed-baseline.json",
);

const PERSIST_EVERY_MS = 5000;
const NAV_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 180_000;

// ─── Aggregation (mirror of noitamap-pro/src/seed-report aggregate logic) ───
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

// HV-spell regex set — kept in sync with
// noitamap-pro/src/seed-report/categories.ts (the `classifySpell` patterns).
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

const BIOME_METRICS = ["chests", "greatChests", "wands", "hvSpells", "rareMaterialsTotal"];

const UNKNOWN_BIOME = "Unknown";

function emptyAxes() {
  const o = {};
  for (const k of SPIDER_AXIS_ORDER) o[k] = 0;
  return o;
}

function emptyBiomeCounts() {
  const o = {};
  for (const k of BIOME_METRICS) o[k] = 0;
  return o;
}

// Averages are reported as 2-decimal floats (e.g. 3.71). Per-seed counts stay
// integers; only the cross-seed averages carry a fraction, and two decimals is
// enough precision for the baseline dots/labels.
const round2 = (n) => Math.round(n * 100) / 100;

function normaliseBiomeSlug(raw) {
  if (!raw) return UNKNOWN_BIOME;
  return String(raw).replace(/^\$?biome_/, "");
}

// Main-path biome slugs, parsed at runtime from the public source of truth
// (noitamap/src/data_sources/main-path-biomes.ts) so this script never holds a
// hand-maintained copy that can drift from the sidebar's "main path only"
// filter.
function loadMainPathSlugs() {
  const tsPath = path.join(ROOT, "src", "data_sources", "main-path-biomes.ts");
  const text = fs.readFileSync(tsPath, "utf8");
  const block = text.match(/MAIN_PATH_BIOMES\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error(`[stats] could not parse MAIN_PATH_BIOMES from ${tsPath}`);
  const slugs = (block[1].match(/["']([^"']+)["']/g) || []).map((s) => s.replace(/["']/g, ""));
  if (slugs.length === 0) throw new Error(`[stats] MAIN_PATH_BIOMES parsed empty from ${tsPath}`);
  return new Set(slugs);
}
const MAIN_PATH_SLUGS = loadMainPathSlugs();
const isMainPathSlug = (slug) => MAIN_PATH_SLUGS.has(slug);

function getSpellIdFromPoi(poi) {
  if (poi.type === "item" && poi.item === "spell" && poi.spell) return String(poi.spell);
  if (poi.type === "spell" && poi.item) return String(poi.item);
  return null;
}

/** Per-PW dot-plot axis counts for a single POI, applied to bucket `a`. Single
 *  source so the full-world and main-path-only accumulators can never drift.
 *  Mirror of pro's aggregateSpiderAxes. */
function applyAxisCounts(a, poi) {
  const t = poi.type;
  if (t === "great_chest") a.greatChests++;
  else if (t === "chest") a.chests++;
  else if (t === "shop") a.shops++;
  else if (t === "wand") a.wands++;
  else if (t === "item") {
    const it = poi.item;
    if (it) {
      if (HEART_ITEMS.has(it)) a.hearts++;
      else if (POTION_ITEMS.has(it)) a.potions++;
      else if (POUCH_ITEMS.has(it)) a.pouches++;
      else if (MIMIC_ITEMS.has(it)) a.mimics++;
      else if (it === "spell" && poi.spell && isHVSpell(String(poi.spell))) a.hvSpells++;
    }
  } else if (t === "spell") {
    if (poi.item && isHVSpell(String(poi.item))) a.hvSpells++;
  } else if (t === "entity") {
    const ent = poi.entity ? String(poi.entity).split("/").pop().replace(/\.xml$/i, "") : null;
    if (ent && DANGEROUS_ENTITIES.has(ent)) a.dangerousCreatures++;
  }
  if (poi.material && RARE_MATERIAL_IDS.has(poi.material)) a.rareMaterials++;
}

/** Walks the flat POI list once, producing the per-PW dot-plot axes (full world
 *  AND main-path-only) plus the per-biome counts. Mirrors what the seed
 *  report's aggregateSpiderAxes and aggregate produce, but counts only - no
 *  refs/coords are persisted (we don't need them for averages or diffs). */
function aggregateAll(pois) {
  const axes = {};
  const axesMainPath = {};
  const biomes = {};

  function axesBucket(pw) {
    if (!axes[pw]) axes[pw] = emptyAxes();
    return axes[pw];
  }
  function axesMainPathBucket(pw) {
    if (!axesMainPath[pw]) axesMainPath[pw] = emptyAxes();
    return axesMainPath[pw];
  }
  function biomeBucket(pw, slug) {
    if (!biomes[pw]) biomes[pw] = {};
    if (!biomes[pw][slug]) biomes[pw][slug] = emptyBiomeCounts();
    return biomes[pw][slug];
  }

  for (const poi of pois) {
    const pw = poi.pw ?? 0;
    const slug = normaliseBiomeSlug(poi.biome);
    const b = biomeBucket(pw, slug);
    const t = poi.type;

    // Per-PW axes (drives the dot plot's average-baseline series). The
    // main-path bucket gets the SAME counts gated on biome membership, so its
    // baseline matches the sidebar's live "main path only" filter.
    applyAxisCounts(axesBucket(pw), poi);
    if (isMainPathSlug(slug)) applyAxisCounts(axesMainPathBucket(pw), poi);

    // Per-biome counts (mirror of pro's aggregate.ts BiomeStats counts).
    if (t === "chest" || t === "pacifist_chest") b.chests++;
    else if (t === "great_chest") b.greatChests++;
    else if (t === "wand") b.wands++;
    const spellId = getSpellIdFromPoi(poi);
    if (spellId && isHVSpell(spellId)) b.hvSpells++;
    if (poi.material && RARE_MATERIAL_IDS.has(poi.material)) b.rareMaterialsTotal++;
  }

  return { axes, axesMainPath, biomes };
}

// ─── CSV ────────────────────────────────────────────────────────────────────
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

// ─── Output helpers ─────────────────────────────────────────────────────────
function loadExisting() {
  if (!fs.existsSync(OUT_PATH)) return null;
  let raw;
  try {
    raw = fs.readFileSync(OUT_PATH, "utf8");
  } catch (e) {
    console.warn(`[stats] could not read existing ${OUT_PATH}: ${e.message}`);
    return null;
  }
  // Empty / whitespace-only output (e.g. a previous run was killed mid-write
  // or the file was truncated) is not an error — just treat it as "no
  // existing data" and start fresh.
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[stats] could not parse existing ${OUT_PATH} (${e.message}) — starting fresh`);
    return null;
  }
}

function migrateLegacyEntry(entry) {
  // Older runs stored stats[seed] = { "-1": axes, "0": axes, "1": axes }
  // (flat-PW axes only). Promote to the new { axes, biomes } shape so a
  // partial recompute can resume without re-running every seed for axes.
  if (entry && typeof entry === "object" && entry.axes && entry.biomes) return entry;
  if (entry && typeof entry === "object") {
    const flatAxes = {};
    let foundAxis = false;
    for (const pw of ["-1", "0", "1"]) {
      if (entry[pw]) {
        flatAxes[pw] = entry[pw];
        foundAxis = true;
      }
    }
    if (foundAxis) {
      return { axes: flatAxes, biomes: null }; // biomes:null marks "needs recompute"
    }
  }
  return null;
}

function computeAverages(stats) {
  // Axes averages - full world AND main-path-only (two parallel accumulators),
  // each per PW.
  const axesSums = { "-1": emptyAxes(), "0": emptyAxes(), "1": emptyAxes() };
  const axesCounts = { "-1": 0, "0": 0, "1": 0 };
  const axesMainSums = { "-1": emptyAxes(), "0": emptyAxes(), "1": emptyAxes() };
  const axesMainCounts = { "-1": 0, "0": 0, "1": 0 };
  for (const seedKey of Object.keys(stats)) {
    const entry = stats[seedKey];
    if (entry?.axes) {
      for (const pwKey of ["-1", "0", "1"]) {
        const ax = entry.axes[pwKey];
        if (!ax) continue;
        for (const k of SPIDER_AXIS_ORDER) axesSums[pwKey][k] += ax[k] ?? 0;
        axesCounts[pwKey]++;
      }
    }
    if (entry?.axesMainPath) {
      for (const pwKey of ["-1", "0", "1"]) {
        const ax = entry.axesMainPath[pwKey];
        if (!ax) continue;
        for (const k of SPIDER_AXIS_ORDER) axesMainSums[pwKey][k] += ax[k] ?? 0;
        axesMainCounts[pwKey]++;
      }
    }
  }
  const axesAvg = { "-1": emptyAxes(), "0": emptyAxes(), "1": emptyAxes() };
  const axesMainAvg = { "-1": emptyAxes(), "0": emptyAxes(), "1": emptyAxes() };
  for (const pwKey of ["-1", "0", "1"]) {
    if (axesCounts[pwKey] > 0)
      for (const k of SPIDER_AXIS_ORDER) axesAvg[pwKey][k] = round2(axesSums[pwKey][k] / axesCounts[pwKey]);
    if (axesMainCounts[pwKey] > 0)
      for (const k of SPIDER_AXIS_ORDER) axesMainAvg[pwKey][k] = round2(axesMainSums[pwKey][k] / axesMainCounts[pwKey]);
  }

  // Per-biome averages — keyed by (pw, biomeSlug).
  // For a given biome we average across seeds that *have* that biome (which is
  // every seed in practice — biomes are static — but defend against missing
  // entries from legacy data anyway).
  const biomeSums = { "-1": {}, "0": {}, "1": {} };
  const biomeCounts = { "-1": {}, "0": {}, "1": {} };
  for (const seedKey of Object.keys(stats)) {
    const entry = stats[seedKey];
    if (!entry?.biomes) continue;
    for (const pwKey of ["-1", "0", "1"]) {
      const pwBiomes = entry.biomes[pwKey];
      if (!pwBiomes) continue;
      for (const [slug, counts] of Object.entries(pwBiomes)) {
        if (!biomeSums[pwKey][slug]) {
          biomeSums[pwKey][slug] = emptyBiomeCounts();
          biomeCounts[pwKey][slug] = 0;
        }
        for (const k of BIOME_METRICS) biomeSums[pwKey][slug][k] += counts[k] ?? 0;
        biomeCounts[pwKey][slug]++;
      }
    }
  }
  const biomesAvg = { "-1": {}, "0": {}, "1": {} };
  for (const pwKey of ["-1", "0", "1"]) {
    for (const slug of Object.keys(biomeSums[pwKey])) {
      const n = biomeCounts[pwKey][slug] || 1;
      biomesAvg[pwKey][slug] = emptyBiomeCounts();
      for (const k of BIOME_METRICS) biomesAvg[pwKey][slug][k] = round2(biomeSums[pwKey][slug][k] / n);
    }
  }

  return { axes: axesAvg, axesMainPath: axesMainAvg, biomes: biomesAvg };
}

function writeOutput(stats) {
  const seeds = Object.keys(stats).map(Number).sort((a, b) => a - b);
  const payload = {
    seeds,
    stats,
    averages: computeAverages(stats),
    count: seeds.length,
    axisOrder: SPIDER_AXIS_ORDER,
    biomeMetrics: BIOME_METRICS,
    generatedAt: new Date().toISOString(),
  };
  // Atomic write: serialise to a temp file in the same dir, then rename.
  // If the script is killed mid-write we never leave a 0-byte JSON on disk
  // (which would currently surface as "Unexpected end of JSON input" on the
  // next run's load).
  const tmp = OUT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, OUT_PATH);
}

/** Bake the axes averages into the pro seed report's shippable baseline file.
 *  Call at end-of-run only (not on the incremental persist cadence). No-op if
 *  the sibling pro checkout isn't present. */
function writeProBaseline(stats) {
  const dir = path.dirname(PRO_BASELINE_PATH);
  if (!fs.existsSync(dir)) {
    console.warn(`[stats] pro seed-report dir not found, skipping baseline export: ${dir}`);
    return;
  }
  const { axes, axesMainPath } = computeAverages(stats);
  const payload = {
    count: Object.keys(stats).length,
    generatedAt: new Date().toISOString(),
    axes,
    axesMainPath,
  };
  fs.writeFileSync(PRO_BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[stats] wrote pro baseline extract (${payload.count} seeds) -> ${PRO_BASELINE_PATH}`);
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
  const concurrency = Math.max(1, parseInt(args.concurrency || "4", 10));
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
    .filter((n) => Number.isFinite(n) && n > 0);
  console.log(`[stats] loaded ${allSeeds.length} seeds from CSV`);

  // Probe the dev server up-front. Without this the worker pool spawns N
  // Playwright pages that all retry-and-time-out for 90s each before failing,
  // which looks like the script is hanging when really the dev server just
  // isn't running.
  try {
    const probe = await fetch(baseUrl, { method: "GET" });
    if (!probe.ok) {
      console.error(`[stats] dev server at ${baseUrl} returned HTTP ${probe.status}. Run \`npm run dev\` first.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[stats] could not reach dev server at ${baseUrl}: ${e.message}. Run \`npm run dev\` first.`);
    process.exit(1);
  }

  // Load existing and migrate legacy entries.
  const existing = restart ? null : loadExisting();
  const stats = {};
  if (existing?.stats) {
    for (const [seedKey, entry] of Object.entries(existing.stats)) {
      const migrated = migrateLegacyEntry(entry);
      if (migrated) stats[seedKey] = migrated;
    }
  }

  // A seed needs (re)computing when its axes, biomes, OR main-path axes are
  // missing. This re-runs legacy entries to fill in the new axesMainPath field.
  const queue = allSeeds.filter((s) => {
    const e = stats[s];
    return !e || !e.axes || !e.biomes || !e.axesMainPath;
  });
  console.log(
    `[stats] ${Object.keys(stats).length} cached, ${queue.length} to (re)compute`,
  );

  const todo = limit ? queue.slice(0, limit) : queue;
  if (todo.length === 0) {
    writeOutput(stats);
    writeProBaseline(stats);
    console.log(`[stats] nothing to do — output is up to date at ${OUT_PATH}`);
    return;
  }

  const browser = await playwright.chromium.launch({ headless: true });

  // ─── Mutable shared state for the worker pool ──────────────────────────
  const pending = todo.slice();
  let processed = 0;
  const startedAt = Date.now();

  // Persist progress on a steady cadence rather than after every seed —
  // computing averages over thousands of entries on every write would dwarf
  // the actual work. The interval is cleared in finally{} below.
  let dirty = false;
  const persistTimer = setInterval(() => {
    if (dirty) {
      dirty = false;
      writeOutput(stats);
    }
  }, PERSIST_EVERY_MS);

  function logProgress() {
    const rate = processed / ((Date.now() - startedAt) / 1000);
    const remaining = todo.length - processed;
    const eta = rate > 0 ? Math.round(remaining / rate) : "?";
    console.log(
      `[stats] ${processed}/${todo.length} done (~${rate.toFixed(2)} seeds/s, ETA ${eta}s)`,
    );
  }

  async function worker(workerId) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const txt = msg.text();
        // Suppress noise that doesn't affect generation: favicon/404 asset
        // misses and net::ERR_NAME_NOT_RESOLVED (an optional remote host —
        // auth/daily-seed/analytics — that dynamic POI gen never depends on).
        if (!/favicon|404|ERR_NAME_NOT_RESOLVED/i.test(txt)) console.warn(`[w${workerId}] ${txt}`);
      }
    });

    while (true) {
      const seed = pending.shift();
      if (seed === undefined) break;

      // IMPORTANT: do NOT pass ds=1 here. resolveSeed() treats ds=1 as
      // "daily seed mode" and ignores ?se=, fetching TODAY's daily seed
      // instead — every seed would generate the same world. Pass the seed
      // explicitly and force all unlocks on with u=all, which reproduces the
      // daily seed's content (all unlocks) without the seed override.
      const url = `${baseUrl}/?map=dynamic-main-branch&se=${seed}&u=all`;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await page.waitForFunction(() => {
          const hooks = window.__noitamap;
          if (!hooks) return false;
          if (typeof hooks.getAllDynamicPOIs !== "function") return false;
          const state = hooks.getIndexingState && hooks.getIndexingState();
          if (state !== "ready") return false;
          return hooks.getAllDynamicPOIs().length > 0;
          // NOTE: options is the THIRD arg of waitForFunction(fn, arg, options).
          // Passing { timeout } as the 2nd arg makes Playwright treat it as the
          // page-function argument and silently fall back to its 30s default,
          // so the 180s budget below was being dropped. Pass undefined for arg.
        }, undefined, { timeout: READY_TIMEOUT_MS });

        const pois = await page.evaluate(() => window.__noitamap.getAllDynamicPOIs());
        const { axes, axesMainPath, biomes } = aggregateAll(pois);
        // Pad with empty PWs so the consumer can rely on -1/0/1 always present.
        stats[seed] = {
          axes: {
            "-1": axes["-1"] ?? emptyAxes(),
            "0":  axes["0"]  ?? emptyAxes(),
            "1":  axes["1"]  ?? emptyAxes(),
          },
          axesMainPath: {
            "-1": axesMainPath["-1"] ?? emptyAxes(),
            "0":  axesMainPath["0"]  ?? emptyAxes(),
            "1":  axesMainPath["1"]  ?? emptyAxes(),
          },
          biomes: {
            "-1": biomes["-1"] ?? {},
            "0":  biomes["0"]  ?? {},
            "1":  biomes["1"]  ?? {},
          },
        };
        processed++;
        dirty = true;
        if (processed % 5 === 0 || processed === todo.length) logProgress();
      } catch (e) {
        console.error(`[w${workerId}] seed ${seed} failed: ${e.message}`);
      }
    }

    await page.close();
    await ctx.close();
  }

  try {
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) => worker(i)),
    );
  } finally {
    clearInterval(persistTimer);
    writeOutput(stats);
    writeProBaseline(stats);
    await browser.close();
  }
  console.log(`[stats] done — wrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
