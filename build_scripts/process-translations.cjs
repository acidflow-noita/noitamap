#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Language mapping from i18next codes to CSV columns
const LANGUAGE_MAP = {
  en: 'en',
  ru: 'ru',
  br: 'pt-br',
  es: 'es-es',
  de: 'de',
  fr: 'fr-fr',
  it: 'it',
  pl: 'pl',
  zh: 'zh-cn',
  ja: 'jp',
  ko: 'ko',
  uk: 'uk', // Ukrainian now has its own column in CSV
  nl: 'en', // Fallback to English for Dutch
  fi: 'en', // Fallback to English for Finnish
  cs: 'en', // Fallback to English for Czech
  sv: 'en', // Fallback to English for Swedish
  id: 'id',
};

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  // Add the last field
  result.push(current);
  return result;
}

function loadTranslations() {
  const csvPath = path.join(__dirname, '../src/game-translations/common.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf8');

  const lines = csvContent.split('\n');
  if (lines.length < 2) return new Map();

  // Parse header to get language columns
  const headers = parseCSVLine(lines[0]);
  const languageColumns = {};

  headers.forEach((header, index) => {
    if (header && Object.values(LANGUAGE_MAP).includes(header)) {
      languageColumns[header] = index;
    }
  });

  const translations = new Map();

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const columns = parseCSVLine(line);
    const key = columns[0];
    if (!key) continue;

    const translationData = {};
    Object.entries(languageColumns).forEach(([lang, colIndex]) => {
      const translation = columns[colIndex];
      if (translation && translation.trim()) {
        translationData[lang] = translation.trim();
      }
    });

    if (Object.keys(translationData).length > 0) {
      translations.set(key, translationData);
    }
  }

  return translations;
}

function findTranslationKey(translations, englishName) {
  for (const [key, translationData] of translations.entries()) {
    if (translationData['en']?.toLowerCase() === englishName.toLowerCase()) {
      return key;
    }
  }
  return null;
}

function addTranslationsToData(data, translations, nameField = 'name') {
  return data.map(item => {
    const englishName = item[nameField];
    const translationKey = findTranslationKey(translations, englishName);

    if (translationKey) {
      const translationData = translations.get(translationKey);
      const translatedNames = {};

      // Add translations for all supported languages
      Object.entries(LANGUAGE_MAP).forEach(([langCode, csvLang]) => {
        if (translationData[csvLang]) {
          translatedNames[langCode] = translationData[csvLang];
        }
      });

      return {
        ...item,
        translations: translatedNames,
      };
    }

    return item;
  });
}

function processDataFiles() {
  console.log('Loading translations from CSV...');
  const translations = loadTranslations();
  console.log(`Loaded ${translations.size} translation entries`);

  const dataDir = path.join(__dirname, '../src/data');
  const dataFiles = [
    { file: 'spells.json', nameField: 'name' },
    { file: 'items.json', nameField: 'name' },
    { file: 'bosses.json', nameField: 'name' },
    { file: 'structures.json', nameField: 'name' },
    { file: 'orbs.json', nameField: 'name' },
    // Add more data files as needed
  ];

  dataFiles.forEach(({ file, nameField }) => {
    const filePath = path.join(dataDir, file);

    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  File not found: ${file}`);
      return;
    }

    try {
      console.log(`Processing ${file}...`);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const processedData = addTranslationsToData(data, translations, nameField);

      // Count how many items got translations
      const translatedCount = processedData.filter(item => item.translations).length;
      console.log(`  ✅ Added translations to ${translatedCount}/${processedData.length} items`);

      // Write back to file
      fs.writeFileSync(filePath, JSON.stringify(processedData, null, 2));
    } catch (error) {
      console.error(`❌ Error processing ${file}:`, error.message);
    }
  });

  console.log('✅ Translation processing complete!');
}

function updateLanguageFiles() {
  console.log('Loading translations from CSV...');
  const translations = loadTranslations();
  console.log(`Loaded ${translations.size} translation entries`);

  // Load spells and other game data
  const dataDir = path.join(__dirname, '../src/data');
  const spellsPath = path.join(dataDir, 'spells.json');

  if (!fs.existsSync(spellsPath)) {
    console.error('❌ spells.json not found');
    return;
  }

  const spells = JSON.parse(fs.readFileSync(spellsPath, 'utf8'));
  console.log(`Loaded ${spells.length} spells`);

  // Process each language
  Object.entries(LANGUAGE_MAP).forEach(([langCode, csvLang]) => {
    if (langCode === 'en') return; // Skip English as it's the base

    console.log(`\nProcessing language: ${langCode} (${csvLang})`);

    const translationFilePath = path.join(__dirname, `../src/locales/${langCode}/translation.json`);

    if (!fs.existsSync(translationFilePath)) {
      console.log(`⚠️  Translation file not found: ${langCode}/translation.json`);
      return;
    }

    try {
      // Load existing translation file
      const existingTranslations = JSON.parse(fs.readFileSync(translationFilePath, 'utf8'));

      // Add game content section if it doesn't exist
      if (!existingTranslations.gameContent) {
        existingTranslations.gameContent = {};
      }
      if (!existingTranslations.gameContent.spells) {
        existingTranslations.gameContent.spells = {};
      }

      let addedCount = 0;

      // Process spells
      spells.forEach(spell => {
        const englishName = spell.name;

        // Find translation in CSV by matching English name
        for (const [key, translationData] of translations.entries()) {
          if (translationData['en']?.toLowerCase() === englishName.toLowerCase()) {
            const translatedName = translationData[csvLang];
            if (translatedName && translatedName !== englishName) {
              existingTranslations.gameContent.spells[englishName] = translatedName;
              addedCount++;
            }
            break;
          }
        }
      });

      // Process other game content types
      const gameDataFiles = [
        { file: 'items.json', key: 'items' },
        { file: 'bosses.json', key: 'bosses' },
        { file: 'structures.json', key: 'structures' },
        { file: 'orbs.json', key: 'orbs' },
        { file: 'biomes.json', key: 'biomes' },
        { file: 'orb_areas.json', key: 'orbAreas' },
        { file: 'overlays_regular_game.json', key: 'overlaysRegular' },
        { file: 'overlays_new_game_plus_orbs.json', key: 'overlaysNewGamePlus' },
      ];

      gameDataFiles.forEach(({ file, key }) => {
        const filePath = path.join(__dirname, `../src/data/${file}`);
        if (fs.existsSync(filePath)) {
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let contentAddedCount = 0;

            if (!existingTranslations.gameContent[key]) {
              existingTranslations.gameContent[key] = {};
            }

            // Handle different data structures
            if (Array.isArray(data)) {
              data.forEach(item => {
                // Handle different item structures
                const englishName = item.name || item.text || item.label;
                if (!englishName) return;

                // Find translation in CSV by matching English name
                for (const [csvKey, translationData] of translations.entries()) {
                  if (translationData['en']?.toLowerCase() === englishName.toLowerCase()) {
                    const translatedName = translationData[csvLang];
                    if (translatedName && translatedName !== englishName) {
                      existingTranslations.gameContent[key][englishName] = translatedName;
                      contentAddedCount++;
                    }
                    break;
                  }
                }

                // For overlays, also check text arrays
                if (item.text && Array.isArray(item.text)) {
                  item.text.forEach(textItem => {
                    for (const [csvKey, translationData] of translations.entries()) {
                      if (translationData['en']?.toLowerCase() === textItem.toLowerCase()) {
                        const translatedName = translationData[csvLang];
                        if (translatedName && translatedName !== textItem) {
                          existingTranslations.gameContent[key][textItem] = translatedName;
                          contentAddedCount++;
                        }
                        break;
                      }
                    }
                  });
                }

                // For biomes, check biome names
                if (item.biome) {
                  for (const [csvKey, translationData] of translations.entries()) {
                    if (translationData['en']?.toLowerCase() === item.biome.toLowerCase()) {
                      const translatedName = translationData[csvLang];
                      if (translatedName && translatedName !== item.biome) {
                        existingTranslations.gameContent[key][item.biome] = translatedName;
                        contentAddedCount++;
                      }
                      break;
                    }
                  }
                }
              });
            } else if (typeof data === 'object') {
              // Handle object-based data structures
              Object.values(data).forEach(item => {
                if (typeof item === 'object' && item.name) {
                  const englishName = item.name;

                  for (const [csvKey, translationData] of translations.entries()) {
                    if (translationData['en']?.toLowerCase() === englishName.toLowerCase()) {
                      const translatedName = translationData[csvLang];
                      if (translatedName && translatedName !== englishName) {
                        existingTranslations.gameContent[key][englishName] = translatedName;
                        contentAddedCount++;
                      }
                      break;
                    }
                  }
                }
              });
            }

            if (contentAddedCount > 0) {
              console.log(`    ✅ Added ${contentAddedCount} ${key} translations`);
              addedCount += contentAddedCount;
            }
          } catch (error) {
            console.log(`    ⚠️  Could not process ${file}: ${error.message}`);
          }
        }
      });

      console.log(`  ✅ Added ${addedCount} spell translations`);

      // Write updated translation file
      fs.writeFileSync(translationFilePath, JSON.stringify(existingTranslations, null, 2));
    } catch (error) {
      console.error(`❌ Error processing ${langCode}:`, error.message);
    }
  });

  console.log('\n✅ Language file updates complete!');
}

// Run the script
updateLanguageFiles();
