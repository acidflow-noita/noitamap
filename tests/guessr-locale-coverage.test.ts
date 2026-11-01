import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const languages = ['en', 'br', 'cs', 'de', 'es', 'fi', 'fr', 'id', 'it', 'ja', 'nl', 'pl', 'ru', 'sv', 'uk', 'zh'];
const catalog = (language: string) => JSON.parse(readFileSync(new URL(`../src/guessr/locales/${language}.json`, import.meta.url), 'utf8')) as Record<string, string>;
const english = catalog('en');
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1].trim()).sort();

describe('Guessr translation catalog integrity', () => {
  it.each(languages)('%s covers its source keys and preserves every interpolation', language => {
    const translated = catalog(language);
    expect(Object.keys(english).filter(key => !Object.hasOwn(translated, key))).toEqual([]);
    for (const [key, value] of Object.entries(translated)) {
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
      const source = english[key] ?? english[base];
      expect(source, `${language}: unknown key ${key}`).toBeTypeOf('string');
      expect(value.trim(), `${language}: blank value ${key}`).not.toBe('');
      expect(placeholders(value), `${language}: ${key}`).toEqual(placeholders(source));
    }
  });

  it.each(languages)('%s supplies its required plural forms', language => {
    const translated = catalog(language), locale = language === 'br' ? 'pt-BR' : language;
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const key of Object.keys(english).filter(key => key.endsWith('_one'))) {
      const base = key.slice(0, -4);
      if (!Object.hasOwn(english, base + '_other')) continue;
      for (const category of categories)
        expect(translated[`${base}_${category}`], `${language}: ${base}_${category}`).toBeTypeOf('string');
    }
  });
});
