import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const {
  makeReport,
  parseCsv,
  CSV_LOCALES,
} = require("../build_scripts/bake-report-translations.cjs");
const read = (file: string) => JSON.parse(readFileSync(resolve(file), "utf8"));
const ui = read("build_data/report-v2-ui.json");
const terms = read("build_data/report-v2-terms.json");
const csv = parseCsv(readFileSync("src/game-translations/common.csv", "utf8"));
const game = new Map<string, string[]>(
  csv.slice(1).map((row: string[]) => [row[0], row]),
);
const locales = readdirSync("src/locales");
const get = (obj: any, key: string): any =>
  key.split(".").reduce((value, part) => value?.[part], obj);
function flatten(obj: any, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === "string"
        ? [[path, value]]
        : Object.entries(flatten(value, path));
    }),
  );
}

describe("report locale catalogue", () => {
  it("covers every supported locale explicitly, not via copied English fallback", () => {
    expect(locales).toHaveLength(16);
    for (const [key, values] of Object.entries<any>(ui)) {
      expect(Object.keys(values).sort(), key).toEqual([...locales].sort());
      for (const value of Object.values(values))
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(
          true,
        );
    }
  });
  it.each(locales)(
    "%s has the reproducible complete report bundle and identical deployed copy",
    (locale) => {
      const source = read(`src/locales/${locale}/translation.json`);
      const actual = source.seedReport.v2;
      expect(actual).toEqual(makeReport(locale, source, ui, terms, csv));
      const english = read("src/locales/en/translation.json").seedReport.v2;
      expect(Object.keys(flatten(actual)).sort()).toEqual(
        Object.keys(flatten(english)).sort(),
      );
      expect(read(`public/locales/${locale}/translation.json`)).toEqual(source);
      expect(source.seedReport.populationUnavailable).toContain("{{metrics}}");
    },
  );
  it.each(Object.keys(CSV_LOCALES))(
    "%s uses the exact common.csv game terms where provided",
    (locale) => {
      const report = read(`src/locales/${locale}/translation.json`).seedReport
        .v2;
      const column = csv[0].indexOf(CSV_LOCALES[locale]);
      for (const [key, term] of Object.entries<any>(terms.game)) {
        const canonical = game.get(term.csv)?.[column]?.trim();
        if (canonical)
          expect(get(report, key), `${locale}/${term.csv}`).toBe(canonical);
      }
    },
  );
  it("does not author a string twice, nor one the map already has, nor two aliases for one string", () => {
    // Identical text in every locale means the same string: it must be one
    // authored entry, or an alias of an existing key, never a second copy.
    const bundles = Object.fromEntries(
      locales.map((locale) => [
        locale,
        flatten(read(`src/locales/${locale}/translation.json`)),
      ]),
    );
    const signature = (value: (locale: string) => string | undefined) =>
      locales
        .map((locale) => (value(locale) ?? "").trim().toLowerCase())
        .join("\n");
    const existing = new Map<string, string>();
    const report = new Map<string, string>();
    for (const key of Object.keys(bundles.en)) {
      const sig = signature((locale) => bundles[locale][key]);
      const name = key.slice("seedReport.v2.".length);
      if (!key.startsWith("seedReport.v2.")) existing.set(sig, key);
      else if (name in terms.game || name in terms.reuse || name in terms.literals)
        report.set(sig, key);
    }
    const authored = new Map<string, string>();
    for (const [key, values] of Object.entries<any>(ui)) {
      const sig = signature((locale) => values[locale]);
      expect(
        authored.get(sig),
        `${key} duplicates authored ${authored.get(sig)}`,
      ).toBeUndefined();
      expect(
        existing.get(sig),
        `${key} duplicates ${existing.get(sig)}: alias it in report-v2-terms.json`,
      ).toBeUndefined();
      expect(
        report.get(sig),
        `${key} duplicates ${report.get(sig)}: alias it in report-v2-terms.json`,
      ).toBeUndefined();
      authored.set(sig, key);
    }
    const targets = new Map<string, string>();
    for (const [key, target] of [
      ...Object.entries<string>(terms.reuse),
      ...Object.entries<string>(terms.references),
    ]) {
      expect(
        targets.get(target),
        `${key} and ${targets.get(target)} both alias ${target}`,
      ).toBeUndefined();
      targets.set(target, key);
    }
    const csvRows = new Map<string, string>();
    for (const [key, term] of Object.entries<any>(terms.game)) {
      expect(
        csvRows.get(term.csv),
        `${key} and ${csvRows.get(term.csv)} both name ${term.csv}`,
      ).toBeUndefined();
      csvRows.set(term.csv, key);
    }
  });
  it("fails missing translations, changed placeholders and invented CSV row names", () => {
    const en = read("src/locales/en/translation.json");
    expect(() =>
      makeReport("ru", en, { test: { en: "Exists" } }, terms, csv),
    ).toThrow(/Missing authored/);
    expect(() =>
      makeReport(
        "ru",
        en,
        { test: { en: "{{count}}", ru: "число" } },
        terms,
        csv,
      ),
    ).toThrow(/Placeholder/);
    const wrong = structuredClone(terms);
    wrong.game.wand = {
      csv: "invented_noita_term",
      fallback: "gameContent.items.wand",
    };
    expect(() => makeReport("ru", en, ui, wrong, csv)).toThrow(
      /Unknown canonical/,
    );
  });
  it("parses quoted commas, quotes and multiline source values without dropping the first column", () => {
    expect(
      parseCsv(',en,ru\r\nitem,"a, b","c ""d"""\r\nmultiline,"a\nb",c\n'),
    ).toEqual([
      ["", "en", "ru"],
      ["item", "a, b", 'c "d"'],
      ["multiline", "a\nb", "c"],
    ]);
  });
});
