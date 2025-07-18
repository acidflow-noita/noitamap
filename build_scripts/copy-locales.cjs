#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, '../src/locales');
const targetDir = path.join(__dirname, '../public/locales');

// Create target directory if it doesn't exist
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Function to copy directory recursively
function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  let copiedFiles = 0;

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copiedFiles += copyDirectory(srcPath, destPath);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.copyFileSync(srcPath, destPath);
      copiedFiles++;
    }
  }

  return copiedFiles;
}

// Copy all translation files
const copiedCount = copyDirectory(sourceDir, targetDir);

console.log(`✅ ${copiedCount} translation files copied successfully from src/locales to public/locales`);
