#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function loadDataFile(filename) {
  const filePath = path.join(__dirname, `../src/data/${filename}`);
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  File not found: ${filename}`);
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`❌ Error loading ${filename}:`, error.message);
    return [];
  }
}

function extractNames(data, nameField = 'name') {
  const names = {};

  if (Array.isArray(data)) {
    data.forEach(item => {
      const name = item[nameField];
      if (name) {
        names[name] = name; // English name maps to itself
      }
    });
  } else if (typeof data === 'object') {
    Object.values(data).forEach(item => {
      if (typeof item === 'object' && item[nameField]) {
        const name = item[nameField];
        names[name] = name;
      }
    });
  }

  return names;
}

function generateEnglishTranslations() {
  console.log('Generating English gameContent translations...');

  // Load all data files
  const dataFiles = [
    { file: 'spells.json', key: 'spells', nameField: 'name' },
    { file: 'items.json', key: 'items', nameField: 'name' },
    { file: 'bosses.json', key: 'bosses', nameField: 'name' },
    { file: 'structures.json', key: 'structures', nameField: 'name' },
    { file: 'orbs.json', key: 'orbs', nameField: 'name' },
    { file: 'biomes.json', key: 'biomes', nameField: 'name' },
  ];

  const gameContent = {};

  dataFiles.forEach(({ file, key, nameField }) => {
    console.log(`Processing ${file}...`);
    const data = loadDataFile(file);
    const names = extractNames(data, nameField);

    if (Object.keys(names).length > 0) {
      gameContent[key] = names;
      console.log(`  ✅ Added ${Object.keys(names).length} ${key} entries`);
    }
  });

  // Handle special cases for orbs (they might have different text fields)
  const orbsData = loadDataFile('orbs.json');
  if (Array.isArray(orbsData)) {
    orbsData.forEach(orb => {
      // Check for text arrays or other text fields
      if (orb.text && Array.isArray(orb.text)) {
        orb.text.forEach(textItem => {
          if (typeof textItem === 'string') {
            gameContent.orbs[textItem] = textItem;
          }
        });
      }
    });
  }

  // Add empty sections for consistency
  gameContent.orbAreas = {};
  gameContent.overlaysRegular = {};

  return gameContent;
}

function updateEnglishTranslationFile() {
  const englishFilePath = path.join(__dirname, '../src/locales/en/translation.json');

  if (!fs.existsSync(englishFilePath)) {
    console.error('❌ English translation file not found');
    return;
  }

  try {
    const existingTranslations = JSON.parse(fs.readFileSync(englishFilePath, 'utf8'));
    const gameContent = generateEnglishTranslations();

    // Add gameContent section
    existingTranslations.gameContent = gameContent;

    // Write back to file
    fs.writeFileSync(englishFilePath, JSON.stringify(existingTranslations, null, 2));

    console.log('✅ Updated English translation file with gameContent section');

    // Count total entries
    const totalEntries = Object.values(gameContent).reduce((sum, section) => {
      return sum + Object.keys(section).length;
    }, 0);

    console.log(`📊 Total gameContent entries: ${totalEntries}`);
  } catch (error) {
    console.error('❌ Error updating English translation file:', error.message);
  }
}

// Run the script
updateEnglishTranslationFile();
