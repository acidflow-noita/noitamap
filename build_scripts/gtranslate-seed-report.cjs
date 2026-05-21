#!/usr/bin/env node
/**
 * MANUAL TOOL — populates the `seedReport` subtree across non-EN locales by
 * calling Google's public `gtx` endpoint. Idempotent: only translates keys
 * that are missing or still set to the bare English fallback.
 *
 *   node build_scripts/gtranslate-seed-report.cjs
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const LOCALE_TO_GT = {
  en: null,
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

const ROOT_KEY = "seedReport";

/**
 * Source-string overrides: when translating these dotted keys, send a
 * clearer English phrase to Google so the result reads naturally in the
 * target language. The EN locale keeps the terse original.
 *
 * Without this, Google translates abbreviations literally — e.g. "rare mats"
 * becomes "редкие коврики" (rare rugs) in Russian.
 */
const SOURCE_OVERRIDES = {
  "title": "Seed report",
  "close": "Close window",
  "toggle.title": "Seed report",
  "toggle.content": "Per-world, per-biome statistics for the current seed.",
  "col.chests": "Chests",
  "col.greatChests": "Great chests",
  "col.hvSpells": "High-value spells",
  "col.rareMaterials": "Rare materials",
  "noTrackedItems": "No tracked items in this world.",
  "rareMaterial.healthium": "Healthium",
  "rareMaterial.livelyconcoction": "Lively Concoction",
  "compare.comparedTo": "compared to {{target}}",
  "compare.notCached": "(visit {{target}} once to enable comparison)",
  "compare.unavailable": "(no comparison available)",
  "compare.todayDaily": "today's daily seed",
  "compare.yesterdayDaily": "yesterday's daily seed",
  "spell.category.divides": "Divide spells",
  "spell.category.material": "Material spells",
  "spell.category.greeks": "Greek-letter spells",
  "spell.category.summonTaikasauva": "Summon Taikasauva",
  "spells.title": "High-value spells",
  "spells.empty": "No high-value spells in this seed.",
  "spider.title": "Per-world overview",
  "spider.axis.greatChests": "Great chests",
  "spider.axis.hvSpells": "High-value spells",
  "spider.legend.current": "Current seed",
  "spider.legend.previousDaily": "Previous daily seed",
  "spider.legend.average": "Average baseline",
};

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
  const k = `${target}\t${text}`;
  if (cache.has(k)) return cache.get(k);
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const out = await gtFetch(text, target);
      cache.set(k, out);
      return out;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}

function flatten(prefix, obj, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(key, v, out);
    else out[key] = v;
  }
  return out;
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
  const localesDir = path.join(__dirname, "../src/locales");
  const enFile = path.join(localesDir, "en", "translation.json");
  const en = JSON.parse(fs.readFileSync(enFile, "utf8"));
  const enSub = en[ROOT_KEY];
  if (!enSub) {
    console.error(`No '${ROOT_KEY}' subtree in en/translation.json`);
    process.exit(1);
  }
  const enFlat = flatten("", enSub, {});

  for (const [loc, target] of Object.entries(LOCALE_TO_GT)) {
    if (!target) continue;
    const file = path.join(localesDir, loc, "translation.json");
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json[ROOT_KEY] = json[ROOT_KEY] || {};

    let filled = 0;
    for (const [dotted, enVal] of Object.entries(enFlat)) {
      if (typeof enVal !== "string") continue;
      const fullKey = `${ROOT_KEY}.${dotted}`;
      const cur = getNested(json, fullKey);
      // Allow re-translation when current matches the bare EN value (likely
      // unfilled or pre-override result). Skip only when already customised.
      const sourceForGT = SOURCE_OVERRIDES[dotted] || enVal;
      if (cur && cur !== enVal && cur !== sourceForGT) continue;

      try {
        // Protect i18next placeholders ({{x}}) from translation.
        const placeholders = [];
        const masked = sourceForGT.replace(/\{\{(\w+)\}\}/g, (m) => {
          placeholders.push(m);
          return ` __PH${placeholders.length - 1}__ `;
        });
        let translated = await translate(masked, target);
        translated = translated.replace(/__\s*PH\s*(\d+)\s*__/g, (_, i) => placeholders[Number(i)]);
        translated = translated.trim();
        setNested(json, fullKey, translated);
        filled++;
      } catch (e) {
        console.error(`  gt failed for ${loc}/${fullKey}: ${e.message}`);
      }
    }

    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${loc}: filled ${filled}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
