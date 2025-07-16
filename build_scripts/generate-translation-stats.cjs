#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, '../src/locales');
const outputPath = path.join(__dirname, '../src/data/translation-stats.json');

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
      stats[lang] = {
        completeness: 100,
        translatedKeys: actualKeys,
        totalKeys: actualKeys,
      };
      console.log(`${lang}: 100% (${actualKeys}/${actualKeys}) - REFERENCE`);
    } else {
      const translatedKeys = countTranslated(translation);
      const completeness = Math.round((translatedKeys / maxKeys) * 100);

      stats[lang] = {
        completeness: Math.min(completeness, 100), // Cap at 100%
        translatedKeys,
        totalKeys: maxKeys,
      };

      console.log(`${lang}: ${stats[lang].completeness}% (${translatedKeys}/${maxKeys})`);
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
