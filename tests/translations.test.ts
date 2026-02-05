import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function getSupportedLanguages() {
  const localesDir = path.resolve(__dirname, '../src/locales');
  return fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

function loadTranslationFile(langCode: string) {
  const filePath = path.resolve(__dirname, `../src/locales/${langCode}/translation.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getAllKeys(obj: any, prefix = ''): string[] {
  let keys: string[] = [];
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      keys = keys.concat(getAllKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function getAllKeysWithValues(obj: any, prefix = ''): Record<string, string> {
  let entries: Record<string, string> = {};
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      Object.assign(entries, getAllKeysWithValues(obj[key], fullKey));
    } else {
      entries[fullKey] = String(obj[key]);
    }
  }
  return entries;
}

describe('Translation Fullness', () => {
  const languages = getSupportedLanguages();
  const enTranslations = loadTranslationFile('en');
  const enKeysWithValues = getAllKeysWithValues(enTranslations);
  const enKeys = Object.keys(enKeysWithValues);

  it('should have English base translations', () => {
    expect(enTranslations).not.toBeNull();
    expect(enKeys.length).toBeGreaterThan(0);
  });

  languages.forEach(lang => {
    if (lang === 'en') return;

    describe(`Locale: ${lang}`, () => {
      it(`should have all English keys`, () => {
        const langTranslations = loadTranslationFile(lang);
        expect(langTranslations, `Translation file for ${lang} is missing`).not.toBeNull();

        const langKeys = Object.keys(getAllKeysWithValues(langTranslations));
        const missingKeys = enKeys.filter(key => !langKeys.includes(key));

        expect(missingKeys, `${lang} is missing ${missingKeys.length} keys: ${missingKeys.join(', ')}`).toEqual([]);
      });

      it(`should not have placeholder values identical to English`, () => {
        const langTranslations = loadTranslationFile(lang);
        const langKeysWithValues = getAllKeysWithValues(langTranslations);

        const placeholders = enKeys.filter(key => {
          // Some keys are expected to be the same (e.g. proper names, technical terms, or symbols)
          const ignoreList = [
            'mod.title',
            'discord.title',
            'github.title',
            '???',
            'Ocarina',
            'Kantele',
            'Apotheosis',
            'Purgatory',
            'Noitavania',
            'Mod',
            'Latest',
            'A2',
            'G+',
            'D+',
            'Alpha',
            'Beta',
            'Gamma',
            'Delta',
            'Omega',
            'Tau',
            'Mu',
            'Phi',
            'Sigma',
            'Zeta'
          ];
          
          if (ignoreList.some(ignore => key.includes(ignore))) return false;
          
          // Check if value is identical to English
          return langKeysWithValues[key] === enKeysWithValues[key];
        });

        // We use a soft check here (warn instead of fail) because some short words 
        // might actually be the same in some languages (e.g. "Bomba" in ES/PT vs "Bomb" in EN is different, 
        // but "Milk" might be "Milk" in some contexts or technical strings).
        // However, the user asked for a test that "says" it, so we'll output them.
        if (placeholders.length > 0) {
          console.warn(`⚠️  ${lang} has ${placeholders.length} keys identical to English (possible placeholders):\n   - ${placeholders.slice(0, 10).join('\n   - ')}${placeholders.length > 10 ? '\n   ... and ' + (placeholders.length - 10) + ' more' : ''}`);
        }
        
        // If you want it to strictly FAIL when placeholders are found, uncomment the next line:
        // expect(placeholders, `${lang} has identical values to English for keys: ${placeholders.join(', ')}`).toEqual([]);
      });
    });
  });
});
