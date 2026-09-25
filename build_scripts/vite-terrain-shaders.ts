import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plugin } from "vite";

/** Exact float32 values read from Noita's RarePolka hash implementation.
 * The upstream shader's decimal constants differ by hundreds of float ULPs;
 * multiplying by a ~5e8 hash base moves entire rare-material patches.
 * Keep the bits, rather than another rounded decimal transcription.
 * PK_SCALAR/PK_V0: .rdata 0105342c/01053430; PK_V1/PK_V2: immediates
 * at 0086fe8f/0086fe99; PK_INV71: .rdata 01053470. */
export const POLKA_FLOAT_BITS = {
  PK_INV71: 0x3c66c2b4,
  PK_SCALAR: 0x3a84cd4e,
  PK_V0: 0x3a89ce48,
  PK_V1: 0x3acbdc41,
  PK_V2: 0x3aa32fcf,
} as const;

/** Float32 encodings of BiomeNodeLookupCoord's actual coefficients.
 * Ghidra-MCP and the executable's .rdata agree: warp X/Y are the doubles
 * 0.13715 / 0.13717 at 010538c0 / 010538c8, and F2 is float(1/9)
 * widened to double at 010538b0. Upstream transcribed different values.
 * The game multiplies in double before converting to float; correcting these
 * constants does not make GLSL's float-only multiplication bit-identical. */
export const TOPOLOGY_WARP_FLOAT_BITS = {
  ENG_WARP_CX: 0x3e0c710d,
  ENG_WARP_CY: 0x3e0c764b,
  ENG_F2: 0x3de38e39,
} as const;

export function correctTerrainShaderBits(source: string): string {
  for (const [name, bits] of Object.entries({
    ...POLKA_FLOAT_BITS,
    ...TOPOLOGY_WARP_FLOAT_BITS,
  })) {
    const pattern = new RegExp(`const float ${name}\\s*=\\s*[^;]+;`, "g");
    const matches = source.match(pattern);
    if (matches?.length !== 1)
      throw new Error(
        `Review updated Telescope terrain shader: expected one ${name} constant`,
      );
    source = source.replace(
      pattern,
      `const float ${name} = uintBitsToFloat(0x${bits.toString(16)}u);`,
    );
  }
  // Each vertical plane reuses the main Wang lattice, with a broadcast biome
  // map. Its noise uses absolute world coordinates; only chunk/lattice storage
  // is translated. Native bake consumers leave the new uniform at zero.
  if (!source.includes("uniform int u_verticalPlane;")) {
    const replaceOnce = (before: string, after: string) => {
      if (source.split(before).length !== 2)
        throw new Error(
          "Review updated Telescope terrain shader: vertical-plane integration changed",
        );
      source = source.replace(before, after);
    };
    replaceOnce(
      "uniform float u_surfacePhase;",
      "uniform int u_verticalPlane;\nuniform float u_surfacePhase;",
    );
    replaceOnce(
      "clamp(cy, 0, u_maxRow)), 0).r;",
      "clamp(cy - u_verticalPlane * 48, 0, u_maxRow)), 0).r;",
    );
    replaceOnce(
      "vec2 engLookupCoord(float scale, ivec2 w)",
      "vec2 engLookupCoordAbsolute(float scale, ivec2 w)",
    );
    replaceOnce(
      "float sstep2(float t)",
      `// Subtract plane * 2457.6 after noise, as createPlaneMaterialField does.
// Splitting the offset avoids rounding it before the subtract: 2457.6 cannot
// be represented exactly in float32, while the game's subtraction is double.
vec2 engLookupCoord(float scale, ivec2 w) {
    vec2 c = engLookupCoordAbsolute(scale, w);
    float plane = float(u_verticalPlane);
    c.y = (c.y - plane * 2457.60009765625) + plane * 0.00009765625;
    return c;
}

float sstep2(float t)`,
    );
  }
  return source;
}

export function terrainShaderBitsPlugin(directory: string): Plugin {
  const path = resolve(directory, "gl/shaders.js").replace(/\\/g, "/");
  const standalone = "\0virtual:instant-terrain-shaders";
  return {
    name: "noita-exact-terrain-shader-constants",
    enforce: "pre",
    resolveId(id) {
      if (id === "virtual:instant-terrain-shaders") return standalone;
    },
    load(id) {
      if (id !== standalone) return null;
      return standaloneTerrainShaders(directory, (file) =>
        this.addWatchFile(file),
      );
    },
    transform(source, id) {
      if (id !== path) return null;
      return { code: correctTerrainShaderBits(source), map: null };
    },
  };
}

/** Shader imports normally transitively evaluate the generator and archive
 * loaders. Prewarm needs only their numeric constants. Copy these literals
 * from the pinned source at build time, never maintain a second coefficient
 * table and never execute the generator just to start shader compilation. */
export function standaloneTerrainShaders(
  directory: string,
  watch: (file: string) => void = () => {},
): string {
  const read = (file: string) => {
    watch(file);
    return readFileSync(file, "utf8");
  };
  const imports = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/gm;
  function literal(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): string {
    const key = `${file}:${name}`;
    if (seen.has(key)) throw new Error(`Cyclic terrain shader constant ${key}`);
    seen.add(key);
    const source = read(file);
    const found = source.match(
      new RegExp(`export const ${name}\\s*=\\s*([^;]+);`),
    );
    if (found) {
      const value = found[1].trim();
      if (!/^(?:0x[0-9a-f]+|\d+|[\s,[\]()<>+\-])+$/i.test(value))
        throw new Error(
          `Terrain shader constant is no longer a numeric literal: ${key}`,
        );
      return value;
    }
    for (const match of source.matchAll(imports))
      if (
        match[1]
          .split(",")
          .map((item) => item.trim())
          .includes(name)
      )
        return literal(resolve(dirname(file), match[2]), name, seen);
    throw new Error(`Missing terrain shader constant ${key}`);
  }
  const file = resolve(directory, "gl/shaders.js");
  return correctTerrainShaderBits(read(file)).replace(
    imports,
    (_statement, names: string, relative: string) =>
      names
        .split(",")
        .map((name) => {
          name = name.trim();
          if (!/^\w+$/.test(name))
            throw new Error("Review changed shader imports");
          return `const ${name} = ${literal(resolve(dirname(file), relative), name)};`;
        })
        .join("\n"),
  );
}
