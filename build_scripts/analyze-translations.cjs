#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, '../src/locales');
const englishFile = path.join(localesDir, 'en/translation.json');

// Read English translation as reference
const englishTranslation = JSON.parse(fs.readFileSync(englishFile, 'utf8'));

// Function to count all translatable keys recursively
function countKeys(obj, prefix = '') {
  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      count++;
    } else if (typeof value === 'object' && value !== null) {
      count += countKeys(value, prefix ? `${prefix}.${key}` : key);
    }
  }
  return count;
}

// Function to count translated keys (non-English placeholders)
function countTranslated(obj, prefix = '') {
  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Count as translated if it's not an obvious English placeholder
      // English placeholders are typically lowercase English words or phrases
      const isEnglishPlaceholder =
        /^[a-z][a-z\s-]*[a-z]?$/i.test(value) &&
        value
          .split(' ')
          .every(word =>
            [
              'the',
              'of',
              'and',
              'to',
              'a',
              'in',
              'is',
              'it',
              'you',
              'that',
              'he',
              'was',
              'for',
              'on',
              'are',
              'as',
              'with',
              'his',
              'they',
              'i',
              'at',
              'be',
              'this',
              'have',
              'from',
              'or',
              'one',
              'had',
              'by',
              'word',
              'but',
              'not',
              'what',
              'all',
              'were',
              'we',
              'when',
              'your',
              'can',
              'said',
              'there',
              'each',
              'which',
              'she',
              'do',
              'how',
              'their',
              'if',
              'will',
              'up',
              'other',
              'about',
              'out',
              'many',
              'then',
              'them',
              'these',
              'so',
              'some',
              'her',
              'would',
              'make',
              'like',
              'into',
              'him',
              'has',
              'two',
              'more',
              'go',
              'no',
              'way',
              'could',
              'my',
              'than',
              'first',
              'been',
              'call',
              'who',
              'oil',
              'its',
              'now',
              'find',
              'long',
              'down',
              'day',
              'did',
              'get',
              'come',
              'made',
              'may',
              'part',
              'spell',
              'magic',
              'bolt',
              'trigger',
              'timer',
              'arrow',
              'burst',
              'air',
              'energy',
              'orb',
              'black',
              'hole',
              'white',
              'giga',
              'omega',
              'large',
              'giant',
              'bubble',
              'spark',
              'disc',
              'projectile',
              'sphere',
              'bouncing',
              'glowing',
              'lance',
              'holy',
              'missile',
              'firebolt',
              'crystal',
              'unstable',
              'dormant',
              'summon',
              'fish',
              'concentrated',
              'light',
              'intense',
              'lightning',
              'ball',
              'plasma',
              'beam',
              'cross',
              'cutter',
              'digging',
              'blast',
              'chainsaw',
              'luminous',
              'drill',
              'tentacle',
              'healing',
              'deadly',
              'heal',
              'spiral',
              'shot',
              'guard',
              'big',
              'chain',
              'fireball',
              'flamethrower',
              'iceball',
              'slimeball',
              'path',
              'dark',
              'flame',
              'missile',
              'rock',
              'spirit',
              'dynamite',
              'glitter',
              'bomb',
              'triplicate',
              'freezing',
              'gaze',
              'pinpoint',
              'prickly',
              'spore',
              'pod',
              'glue',
              'propane',
              'tank',
              'cart',
              'cursed',
              'expanding',
              'earthquake',
              'egg',
              'hollow',
              'explosive',
              'box',
              'fly',
              'swarm',
              'firebug',
              'wasp',
              'friendly',
              'acid',
              'thunder',
              'charge',
              'chunk',
              'soil',
              'death',
              'cross',
              'infestation',
              'horizontal',
              'barrier',
              'vertical',
              'square',
              'wall',
              'platform',
              'glittering',
              'field',
            ].includes(word.toLowerCase())
          );

      if (!isEnglishPlaceholder) {
        count++;
      }
    } else if (typeof value === 'object' && value !== null) {
      count += countTranslated(value, prefix ? `${prefix}.${key}` : key);
    }
  }
  return count;
}

// Find the translation file with the most keys to use as reference
let maxKeys = 0;
let referenceTranslation = englishTranslation;

const langDirs = fs
  .readdirSync(localesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

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

// Analyze all language files
const results = {};
const totalKeys = countKeys(referenceTranslation);

console.log(`📊 Translation Analysis Report`);
console.log(`Total translatable keys: ${totalKeys} (using most complete file as reference)`);
console.log('');

for (const lang of langDirs) {
  const langFile = path.join(localesDir, lang, 'translation.json');

  if (!fs.existsSync(langFile)) {
    results[lang] = { completeness: 0, humanVerified: 0, totalKeys: 0, translatedKeys: 0 };
    continue;
  }

  try {
    const translation = JSON.parse(fs.readFileSync(langFile, 'utf8'));

    // English is always 100% complete as it's the reference
    if (lang === 'en') {
      const actualKeys = countKeys(translation);
      results[lang] = {
        completeness: 100,
        humanVerified: 100, // English is human-verified by definition
        totalKeys: actualKeys,
        translatedKeys: actualKeys,
      };
      console.log(`${lang}: 100% complete (${actualKeys}/${actualKeys} keys) - REFERENCE`);
    } else {
      const translatedKeys = countTranslated(translation);
      const completeness = Math.round((translatedKeys / totalKeys) * 100);

      results[lang] = {
        completeness,
        humanVerified: 0, // Will be calculated after we implement the new structure
        totalKeys,
        translatedKeys,
      };

      console.log(`${lang}: ${completeness}% complete (${translatedKeys}/${totalKeys} keys)`);
    }
  } catch (error) {
    console.error(`Error reading ${lang}: ${error.message}`);
    results[lang] = { completeness: 0, humanVerified: 0, totalKeys: 0, translatedKeys: 0 };
  }
}

console.log('');
console.log('📝 Next steps:');
console.log('1. Implement humanVerified structure in translation files');
console.log('2. Mark common.csv translations as human-verified');
console.log('3. Add completeness indicators to language dropdown');

// Save results for use by other scripts
fs.writeFileSync(path.join(__dirname, '../translation-analysis.json'), JSON.stringify(results, null, 2));

console.log('');
console.log('✅ Analysis saved to translation-analysis.json');
