const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const INPUTS = [
  "public/data.zip",
  "build_scripts/build-spritesheet.cjs",
  "build_scripts/spell-card-sprites.cjs",
  "build_scripts/spritesheet-cache.cjs",
  "package-lock.json",
];
const OUTPUTS = [
  "public/assets/spritesheet.png",
  "public/assets/atlas.json",
  "src/data/atlas.json",
  "src/data/spritesheet-revision.json",
];
const CACHE_FILE = "node_modules/.cache/noitamap/spritesheet.json";

function outputHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function spritesheetInputFingerprint(root) {
  const hash = createHash("sha256").update(JSON.stringify({
    node: process.versions.node,
    zlib: process.versions.zlib,
    jszip: require("jszip/package.json").version,
    pngjs: require("pngjs/package.json").version,
  }));
  const files = [...INPUTS];
  const icons = path.join(root, "src/material-icons");
  if (fs.existsSync(icons)) {
    // Match the generator's file order: it affects sprite placement.
    for (const file of fs.readdirSync(icons)) {
      if (file.endsWith(".png")) files.push(`src/material-icons/${file}`);
    }
  }
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file));
    hash.update(JSON.stringify([file, bytes.length])).update(bytes);
  }
  return hash.digest("hex");
}

function hasCurrentSpritesheet(root, fingerprint) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(root, CACHE_FILE), "utf8"));
    return cache.version === 1 && cache.fingerprint === fingerprint &&
      OUTPUTS.every(file => cache.outputs?.[file] === outputHash(path.join(root, file)));
  } catch {
    // A missing/partial cache or output is always a cache miss.
    return false;
  }
}

function saveSpritesheetCache(root, fingerprint) {
  const outputs = Object.fromEntries(OUTPUTS.map(file => [file, outputHash(path.join(root, file))]));
  const target = path.join(root, CACHE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ version: 1, fingerprint, outputs }) + "\n");
}

module.exports = { spritesheetInputFingerprint, hasCurrentSpritesheet, saveSpritesheetCache };
