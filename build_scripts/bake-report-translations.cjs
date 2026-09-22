#!/usr/bin/env node
/** Reproducible report UI catalogue. No translation service and no invented
 * game names: common.csv wins, then existing map terminology/English canon. */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const CSV_LOCALES = {
  en: "en",
  ru: "ru",
  uk: "uk",
  zh: "zh-cn",
  ja: "jp",
  de: "de",
  fr: "fr-fr",
  es: "es-es",
  br: "pt-br",
  it: "it",
  pl: "pl",
};
function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
const get = (obj, key) =>
  key.split(".").reduce((value, part) => value?.[part], obj);
function set(obj, key, value) {
  const parts = key.split(".");
  let node = obj;
  for (const p of parts.slice(0, -1)) node = node[p] ??= {};
  node[parts.at(-1)] = value;
}
const tokens = (text) =>
  [...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)]
    .map((m) => m[1])
    .sort()
    .join("|");
function makeReport(locale, existing, ui, terms, csv) {
  const values = {};
  for (const [key, translations] of Object.entries(ui)) {
    const value = translations[locale];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Missing authored UI translation ${locale}/${key}`);
    if (tokens(value) !== tokens(translations.en))
      throw new Error(`Placeholder mismatch ${locale}/${key}`);
    values[key] = value;
  }
  const assign = (key, value) => {
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate report key ${key}`);
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Missing existing term ${locale}/${key}`);
    values[key] = value;
  };
  for (const [key, ref] of Object.entries(terms.reuse))
    assign(key, get(existing, ref));
  const col = csv[0].indexOf(CSV_LOCALES[locale]);
  const gameRows = new Map(csv.slice(1).map((row) => [row[0], row]));
  for (const [key, term] of Object.entries(terms.game)) {
    const row = gameRows.get(term.csv);
    if (!row || !row[1])
      throw new Error(`Unknown canonical game term ${term.csv}`);
    // Do not coin translations for locales absent from common.csv. Use the
    // map's existing terminology, or the actual canonical English game name.
    assign(
      key,
      (col >= 0 ? row[col] : null)?.trim() ||
        get(existing, term.fallback) ||
        row[1],
    );
  }
  for (const [key, value] of Object.entries(terms.literals)) assign(key, value);
  const resolving = new Set();
  function reference(key) {
    if (Object.hasOwn(values, key)) return values[key];
    if (resolving.has(key)) throw new Error(`Cyclic report alias ${key}`);
    const ref = terms.references[key];
    if (typeof ref !== "string") throw new Error(`Unknown report alias ${key}`);
    resolving.add(key);
    const value =
      ref.includes("$t(") || ref.includes("{{") ? ref : reference(ref);
    assign(key, value);
    resolving.delete(key);
    return value;
  }
  for (const key of Object.keys(terms.references)) reference(key);
  const report = {};
  for (const [key, value] of Object.entries(values)) set(report, key, value);
  // Resolve every nested reference now for validation, but leave i18next's
  // nesting intact so language-specific placeholders are handled at runtime.
  const merged = {
    ...existing,
    seedReport: { ...existing.seedReport, v2: report },
  };
  for (const [key, value] of Object.entries(values))
    for (const [, ref] of value.matchAll(/\$t\(([^)]+)\)/g))
      if (typeof get(merged, ref) !== "string")
        throw new Error(`Broken nested label ${locale}/${key}: ${ref}`);
  return report;
}
function makeVisitorReport(locale, ui) {
  const result = {};
  for (const [key, translations] of Object.entries(ui)) {
    const value = translations[locale];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing V3 translation ${locale}/${key}`);
    if (tokens(value) !== tokens(translations.en)) throw new Error(`V3 placeholder mismatch ${locale}/${key}`);
    set(result, key, value);
  }
  return result;
}
function main() {
  const visitorUI = JSON.parse(fs.readFileSync(path.join(ROOT, "build_data/report-v3-ui.json"), "utf8"));
  const ui = JSON.parse(
    fs.readFileSync(path.join(ROOT, "build_data/report-v2-ui.json"), "utf8"),
  );
  const terms = JSON.parse(
    fs.readFileSync(path.join(ROOT, "build_data/report-v2-terms.json"), "utf8"),
  );
  const csv = parseCsv(
    fs.readFileSync(
      path.join(ROOT, "src/game-translations/common.csv"),
      "utf8",
    ),
  );
  const languages = fs
    .readdirSync(path.join(ROOT, "src/locales"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const outputs = languages.map((locale) => {
    const file = path.join(ROOT, "src/locales", locale, "translation.json"),
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    existing.seedReport.v2 = makeReport(locale, existing, ui, terms, csv);
    existing.seedReport.v3 = makeVisitorReport(locale, visitorUI);
    existing.seedReport.populationUnavailable =
      "{{metrics}}: $t(seedReport.v2.invalidPopulationReference)";
    return { locale, file, existing };
  });
  for (const { locale, file, existing } of outputs) {
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
    console.log(`Report translations: ${locale}`);
  }
}
module.exports = { parseCsv, makeReport, makeVisitorReport, CSV_LOCALES };
if (require.main === module) main();
