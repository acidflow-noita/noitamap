#!/usr/bin/env node
/**
 * Bakes per-creature localised names from public/assets/full_creatures.json
 * into each `src/locales/<lang>/translation.json` under
 * `gameContent.items.animal_<id>` — the same flat key gameTranslator already
 * looks up via translateItem(). After this runs, runtime is just an
 * i18next.t() call; no fallback chains, no in-memory mapping.
 *
 * Source columns (bartender lang → app locale):
 *   en → en, ru → ru, pt-br → br, es-es → es, de → de, fr-fr → fr,
 *   it → it, pl → pl, zh-cn → zh, jp → ja
 *
 * Locales without bartender translations (uk, nl, fi, cs, sv, id) keep their
 * existing `gameContent.items.animal_<id>` values when present and otherwise
 * have nothing baked — translators populate those by editing the JSON.
 *
 * CSV is upstream and overwrites every build. Translator overrides in the
 * locale JSON would also be overwritten on every build for the locales that
 * have a CSV value; if that becomes a problem, switch to merge-only.
 *
 * Run from the build pipeline (npm run bake-creature-translations) — never at
 * runtime.
 */

const fs = require("fs");
const path = require("path");
const { BARTENDER_LANG_TO_LOCALE } = require("./generate-creature-data.cjs");

function setNested(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (cur[last] === value) return false;
  cur[last] = value;
  return true;
}

function main() {
  const fullCreaturesPath = path.join(__dirname, "../public/assets/full_creatures.json");
  if (!fs.existsSync(fullCreaturesPath)) {
    console.warn(`[bake-creature-translations] ${fullCreaturesPath} not found; skipping.`);
    return;
  }
  const list = JSON.parse(fs.readFileSync(fullCreaturesPath, "utf8"));
  if (!Array.isArray(list)) {
    console.warn("[bake-creature-translations] full_creatures.json is not an array; skipping.");
    return;
  }

  // Build per-locale { animal_<id>: translated_name } maps.
  const perLocale = {};
  for (const c of list) {
    if (!c?.id || !Array.isArray(c.translations)) continue;
    for (const t of c.translations) {
      const loc = BARTENDER_LANG_TO_LOCALE[t?.lang];
      if (!loc) continue;
      const text = (t.text || "").trim();
      if (!text) continue;
      (perLocale[loc] ||= {})[`animal_${c.id}`] = text;
    }
  }

  const localesDir = path.join(__dirname, "../src/locales");
  let totalWritten = 0;
  for (const [loc, entries] of Object.entries(perLocale)) {
    const file = path.join(localesDir, loc, "translation.json");
    if (!fs.existsSync(file)) {
      console.warn(`[bake-creature-translations] ${loc}: no translation.json, skipping`);
      continue;
    }
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    let writes = 0;
    for (const [animalKey, value] of Object.entries(entries)) {
      if (setNested(json, `gameContent.items.${animalKey}`, value)) writes++;
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    totalWritten += writes;
    console.log(`[bake-creature-translations] ${loc}: ${writes} animal_* keys`);
  }
  console.log(`[bake-creature-translations] Total writes: ${totalWritten}`);
}

main();
