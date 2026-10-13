import { writeFile } from "node:fs/promises";
import {
  PERM_CLASSIC,
  PERM_CUSTOM,
  BIOME_ENGINE,
} from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { K } from "../lib/noita-telescope-vm/js/engine_resolve/topo2_resolve.js";
if (BIOME_ENGINE.some((b) => typeof b.noiseBiomeEdges !== "boolean"))
  throw new Error("Native biome noise policy needs review");
const floats = new Set([
  "a_mul",
  "a_add",
  "y_mul",
  "y_add",
  "one_f",
  "half_f",
  "two_f",
  "three_f",
  "dens_warp",
  "dens_scale",
  "dens_k1",
  "dens_k2",
]);
const literal = (n) => (Number.isInteger(n) ? `${n}.0` : n.toPrecision(17));
let output =
  "// Generated from the pinned JS reference, not a game-accuracy oracle.\n";
for (const [name, values] of Object.entries({
  classic: PERM_CLASSIC,
  custom: PERM_CUSTOM,
})) {
  output += `static const unsigned char ${name}[512] = {${[...values, ...values].join(",")}};\n`;
}
for (const [name, value] of Object.entries(K)) {
  output += `static const ${floats.has(name) ? "float" : "double"} K_${name} = ${literal(value)}${floats.has(name) ? "f" : ""};\n`;
}
for (const [name, bits] of Object.entries({
  INV71: 0x3c66c2b4,
  SCALAR: 0x3a84cd4e,
  V0: 0x3a89ce48,
  V1: 0x3acbdc41,
  V2: 0x3aa32fcf,
})) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  output += `static const float BAND_${name}=${literal(view.getFloat32(0))}f;\n`;
}
await writeFile(
  new URL("../src/native-map/materials/constants.h", import.meta.url),
  output,
);
// Band values intentionally remain doubles: the JS reference compares its
// f32 densities against authored decimal doubles, not pre-rounded f32 limits.
const bands = [],
  biomes = [];
for (const b of BIOME_ENGINE) {
  biomes.push(
    `{${literal(b.setMin)},${literal(b.setMax)},${bands.length},${b.bands.length},${b.topo},${b.supported ? 1 : 0},${b.noiseBiomeEdges !== false ? 1 : 0},${b.color & 0xffffff}}`,
  );
  for (const c of b.bands) {
    const r = c.rare;
    bands.push(
      `{${c.mat},${c.limY ? 1 : 0},${c.addP ? 1 : 0},${r ? 1 : 0},${r?.perlin ? 1 : 0},${r?.polka ? 1 : 0},${r?.boxed ? 1 : 0},` +
        [
          c.min,
          c.max,
          ...(c.limY ?? [0, 0]),
          ...(c.addP ?? [0, 0]),
          r?.sx ?? 0,
          r?.sy ?? 0,
          r?.ox ?? 0,
          r?.oy ?? 0,
          r?.plo ?? 0,
          r?.phi ?? 0,
          r?.prob ?? 0,
          r?.rmin ?? 0,
          r?.rmax ?? 0,
        ]
          .map(literal)
          .join(",") +
        "}",
    );
  }
}
await writeFile(
  new URL("../src/native-map/materials/bands-data.h", import.meta.url),
  `static const Band bands[${bands.length}]={\n${bands.join(",\n")}\n};\nstatic const Biome biomes[${biomes.length}]={\n${biomes.join(",\n")}\n};\n#define BIOME_COUNT ${biomes.length}\n`,
);
