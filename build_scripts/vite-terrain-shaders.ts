import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
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

/** Both output modes resolve exactly the same material. Keep one call site
 * for the large topology/noise tree so drivers need not compile it twice. */
export function shareTerrainMaterialResolve(source: string): string {
  const marker = '        // Noitamap: resolve once for color and material-id output.';
  if (source.includes(marker)) return source;
  const start = source.indexOf('        // Material-id output (edge-decal tiles, terrain_renderer.js');
  const end = source.indexOf('    }\n\n    ivec2 pos;', start);
  if (start < 0 || end < 0) throw new Error('Review changed Telescope material resolve');
  const original = source.slice(start, end);
  if (createHash('sha256').update(original.replace(/\r\n/g, '\n')).digest('hex') !==
      '27d5e2abc50e8ce427644cff925f7371f39cb0ba52b25dfbf2a40e9d63cb33ff')
    throw new Error('Review changed Telescope material resolve');
  return source.slice(0, start) + `${marker}
        int mat = -1;
        if ((info & 2048u) != 0u) {
            mat = 0;
        } else if (mode != 2u) {
            int slot = int(info & 0xffu);
            if (mode == 1u) {
                mat = engTopo2(slot, w);
            } else {
                int pcx = fdiv(w.x + u_centerPx, CHUNK);
                int pcy = fdiv(w.y + u_baseY, CHUNK);
                int physSlot = int(engInfoAt(pcx, pcy) & 0xffu);
                int leftSlot = int(engInfoAt(pcx - 1, pcy) & 0xffu);
                mat = engTopo0(slot, physSlot, leftSlot, w);
            }
            if (mat < 0) mat = 0;
        }
        if (u_materialIdOut) {
            int code = mat + 1;
            outColor = vec4(float(code & 0xff) / 255.0, float((code >> 8) & 0xff) / 255.0, 0.0, 1.0);
            return;
        }
        if (mat >= 0) {
            if (mat > 0) engMaterialColor(mat, w);
            return;
        }
` + source.slice(end);
}

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
  if (!source.includes("ivec3 engElevatorRect;")) {
    const replaceOnce = (before: string, after: string) => {
      if (source.split(before).length !== 2)
        throw new Error(
          "Review updated Telescope terrain shader: elevator integration changed",
        );
      source = source.replace(before, after);
    };
    replaceOnce(
      "float covAt(int x, int y) {",
      `// A shaft has its own toroidal lattice, packed beside the world lattice.
// Metadata reuses the engine-table texture, keeping the WebGL2 16-sampler limit.
ivec3 engElevatorRect;
int engElevatorColumn;
ivec2 engLatticeAddress(int x, int y) {
    if (engElevatorRect.y > 0)
        return ivec2(engElevatorRect.x + pmod(x, engElevatorRect.y), pmod(y, engElevatorRect.z));
    return ivec2(pmod(x, u_mapWidth * 512 / 10), pmod(y, 48 * 512 / 10));
}
float covAt(int x, int y) {`,
    );
    replaceOnce(
      "ivec2 s = textureSize(u_covTex, 0);\n    return texelFetch(u_covTex, ivec2(pmod(x, s.x), pmod(y, s.y)), 0).r;",
      "return texelFetch(u_covTex, engLatticeAddress(x, y), 0).r;",
    );
    replaceOnce(
      "ivec2 s = textureSize(u_latMatTex, 0);\n    return int(texelFetch(u_latMatTex, ivec2(pmod(x, s.x), pmod(y, s.y)), 0).r);",
      "return int(texelFetch(u_latMatTex, engLatticeAddress(x, y), 0).r);",
    );
    replaceOnce(
      "vec2 c = engLookupCoordAbsolute(scale, w);",
      `vec2 c = engLookupCoordAbsolute(scale, w);
    if (engElevatorRect.y > 0) {
        int pw = fdiv(w.x + u_centerPx, u_worldWidth);
        c.x -= float(engElevatorColumn * 512 / 10) + float(pw * u_worldWidth) / 10.0;
        c.y -= float(47 * 512 / 10);
        return c;
    }`,
    );
    replaceOnce(
      "if (u_engineTerrain) {\n        ivec2 cell = engResolveCell(w);",
      `if (u_engineTerrain) {
        engElevatorRect = ivec3(0);
        if (u_verticalPlane == 1) {
            engElevatorColumn = pmod(fdiv(w.x + u_centerPx, CHUNK), u_mapWidth);
            engElevatorRect = ivec3(texelFetch(u_engChunkTex, ivec2(engElevatorColumn, 0), 0).gba);
        }
        ivec2 cell = engResolveCell(w);`,
    );
  }
  return shareTerrainMaterialResolve(source);
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
