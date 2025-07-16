#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, '../src/locales');
const outputPath = path.join(__dirname, '../src/data/translation-stats.json');
const commonCsvFile = path.join(__dirname, '../src/game-translations/common.csv');

// Function to count all translatable keys recursively
function countKeys(obj) {
  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      count++;
    } else if (typeof value === 'object' && value !== null) {
      count += countKeys(value);
    }
  }
  return count;
}

// Function to detect English placeholders and count real translations
function countTranslated(obj, path = '') {
  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Skip empty strings
      if (!value.trim()) continue;

      // Detect English placeholders (common patterns)
      const isEnglishPlaceholder =
        // Exact English matches for common UI elements
        /^(Spark bolt|Magic arrow|Energy orb|Black hole|White hole)$/i.test(value) ||
        // English phrases with "with", "of", "the", etc.
        /\b(with trigger|with timer|of air|of fire|of water|the art)\b/i.test(value) ||
        // Lowercase English words (likely placeholders)
        /^[a-z\s]+$/.test(value) ||
        // English technical terms
        /^(boss|item|structure|spell|overlay|projectile|explosion)$/i.test(value);

      if (!isEnglishPlaceholder) {
        count++;
      }
    } else if (typeof value === 'object' && value !== null) {
      count += countTranslated(value, path ? `${path}.${key}` : key);
    }
  }
  return count;
}

// Find the most complete translation file to use as reference
let maxKeys = 0;
let referenceTranslation = null;

const langDirs = fs
  .readdirSync(localesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

// First pass: find the most complete file
for (const lang of langDirs) {
  const langFile = path.join(localesDir, lang, 'translation.json');
  if (fs.existsSync(langFile)) {
    try {
      const translation = JSON.parse(fs.readFileSync(langFile, 'utf8'));
      const keyCount = countKeys(translation);
      if (keyCount > maxKeys) {
        maxKeys = keyCount;
        referenceTranslation = translation;
      }
    } catch (error) {
      // Skip invalid files
    }
  }
}

if (!referenceTranslation) {
  console.error('No valid translation files found');
  process.exit(1);
}

console.log(`Using reference with ${maxKeys} total keys`);

// Function to parse CSV and get human-verified keys
function getHumanVerifiedKeys() {
  if (!fs.existsSync(commonCsvFile)) {
    console.warn('common.csv not found, human verification will be 0%');
    return new Set();
  }

  const csvContent = fs.readFileSync(commonCsvFile, 'utf8');
  const lines = csvContent.split('\n');
  const humanVerifiedKeys = new Set();

  // Skip header lines and process data
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line properly (handle quoted values)
    const columns = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        columns.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    columns.push(current.trim());

    if (columns.length > 0 && columns[0]) {
      const key = columns[0].trim();
      if (key && !key.startsWith('//') && key !== '' && !key.includes("doesn't need to be translated")) {
        // These are game content keys that map to gameContent section
        humanVerifiedKeys.add(`gameContent.spells.${key}`);
        humanVerifiedKeys.add(`gameContent.items.${key}`);
        humanVerifiedKeys.add(`gameContent.bosses.${key}`);
        humanVerifiedKeys.add(`gameContent.structures.${key}`);
        humanVerifiedKeys.add(`gameContent.orbs.${key}`);
        // Also add the direct key for UI elements
        humanVerifiedKeys.add(key);
      }
    }
  }

  return humanVerifiedKeys;
}

// Function to count human-verified keys in a translation object
function countHumanVerified(obj, humanVerifiedKeys, prefix = '') {
  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      if (humanVerifiedKeys.has(key) || humanVerifiedKeys.has(fullKey)) {
        count++;
      }
    } else if (typeof value === 'object' && value !== null) {
      count += countHumanVerified(value, humanVerifiedKeys, fullKey);
    }
  }
  return count;
}

// Get human-verified keys from common.csv
const humanVerifiedKeys = getHumanVerifiedKeys();
console.log(`Found ${humanVerifiedKeys.size} human-verified keys in common.csv`);

// Second pass: calculate completeness for each language
const stats = {};

for (const lang of langDirs) {
  const langFile = path.join(localesDir, lang, 'translation.json');

  if (!fs.existsSync(langFile)) {
    stats[lang] = { completeness: 0, translatedKeys: 0, totalKeys: maxKeys };
    continue;
  }

  try {
    const translation = JSON.parse(fs.readFileSync(langFile, 'utf8'));

    // English is always 100% complete as it's the reference
    if (lang === 'en') {
      const actualKeys = countKeys(translation);
      const humanVerifiedCount = countHumanVerified(translation, humanVerifiedKeys);
      const humanVerified = Math.round((humanVerifiedCount / actualKeys) * 100);

      stats[lang] = {
        completeness: 100,
        humanVerified,
        translatedKeys: actualKeys,
        totalKeys: actualKeys,
        humanVerifiedCount,
      };
      console.log(
        `${lang}: 100% (${actualKeys}/${actualKeys}) - REFERENCE, ${humanVerified}% human-verified (${humanVerifiedCount}/${actualKeys})`
      );
    } else {
      const translatedKeys = countTranslated(translation);
      const humanVerifiedCount = countHumanVerified(translation, humanVerifiedKeys);
      const completeness = Math.round((translatedKeys / maxKeys) * 100);
      const humanVerified = Math.round((humanVerifiedCount / maxKeys) * 100);

      stats[lang] = {
        completeness: Math.min(completeness, 100), // Cap at 100%
        humanVerified,
        translatedKeys,
        totalKeys: maxKeys,
        humanVerifiedCount,
      };

      console.log(
        `${lang}: ${stats[lang].completeness}% (${translatedKeys}/${maxKeys}), ${humanVerified}% human-verified (${humanVerifiedCount}/${maxKeys})`
      );
    }
  } catch (error) {
    console.error(`Error reading ${lang}: ${error.message}`);
    stats[lang] = { completeness: 0, translatedKeys: 0, totalKeys: maxKeys };
  }
}

// Save stats for frontend use
fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
console.log(`\n✅ Translation stats saved to ${path.relative(process.cwd(), outputPath)}`);

// Also save to build output for deployment
const publicOutputPath = path.join(__dirname, '../public/data/translation-stats.json');
const publicDataDir = path.dirname(publicOutputPath);
if (!fs.existsSync(publicDataDir)) {
  fs.mkdirSync(publicDataDir, { recursive: true });
}
fs.writeFileSync(publicOutputPath, JSON.stringify(stats, null, 2));
console.log(`✅ Translation stats copied to ${path.relative(process.cwd(), publicOutputPath)}`);
