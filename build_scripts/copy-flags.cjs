#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, '../node_modules/@designsystemsinternational/flags/flag');
const targetDir = path.join(__dirname, '../public/flags');

const requiredFlags = [
  'United States.svg',
  'Russia.svg',
  'China.svg',
  'Germany.svg',
  'Japan.svg',
  'Ukraine.svg',
  'Brazil.svg',
  'Poland.svg',
  'France.svg',
  'Spain.svg',
  'Netherlands.svg',
  'Finland.svg',
  'Czechia.svg',
  'Italy.svg',
  'Sweden.svg',
  'Argentina.svg',
];

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Copy only the required flag files
let copiedCount = 0;
requiredFlags.forEach(flagFile => {
  const sourcePath = path.join(sourceDir, flagFile);
  const targetPath = path.join(targetDir, flagFile);

  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    copiedCount++;
  } else {
    console.warn(`⚠️  Flag not found: ${flagFile}`);
  }
});

console.log(`${copiedCount}/${requiredFlags.length} flags copied successfully`);
