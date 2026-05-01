#!/usr/bin/env node
/**
 * MANUAL TOOL — calls the Google Translate `gtx` endpoint to fill in any
 * extended.* / wand.* / poi.* / common.* keys that are still missing or
 * empty across the locales. Never invoked by the build; run only when you
 * want to bulk-fill new keys before a translator does it by hand.
 *
 *   node build_scripts/gtranslate-missing-extended-keys.cjs
 *
 * Behavior:
 *   - Reads the same KEYS table that build_scripts/bake-extended-translations.cjs
 *     uses (the bake script writes CSV-sourced values; this one fills the rest).
 *   - For each non-English locale, finds keys that are missing or set to the
 *     bare English fallback and translates the EN value via the public gtx
 *     endpoint. Existing non-English values are LEFT ALONE.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// Reuse the canonical KEYS / SPAWN map from the bake script so this stays in
// sync. The bake script doesn't export — extract the literals from its source.
const bakeSrc = fs.readFileSync(path.join(__dirname, "bake-extended-translations.cjs"), "utf8");
const KEYS = (function () {
  const m = bakeSrc.match(/const KEYS = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("KEYS table not found in bake-extended-translations.cjs");
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return ${m[1]};`)();
})();
const SPAWN_NAME_TO_CSV_KEY = (function () {
  const m = bakeSrc.match(/const SPAWN_NAME_TO_CSV_KEY = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error("SPAWN_NAME_TO_CSV_KEY not found");
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return ${m[1]};`)();
})();

const LOCALE_TO_GT = {
  en: null, // skip
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

function spawnSlug(name) {
  return name
    .toLowerCase()
    .replace(/&#?\w+;/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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
  const cacheKey = `${target} ${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const out = await gtFetch(text, target);
      cache.set(cacheKey, out);
      return out;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
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
  for (const [loc, target] of Object.entries(LOCALE_TO_GT)) {
    if (!target) continue;
    const file = path.join(localesDir, loc, "translation.json");
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    let filled = 0;

    const todo = [];
    for (const k of KEYS) {
      const cur = getNested(json, k.key);
      if (!cur || cur === k.en) todo.push({ dotted: k.key, en: k.en });
    }
    for (const enName of Object.keys(SPAWN_NAME_TO_CSV_KEY)) {
      const dotted = `extended.spawn.${spawnSlug(enName)}`;
      const cur = getNested(json, dotted);
      if (!cur || cur === enName) todo.push({ dotted, en: enName });
    }

    for (const { dotted, en } of todo) {
      try {
        const value = await translate(en, target);
        setNested(json, dotted, value);
        filled++;
      } catch (e) {
        console.error(`  gt failed for ${loc}/${dotted}: ${e.message}`);
      }
    }

    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${loc}: filled ${filled}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
