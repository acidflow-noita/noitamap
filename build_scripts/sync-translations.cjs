#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function getSupportedLanguages() {
  const localesDir = path.join(__dirname, '../src/locales');
  try {
    return fs
      .readdirSync(localesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch (error) {
    console.error('❌ Error reading locales directory:', error.message);
    return [];
  }
}

function loadTranslationFile(langCode) {
  const filePath = path.join(__dirname, `../src/locales/${langCode}/translation.json`);

  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  Translation file not found: ${langCode}/translation.json`);
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`❌ Error loading ${langCode} translation file:`, error.message);
    return null;
  }
}

function saveTranslationFile(langCode, translations) {
  const filePath = path.join(__dirname, `../src/locales/${langCode}/translation.json`);

  try {
    fs.writeFileSync(filePath, JSON.stringify(translations, null, 2));
    return true;
  } catch (error) {
    console.error(`❌ Error saving ${langCode} translation file:`, error.message);
    return false;
  }
}

function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else if (result[key] === undefined) {
      // Only add if the key doesn't exist in target
      result[key] = source[key];
    }
  }

  return result;
}

function syncTranslations() {
  console.log('Syncing translation files...');

  // Get all available languages
  const supportedLanguages = getSupportedLanguages();
  console.log(`Found languages: ${supportedLanguages.join(', ')}`);

  // Load English translations as the base
  const englishTranslations = loadTranslationFile('en');
  if (!englishTranslations) {
    console.error('❌ Cannot load English translations. Aborting.');
    return;
  }

  console.log('✅ Loaded English translations as base');

  // Process each supported language
  supportedLanguages.forEach(langCode => {
    if (langCode === 'en') return; // Skip English as it's the base

    console.log(`\nProcessing ${langCode}...`);

    const existingTranslations = loadTranslationFile(langCode);
    if (!existingTranslations) {
      console.log(`  ⚠️  Skipping ${langCode} - could not load translation file`);
      return;
    }

    // Merge English structure with existing translations
    const mergedTranslations = deepMerge(existingTranslations, englishTranslations);

    // Count what was added
    const originalKeys = countKeys(existingTranslations);
    const newKeys = countKeys(mergedTranslations);
    const addedKeys = newKeys - originalKeys;

    if (addedKeys > 0) {
      if (saveTranslationFile(langCode, mergedTranslations)) {
        console.log(`  ✅ Updated ${langCode} - added ${addedKeys} missing keys`);
      }
    } else {
      console.log(`  ✅ ${langCode} is up to date`);
    }
  });

  console.log('\n✅ Translation sync complete!');
}

function countKeys(obj, prefix = '') {
  let count = 0;

  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      count += countKeys(obj[key], fullKey);
    } else {
      count++;
    }
  }

  return count;
}

// Run the script
syncTranslations();
