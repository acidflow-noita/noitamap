#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// Language mapping
const LANGUAGE_MAP = {
  en: "en",
  ru: "ru",
  br: "pt-br",
  es: "es-es",
  de: "de",
  fr: "fr-fr",
  it: "it",
  pl: "pl",
  zh: "zh-cn",
  ja: "jp",
  uk: "uk",
  nl: "en", // Fallback
  fi: "en", // Fallback
  cs: "en", // Fallback
  sv: "en", // Fallback
  id: "id",
};

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function loadBiomeTranslations() {
  const csvPath = path.join(__dirname, "../src/game-translations/common.csv");
  const content = fs.readFileSync(csvPath, "utf8");
  const lines = content.split("\n");

  const header = parseCSVLine(lines[0]);
  const biomeTranslations = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith("biome_")) continue;

    const parts = parseCSVLine(line);
    const key = parts[0];

    if (key && key.startsWith("biome_")) {
      const translations = {};
      header.forEach((lang, index) => {
        if (parts[index]) {
          translations[lang] = parts[index];
        }
      });
      biomeTranslations.set(key, translations);
    }
  }

  return biomeTranslations;
}

function main() {
  console.log("Loading biome translations from common.csv...");
  const biomeTranslations = loadBiomeTranslations();
  console.log(`Found ${biomeTranslations.size} biome translations`);

  // Process each language
  Object.entries(LANGUAGE_MAP).forEach(([langCode, csvLang]) => {
    console.log(`\nProcessing language: ${langCode} (${csvLang})`);

    const translationFilePath = path.join(
      __dirname,
      `../src/locales/${langCode}/translation.json`,
    );

    if (!fs.existsSync(translationFilePath)) {
      console.log(
        `⚠️  Translation file not found: ${langCode}/translation.json`,
      );
      return;
    }

    try {
      const existingTranslations = JSON.parse(
        fs.readFileSync(translationFilePath, "utf8"),
      );

      if (!existingTranslations.gameContent) {
        existingTranslations.gameContent = {};
      }
      if (!existingTranslations.gameContent.biomes) {
        existingTranslations.gameContent.biomes = {};
      }

      let addedCount = 0;

      // Add all biome translations
      biomeTranslations.forEach((translations, key) => {
        const translatedName = translations[csvLang];
        if (translatedName) {
          existingTranslations.gameContent.biomes[key] = translatedName;
          addedCount++;
        }
      });

      console.log(`  ✅ Added ${addedCount} biome translations`);

      // Write back to file
      fs.writeFileSync(
        translationFilePath,
        JSON.stringify(existingTranslations, null, 2),
      );
    } catch (error) {
      console.error(`❌ Error processing ${langCode}:`, error.message);
    }
  });

  console.log("\n✅ Biome translation updates complete!");
}

main();
