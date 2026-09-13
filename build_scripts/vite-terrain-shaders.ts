import { resolve } from "node:path";
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

export function correctTerrainShaderBits(source: string): string {
  for (const [name, bits] of Object.entries(POLKA_FLOAT_BITS)) {
    const pattern = new RegExp(`const float ${name}\\s*=\\s*[^;]+;`, "g");
    const matches = source.match(pattern);
    if (matches?.length !== 1) throw new Error(`Review updated Telescope terrain shader: expected one ${name} constant`);
    source = source.replace(pattern, `const float ${name} = uintBitsToFloat(0x${bits.toString(16)}u);`);
  }
  return source;
}

export function terrainShaderBitsPlugin(directory: string): Plugin {
  const path = resolve(directory, "gl/shaders.js").replace(/\\/g, "/");
  return {
    name: "noita-exact-terrain-shader-constants",
    enforce: "pre",
    transform(source, id) {
      if (id !== path) return null;
      return { code: correctTerrainShaderBits(source), map: null };
    },
  };
}
