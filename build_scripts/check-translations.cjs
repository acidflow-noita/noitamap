#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function getSupportedLanguages() {
  const localesDir = path.join(__dirname, '../src/locales');
  return fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

function loadTranslationFile(langCode) {
  const filePath = path.join(__dirname, `../src/locales/${langCode}/translation.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getAllKeys(obj, prefix = '') {
  let keys = [];
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

function checkTranslations() {
  const languages = getSupportedLanguages();
  const enTranslations = loadTranslationFile('en');
  const enKeys = getAllKeys(enTranslations);

  let hasMissing = false;

  languages.forEach(lang => {
    if (lang === 'en') return;
    const langTranslations = loadTranslationFile(lang);
    if (!langTranslations) {
      console.log(`❌ ${lang}: Translation file missing`);
      hasMissing = true;
      return;
    }

    const langKeys = getAllKeys(langTranslations);
    const missingKeys = enKeys.filter(key => !langKeys.includes(key));

    if (missingKeys.length > 0) {
      console.log(`❌ ${lang}: Missing ${missingKeys.length} keys:`);
      missingKeys.forEach(key => console.log(`   - ${key}`));
      hasMissing = true;
    } else {
      console.log(`✅ ${lang}: All keys present`);
    }
  });

  if (hasMissing) {
    process.exit(1);
  }
}

checkTranslations();
