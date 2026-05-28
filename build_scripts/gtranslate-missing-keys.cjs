#!/usr/bin/env node
/**
 * MANUAL TOOL — gtranslate-missing-keys.cjs
 *
 * Walks the entire en/translation.json tree and fills in missing or stale
 * leaf values across every other locale in src/locales/ using Google's
 * public translate_a/single endpoint. Existing non-English values are
 * LEFT ALONE — only fills entries that are:
 *
 *   - missing entirely, or
 *   - present but identical to the English source (placeholder copy)
 *
 * Run:
 *   node build_scripts/gtranslate-missing-keys.cjs
 *
 * Optional env:
 *   GT_ONLY=ru,de              # restrict to specific locales
 *   GT_DRY=1                   # report counts but do not write files
 *   GT_KEY_PREFIX=unlocks      # restrict to keys starting with this dotted prefix
 *
 * No external deps; uses node's https + the unauthenticated `gtx` client.
 * Caches translations across keys within a single run.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const LOCALES_DIR = path.resolve(__dirname, "..", "src", "locales");

// noitamap locale code → Google Translate target code.
// (br = Brazilian Portuguese, zh = Simplified Chinese.)
const LOCALE_TO_GT = {
  en: null, // source, skip
  ru: "ru",
  br: "pt",
  es: "es",
  de: "de",
  fr: "fr",
  it: "it",
  pl: "pl",
  zh: "zh-CN",
  ja: "ja",
  uk: "uk",
  nl: "nl",
  fi: "fi",
  cs: "cs",
  sv: "sv",
  id: "id",
};

const DRY = !!process.env.GT_DRY;
const KEY_PREFIX = (process.env.GT_KEY_PREFIX || "").trim();
const ONLY_LOCALES = (process.env.GT_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function gtFetch(text, target) {
  return new Promise((resolve, reject) => {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en" +
      `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            const segs = json[0] || [];
            resolve(segs.map((s) => s[0]).join(""));
          } catch (e) {
            reject(new Error(`gt parse failed for "${text}" -> ${target}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

const cache = new Map();
async function translate(text, target) {
  const cacheKey = `${target}\0${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const out = await gtFetch(text, target);
      cache.set(cacheKey, out);
      return out;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

/** Walk an object emitting [dottedKey, leafValue] for every string leaf. */
function* walkLeaves(obj, prefix = "") {
  if (obj == null) return;
  if (typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      yield* walkLeaves(v, dotted);
    } else if (typeof v === "string") {
      yield [dotted, v];
    }
  }
}

function getNested(obj, dotted) {
  return dotted.split(".").reduce((cur, k) => (cur == null ? cur : cur[k]), obj);
}

function setNested(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

async function main() {
  const enFile = path.join(LOCALES_DIR, "en", "translation.json");
  if (!fs.existsSync(enFile)) {
    console.error(`[gtranslate-missing-keys] missing source: ${enFile}`);
    process.exit(1);
  }
  const enJson = JSON.parse(fs.readFileSync(enFile, "utf8"));

  const allLeaves = [...walkLeaves(enJson)].filter(([k]) =>
    KEY_PREFIX ? k.startsWith(KEY_PREFIX) : true,
  );
  console.log(
    `[gtranslate-missing-keys] source: ${allLeaves.length} string leaves${KEY_PREFIX ? ` (prefix: ${KEY_PREFIX})` : ""}${DRY ? " [DRY RUN]" : ""}`,
  );

  for (const [loc, target] of Object.entries(LOCALE_TO_GT)) {
    if (!target) continue;
    if (ONLY_LOCALES.length && !ONLY_LOCALES.includes(loc)) continue;
    const file = path.join(LOCALES_DIR, loc, "translation.json");
    if (!fs.existsSync(file)) {
      console.warn(`  ${loc}: file missing, skipped`);
      continue;
    }
    const json = JSON.parse(fs.readFileSync(file, "utf8"));

    const todo = [];
    for (const [dotted, en] of allLeaves) {
      // Skip purely numeric / non-translatable keys (preserve identity for
      // keys like "Spell book": "Spell book" only when EN intentionally =
      // target — we cannot tell, so we treat identity as "needs translation".
      const cur = getNested(json, dotted);
      if (cur == null || cur === "") todo.push({ dotted, en });
      else if (typeof cur === "string" && cur === en) todo.push({ dotted, en });
    }

    if (!todo.length) {
      console.log(`  ${loc}: nothing to fill (0 missing)`);
      continue;
    }
    console.log(`  ${loc}: ${todo.length} key(s) to translate`);

    if (DRY) continue;

    let filled = 0;
    let failed = 0;
    for (const { dotted, en } of todo) {
      try {
        const value = await translate(en, target);
        setNested(json, dotted, value);
        filled++;
      } catch (e) {
        failed++;
        console.error(`    ${dotted}: ${e.message}`);
      }
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`  ${loc}: filled ${filled}${failed ? `, failed ${failed}` : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
