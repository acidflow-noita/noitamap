const path = require('node:path');
const fs = require('node:fs');

const relPath = (...components) => path.resolve(__dirname, ...components);

const mapDefinitions = JSON.parse(fs.readFileSync(relPath('..', 'map_definitions.json'), 'utf-8'));
const tileSourcesPath = relPath('..', 'tilesources.json');
const existing = fs.existsSync(tileSourcesPath) ? JSON.parse(fs.readFileSync(tileSourcesPath, 'utf-8')) : {};

const tileSources = (async function () {
  const tileSourceURL = (key, position, patchDate, seed) =>
    `https://${key}-${position}.acidflow.stream/maps/${key}-${position}/${key}-${position}-${patchDate}-${seed}.dzi`;

  // Start from what's already there instead of building from scratch. Two kinds
  // of entry can't be derived from map_definitions.json and were silently
  // dropped by the previous rebuild-everything approach:
  //   - keys with no definition at all (regular-beta, maptestdev, the biomemap
  //     pair) — still referenced by MapName in param-mappings.ts, so deleting
  //     them breaks the typecheck;
  //   - definitions whose source doesn't follow the per-position acidflow URL
  //     layout below (ups-main is one flat bucket: /map.dzi + /map_files).
  const output = { ...existing };

  for (const def of mapDefinitions) {
    const urls = [];
    let derivable = true;

    for (const position of def.tileSets) {
      const url = tileSourceURL(def.key, position, def.patchDate, def.seed);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const dziContent = await response.text();
        urls.push({
          url: url,
          dziContent: dziContent,
        });
      } catch (error) {
        console.error(`Failed to fetch .dzi content for URL: ${url}`, error);
        derivable = false;
        urls.push({
          url: url,
          dziContent: null,
        });
      }
    }

    // A failed fetch is not proof the map is gone — it may just not live at the
    // derived URL, or the network may be down. Either way a null dziContent is
    // strictly worse than the working entry already on disk, so keep that one.
    if (!derivable && existing[def.key]) {
      console.warn(`Keeping existing tilesources entry for ${def.key} (derived URL unavailable)`);
      continue;
    }
    output[def.key] = urls;
  }

  const jsonOutput = JSON.stringify(output, null, 2);

  fs.writeFileSync(tileSourcesPath, jsonOutput);
})();
