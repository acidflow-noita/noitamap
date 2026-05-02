#!/usr/bin/env node
/**
 * One-off: GT-translate just the section-header / status keys that the
 * bake script populates with the EN fallback. Targets only this narrow set
 * so we don't blow through gtx rate limits hitting every key.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const TARGETS = [
  { key: "extended.title", en: "Extended info" },
  { key: "extended.loading", en: "Loading..." },
  { key: "extended.cta", en: "Unlock with Pro" },
  { key: "extended.dmgMults", en: "Damage multipliers" },
  { key: "extended.damage", en: "Damage" },
  { key: "extended.tiers", en: "Tier spawn rate" },
  { key: "extended.stainEffects", en: "Stain effects" },
  { key: "extended.ingestionEffects", en: "Ingestion effects" },
  { key: "extended.reactionsHeader", en: "Material reactions on Bartender" },
  { key: "extended.asReagent", en: "View as reagent" },
  { key: "extended.asProduct", en: "View as product" },
  { key: "poi.horde", en: "Horde" },
];

const LOCALE_TO_GT = {
  ru: "ru", br: "pt", es: "es", de: "de", fr: "fr",
  it: "it", pl: "pl", zh: "zh-CN", ja: "ja", uk: "uk",
  nl: "nl", fi: "fi", cs: "cs", sv: "sv", id: "id",
};

function gt(text, target) {
  return new Promise((resolve, reject) => {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve((JSON.parse(body)[0] || []).map((s) => s[0]).join("")); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function setNested(obj, dotted, value) {
  const p = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < p.length - 1; i++) {
    if (typeof cur[p[i]] !== "object" || cur[p[i]] === null) cur[p[i]] = {};
    cur = cur[p[i]];
  }
  cur[p[p.length - 1]] = value;
}

(async () => {
  for (const [loc, target] of Object.entries(LOCALE_TO_GT)) {
    const file = path.join(__dirname, `../src/locales/${loc}/translation.json`);
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    let writes = 0;
    for (const { key, en } of TARGETS) {
      try {
        const value = await gt(en, target);
        if (value && value !== en) {
          setNested(json, key, value);
          writes++;
        }
      } catch (e) {
        console.error(`  ${loc}/${key}: ${e.message}`);
      }
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${loc}: wrote ${writes}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
