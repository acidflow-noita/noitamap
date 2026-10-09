#!/usr/bin/env node
// Application UI copy, not in-game terminology. Keep authored translations in
// one source so a wording change cannot silently fall back to English.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const copy = JSON.parse(
  fs.readFileSync(path.join(root, "build_data/performance-ui.json"), "utf8"),
);
const locales = fs
  .readdirSync(path.join(root, "src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const outputs = locales.map((locale) => {
  if (!copy[locale]?.title?.trim() || !copy[locale]?.content?.trim())
    throw new Error(`Missing HD renderer translation for ${locale}`);
  const file = path.join(root, "src/locales", locale, "translation.json");
  const translations = JSON.parse(fs.readFileSync(file, "utf8"));
  translations.hdRenderer = copy[locale];
  return { file, translations };
});
for (const { file, translations } of outputs)
  fs.writeFileSync(file, JSON.stringify(translations, null, 2) + "\n");
console.log(`Performance translations: ${outputs.length} locales`);
