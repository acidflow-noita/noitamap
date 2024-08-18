const fs = require("fs");
const mapDefinitions = JSON.parse(fs.readFileSync("./mapDefinitions.json", "utf-8"));
const tileSources = (function () {
  const tileSourceURL = (key, position, patchDate, seed) =>
    `https://${key}-${position}.acidflow.stream/maps/${key}-${position}/${key}-${position}-${patchDate}-${seed}.dzi`;

  const output = {};
  for (const def of mapDefinitions) {
    const urls = [];
    for (const position of def.tileSets) {
      urls.push(tileSourceURL(def.key, position, def.patchDate, def.seed));
    }
    output[def.key] = urls;
  }

  fs.writeFileSync("./tilesources.json", JSON.stringify(output));
})();

const tileSourceDirectories = (function () {
  const tileSourceDirectory = (key, position, patchDate, seed) =>
    `https://${key}-${position}.acidflow.stream/maps/${key}-${position}/${key}-${position}-${patchDate}-${seed}_files`;

  const output = {};
  for (const def of mapDefinitions) {
    const dirs = [];
    for (const position of def.tileSets) {
      dirs.push(tileSourceDirectory(def.key, position, def.patchDate, def.seed));
    }
    output[def.key] = dirs;
  }

  fs.writeFileSync("./tilesourcedirectories.json", JSON.stringify(output));
})();
