#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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

function escapeCSVField(field) {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

function mergeUkrainianTranslations() {
  console.log('Loading source common.csv...');
  const sourcePath = path.join(__dirname, '../src/game-translations/common.csv');
  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  const sourceLines = sourceContent.split('\n');

  console.log('Loading Ukrainian translations...');
  const ukPath = path.join(__dirname, '../src/game-translations/uk-translation.csv');
  const ukContent = fs.readFileSync(ukPath, 'utf8');
  const ukLines = ukContent.split('\n');

  // Parse Ukrainian translations into a map
  const ukTranslations = new Map();
  for (let i = 1; i < ukLines.length; i++) {
    const line = ukLines[i].trim();
    if (!line) continue;

    const columns = parseCSVLine(line);
    const key = columns[0];
    const ukTranslation = columns[1]; // This is the "ukr" column

    if (key && ukTranslation) {
      ukTranslations.set(key, ukTranslation);
    }
  }

  console.log(`Loaded ${ukTranslations.size} Ukrainian translations`);

  // Process source file
  const newLines = [];

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    if (!line.trim()) {
      newLines.push(line);
      continue;
    }

    const columns = parseCSVLine(line);

    if (i === 0) {
      // Header line - add Ukrainian column after Korean (index 10)
      const newColumns = [...columns];
      newColumns.splice(11, 0, 'uk'); // Insert 'uk' at position 11
      newLines.push(newColumns.map(escapeCSVField).join(','));
    } else if (i === 1) {
      // Language names line
      const newColumns = [...columns];
      newColumns.splice(11, 0, 'Українська'); // Insert Ukrainian language name
      newLines.push(newColumns.map(escapeCSVField).join(','));
    } else {
      // Data lines
      const key = columns[0];
      const newColumns = [...columns];

      // Add Ukrainian translation if available
      const ukTranslation = ukTranslations.get(key) || '';
      newColumns.splice(11, 0, ukTranslation);

      newLines.push(newColumns.map(escapeCSVField).join(','));
    }
  }

  // Write the merged file
  const outputContent = newLines.join('\n');
  fs.writeFileSync(sourcePath, outputContent);

  console.log('✅ Successfully merged Ukrainian translations into common.csv');

  // Count how many translations were added
  let addedCount = 0;
  for (const [key, translation] of ukTranslations) {
    if (translation.trim()) {
      addedCount++;
    }
  }

  console.log(`📊 Added ${addedCount} Ukrainian translations`);
}

// Run the merge
mergeUkrainianTranslations();
