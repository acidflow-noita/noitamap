const path = require('node:path');
const fs = require('node:fs');

const relPath = (...components) => path.resolve(__dirname, ...components);

const mapDefinitions = JSON.parse(fs.readFileSync(relPath('..', 'map_definitions.json'), 'utf-8'));

const tileSources = (async function () {
  const tileSourceURL = (key, position, patchDate, seed) =>
    `https://${key}-${position}.acidflow.stream/maps/${key}-${position}/${key}-${position}-${patchDate}-${seed}.dzi`;

  const output = {};

  for (const def of mapDefinitions) {
    const urls = [];
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
        urls.push({
          url: url,
          dziContent: null,
        });
      }
    }
    output[def.key] = urls;
  }

  const jsonOutput = JSON.stringify(output, null, 2);

  fs.writeFileSync(relPath('..', 'tilesources.json'), jsonOutput);
})();
