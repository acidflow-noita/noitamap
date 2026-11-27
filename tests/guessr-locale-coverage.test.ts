import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const languages = ['en', 'br', 'cs', 'de', 'es', 'fi', 'fr', 'id', 'it', 'ja', 'nl', 'pl', 'ru', 'sv', 'uk', 'zh'];
const catalog = (language: string) => JSON.parse(readFileSync(new URL(`../src/guessr/locales/${language}.json`, import.meta.url), 'utf8')) as Record<string, string>;
const english = catalog('en');
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1].trim()).sort();

describe('Guessr translation catalog integrity', () => {
  it('includes literal UI labels used by the translation functions and the stream screens', () => {
    const sourceDir = new URL('../src/guessr/', import.meta.url);
    const functions: Record<string, number> = { tr: 0, msg: 0, bindText: 1, bindAttribute: 2, setControlIcon: 2 };
    const wrappers: Record<string, Record<string, number>> = {
      'stream-ui.ts': { el: 1, action: 0 }, 'stream-picker.ts': { node: 2, button: 0 },
      'stream-results.ts': { el: 1 }, 'clue-replay-view.ts': { control: 0 },
    };
    const missing = new Set<string>();
    function check(arg: ts.Node): void {
      if (ts.isArrowFunction(arg)) check(arg.body);
      else if (ts.isConditionalExpression(arg)) { check(arg.whenTrue); check(arg.whenFalse); }
      else if (ts.isStringLiteralLike(arg) && /[a-z]/i.test(arg.text) && !Object.hasOwn(english, arg.text))
        missing.add(arg.text);
    }
    for (const file of readdirSync(sourceDir).filter(name => name.endsWith('.ts'))) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, sourceDir), 'utf8'), ts.ScriptTarget.Latest);
      const keys = { ...functions, ...wrappers[file] };
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && Object.hasOwn(keys, node.expression.text)) {
          const arg = node.arguments[keys[node.expression.text]];
          if (arg) check(arg);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect([...missing]).toEqual([]);
  });
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
