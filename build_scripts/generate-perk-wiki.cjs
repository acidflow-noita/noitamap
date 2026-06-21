// Fetches the Perks cargo table from noita.wiki.gg and bakes a static
// id -> { wikipage, image } map into src/data/perk-wiki.json.
// Used for per-perk wiki links and as an icon fallback for perks whose
// sprite is missing from the local atlas (e.g. Stainless Armour).
const fs = require("fs");
const path = require("path");

(async () => {
  const url =
    "https://noita.wiki.gg/api.php?action=cargoquery&tables=Perks&fields=id,_pageName=wikipage,Image,Name&limit=500&format=json";
  const res = await fetch(url);
  const json = await res.json();
  const rows = json.cargoquery.map((r) => r.title);

  const out = {};
  for (const row of rows) {
    const id = (row.id || "").trim();
    if (!id) continue;
    out[id.toUpperCase()] = {
      wikipage: (row.wikipage || row.Name || "").trim(),
      // Cargo Image may come back as "File:Perk_x.png" or bare "Perk_x.png".
      // Special:FilePath expects the bare filename.
      image: (row.Image || "").trim().replace(/^File:/i, ""),
    };
  }

  const dest = path.join(__dirname, "..", "src", "data", "perk-wiki.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${Object.keys(out).length} perks to ${dest}`);
})();
