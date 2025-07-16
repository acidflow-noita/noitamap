#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const localesDir = path.join(__dirname, '../src/locales');
const commonCsvPath = path.join(__dirname, '../src/game-translations/common.csv');

// Read common.csv to identify human-verified translations
let humanVerifiedKeys = new Set();

if (fs.existsSync(commonCsvPath)) {
  const csvContent = fs.readFileSync(commonCsvPath, 'utf8');
  const lines = csvContent.split('\n');

  // Skip header lines and extract keys
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const firstComma = line.indexOf(',');
      if (firstComma > 0) {
        const key = line.substring(0, firstComma);
        if (key && (key.startsWith('menu_') || key.startsWith('option_'))) {
          humanVerifiedKeys.add(key);
        }
      }
    }
  }
}

console.log(`Found ${humanVerifiedKeys.size} human-verified keys from common.csv`);

// Function to upgrade translation structure
function upgradeTranslationObject(obj, keyPath = '') {
  const upgraded = {};

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = keyPath ? `${keyPath}.${key}` : key;

    if (typeof value === 'string') {
      // Convert string to object with metadata
      const isHumanVerified = humanVerifiedKeys.has(key) || humanVerifiedKeys.has(currentPath);

      upgraded[key] = {
        text: value,
        humanVerified: isHumanVerified,
      };
    } else if (typeof value === 'object' && value !== null) {
      // Recursively upgrade nested objects
      upgraded[key] = upgradeTranslationObject(value, currentPath);
    } else {
      // Keep other types as-is
      upgraded[key] = value;
    }
  }

  return upgraded;
}

// Function to create backup
function createBackup(filePath) {
  const backupPath = filePath.replace('.json', '.backup.json');
  fs.copyFileSync(filePath, backupPath);
  console.log(`Created backup: ${path.basename(backupPath)}`);
}

// Get all language directories
const langDirs = fs
  .readdirSync(localesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

console.log('\n🔄 Upgrading translation structure...\n');

for (const lang of langDirs) {
  const langFile = path.join(localesDir, lang, 'translation.json');

  if (!fs.existsSync(langFile)) {
    console.log(`⚠️  ${lang}: No translation file found`);
    continue;
  }

  try {
    // Create backup
    createBackup(langFile);

    // Read and upgrade
    const translation = JSON.parse(fs.readFileSync(langFile, 'utf8'));
    const upgraded = upgradeTranslationObject(translation);

    // Write upgraded version
    fs.writeFileSync(langFile, JSON.stringify(upgraded, null, 2));
    console.log(`✅ ${lang}: Upgraded translation structure`);
  } catch (error) {
    console.error(`❌ ${lang}: Error upgrading - ${error.message}`);
  }
}

console.log('\n🎉 Translation structure upgrade complete!');
console.log('\nNext steps:');
console.log('1. Update translation system to handle new structure');
console.log('2. Add completeness indicators to language dropdown');
console.log('3. Test that translations still work correctly');
