import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  correctTerrainShaderBits,
  POLKA_FLOAT_BITS,
  TOPOLOGY_WARP_FLOAT_BITS,
  standaloneTerrainShaders,
  shareTerrainMaterialResolve,
  optimizeTerrainShader,
} from "../build_scripts/vite-terrain-shaders";
const root = resolve(import.meta.dirname, "..");
const original = readFileSync(
  resolve(root, "lib/noita-telescope-vm/js/gl/shaders.js"),
  "utf8",
);
const float = (bits: number) =>
  new Float32Array(new Uint32Array([bits]).buffer)[0];
const bits = (value: number) =>
  new Uint32Array(new Float32Array([value]).buffer)[0];
it("shares the expensive material resolve while retaining both color and encoded-id outputs", () => {
  const source = correctTerrainShaderBits(original);
  const main = source.slice(
    source.indexOf("void main() {", source.indexOf("export const TERRAIN_FS")),
  );
  expect(main.match(/mat = engTopo2\(slot, w\);/g)).toHaveLength(1);
  expect(
    main.match(/mat = engTopo0\(slot, physSlot, leftSlot, w\);/g),
  ).toHaveLength(1);
  expect(main).toContain("if (u_materialIdOut)");
  expect(main).toContain("int code = mat + 1;");
  expect(main).toContain("if (mat > 0) engMaterialColor(mat, w);");
  expect(shareTerrainMaterialResolve(source)).toBe(source);
});
it("requires review if the pinned upstream material branch changes", () => {
  expect(() =>
    shareTerrainMaterialResolve(
      original.replace("int mat = -1;", "int mat = -2;"),
    ),
  ).toThrow("Review changed Telescope material resolve");
});
it("makes prewarm shader sources independent of archive and generator imports", () => {
  const source = standaloneTerrainShaders(
    resolve(root, "lib/noita-telescope-vm/js"),
  );
  expect(source).not.toMatch(/^import\s/m);
  expect(source).not.toMatch(/\b(?:fetch|await)\s*\(/);
  const result = new Function(
    source.replace(/export (?=const |function )/g, "") +
      "\nreturn { TERRAIN_FS, TERRAIN_VS };",
  )();
  expect(result.TERRAIN_FS).toContain("const int VIS_X = -5;");
  expect(result.TERRAIN_FS).toContain("uniform int u_verticalPlane;");
  expect(result.TERRAIN_FS).not.toContain("${");
  expect(result.TERRAIN_VS).toContain("gl_VertexID");
});

describe("terrain shader compile structure", () => {
  const evaluate = (optimize: boolean) =>
    new Function(
      standaloneTerrainShaders(
        resolve(root, "lib/noita-telescope-vm/js"),
        undefined,
        { optimize },
      ).replace(/export (?=const |function )/g, "") +
        "\nreturn { TERRAIN_FS, pixelFilterGLSL };",
    )();
  it("shares the band selector and noise calls while retaining explicit FBM expressions", () => {
    const baseline = evaluate(false).TERRAIN_FS,
      optimized = evaluate(true).TERRAIN_FS;
    expect(baseline).toContain(
      "return engBandSelect(slot, w, engMatNoiseDensity(w, cov));",
    );
    expect(optimized.match(/engBandSelect\(/g)).toHaveLength(2); // declaration + one call
    expect(optimized).toContain("for (int b = 0; b < min(nBands, 8); b++)");
    expect(optimized).toContain("for (int pass = 0; pass < passLimit; pass++)");
    expect(optimized).toContain(
      "values[octave] = engBaseNoise(coords[octave].x, coords[octave].y, variant);",
    );
    expect(optimized).toContain("if (octaves == 1) return values[0];");
    for (const line of baseline
      .split("\n")
      .filter((line: string) => /^\s+float [uv](?:2|3)? =/.test(line)))
      expect(optimized).toContain(line);
    expect(optimized).toContain("float acc = values[0] * 0.5;");
    expect(optimized).toContain("acc = acc + values[1] * 0.25;");
    expect(optimized).toContain("acc = acc + values[2] * 0.125;");
    expect(optimized).toContain("acc = acc + values[3] * 0.0625;");
    expect(optimizeTerrainShader(optimized)).toBe(optimized);
  });
  it("changes only the terrain filter, preserving shared scene/backdrop source generation", () => {
    const before = evaluate(false),
      after = evaluate(true);
    expect(after.TERRAIN_FS).toContain("for (int j = 0; j < n; j++)");
    expect(after.TERRAIN_FS).toContain("for (int i = 0; i < n; i++)");
    for (const name of ["sceneFiltered", "backdropFiltered"])
      expect(after.pixelFilterGLSL(name, "", "sample(q)")).toBe(
        before.pixelFilterGLSL(name, "", "sample(q)"),
      );
  });
  it("requires review when upstream noise expressions or loop bounds change", () => {
    const baseline = correctTerrainShaderBits(original, { optimize: false });
    expect(() =>
      optimizeTerrainShader(baseline.replace("* 2.33;", "* 2.34;")),
    ).toThrow("Review changed Telescope terrain FBM expressions");
    expect(() =>
      optimizeTerrainShader(baseline.replace("b < 8; b++", "b < 9; b++")),
    ).toThrow("Review changed Telescope terrain shader optimization");
    expect(() =>
      optimizeTerrainShader(baseline.replace("j < 4; j++", "j < 5; j++")),
    ).toThrow("Review changed Telescope terrain pixel filter");
  });
  it("rejects a changed JS interpolation instead of rewriting the shared filter", () => {
    const changed = original.replace(
      "pixelFilterGLSL('matTexelFiltered', 'uvec4 m', 'matTexelAt(m, q)')",
      'pixelFilterGLSL("matTexelFiltered", "uvec4 m", "matTexelAt(m, q)")',
    );
    expect(changed).not.toBe(original);
    expect(() => correctTerrainShaderBits(changed)).toThrow(
      "Review changed Telescope terrain pixel filter",
    );
  });
  it("guards the sample cap in both raw JS and expanded GLSL", () => {
    expect(() =>
      correctTerrainShaderBits(
        original.replace("min(int(ceil(zm)), 4)", "min(int(ceil(zm)), 5)"),
      ),
    ).toThrow("Review changed Telescope terrain pixel filter");
    const baseline = evaluate(false).TERRAIN_FS;
    expect(() =>
      optimizeTerrainShader(
        baseline.replace("min(int(ceil(zm)), 4)", "min(int(ceil(zm)), 5)"),
      ),
    ).toThrow("Review changed Telescope terrain pixel filter");
    expect(optimizeTerrainShader(baseline)).toBe(evaluate(true).TERRAIN_FS);
  });
});
describe("Noita rare-material shader constants", () => {
  it("uses the binary's exact constants, also used by the CPU port", () => {
    const cpu = readFileSync(
      resolve(root, "lib/noita-telescope-vm/js/engine_resolve/band_select.js"),
      "utf8",
    );
    for (const value of Object.values(POLKA_FLOAT_BITS))
      expect(cpu).toContain(`0x${value.toString(16)}`);
    expect(float(POLKA_FLOAT_BITS.PK_SCALAR)).toBe(0.00101319863460958);
    const fixed = correctTerrainShaderBits(original);
    for (const [name, value] of Object.entries(POLKA_FLOAT_BITS))
      expect(fixed).toContain(
        `const float ${name} = uintBitsToFloat(0x${value.toString(16)}u);`,
      );
    expect(correctTerrainShaderBits(fixed)).toBe(fixed);
  });
  it("regresses the wrong upstream values rather than pretending this is ordinary float rounding", () => {
    // Recorded from the hosted terrain shader before this fix.
    for (const [name, value] of Object.entries({
      PK_SCALAR: 0.0010132591396197677,
      PK_V0: 0.0010514580644667149,
      PK_V1: 0.0015553091652691364,
      PK_V2: 0.0012450951617211103,
    }))
      expect(bits(value)).not.toBe(
        POLKA_FLOAT_BITS[name as keyof typeof POLKA_FLOAT_BITS],
      );
  });
});

describe("Noita topology coordinate shader constants", () => {
  it("rounds the binary's double coefficients to their correct GLSL float encodings", () => {
    const cpu = readFileSync(
      resolve(
        root,
        "lib/noita-telescope-vm/js/engine_resolve/topo2_resolve.js",
      ),
      "utf8",
    );
    const doubles = {
      ENG_WARP_CX: [0x3fc18e21, 0x9652bd3c],
      ENG_WARP_CY: [0x3fc18ec9, 0x5bff0457],
      ENG_F2: [0x3fbc71c7, 0x20000000],
    };
    const fixed = correctTerrainShaderBits(original);
    for (const [name, [hi, lo]] of Object.entries(doubles)) {
      const value =
        TOPOLOGY_WARP_FLOAT_BITS[name as keyof typeof TOPOLOGY_WARP_FLOAT_BITS];
      const view = new DataView(new ArrayBuffer(8));
      view.setUint32(0, hi);
      view.setUint32(4, lo);
      expect(bits(view.getFloat64(0))).toBe(value);
      expect(cpu).toContain(
        `dblFromHex(0x${hi.toString(16)}, 0x${lo.toString(16)})`,
      );
      expect(fixed).toContain(
        `const float ${name} = uintBitsToFloat(0x${value.toString(16)}u);`,
      );
    }
  });
  it("rejects the recorded incorrect coefficients and fails closed when upstream declarations change", () => {
    const recorded = {
      ENG_WARP_CX: 0.13715155947046348,
      ENG_WARP_CY: 0.13717455323209457,
      ENG_F2: 0.11111110448837280273,
    };
    for (const [name, value] of Object.entries(recorded)) {
      expect(bits(value)).not.toBe(
        TOPOLOGY_WARP_FLOAT_BITS[name as keyof typeof TOPOLOGY_WARP_FLOAT_BITS],
      );
      expect(() =>
        correctTerrainShaderBits(
          original.replace(
            `const float ${name}`,
            `const float renamed_${name}`,
          ),
        ),
      ).toThrow(name);
    }
  });
});
