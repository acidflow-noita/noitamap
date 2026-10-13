import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import {
  generateDynamicMap,
  releaseParallelWorlds,
  initTelescope,
} from "../../src/telescope/telescope-adapter";
import { SharedInstantTerrainResources } from "../../src/telescope/shared-instant-terrain";
import { GLTerrainRenderer } from "noita-telescope-full-pixels/gl/terrain_renderer.js";
import {
  GENERATOR_CONFIG,
  BIOME_COLOR_TO_NAME,
} from "noita-telescope-full-pixels/generator_config.js";

/** Compare programs on the same uploaded textures. Coordinate/accumulation
 * loop rewrites previously flipped material IDs, including in the pool and
 * overview windows below; only the repeated noise calls may be looped. */
type Sample = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  plane: -1 | 0 | 1;
  pw: number;
  zoom?: number;
};

export async function verifyTerrainShaderParity(native: any) {
  setFullPixelTerrainForBake(true);
  await initTelescope();
  const renderer: any = new GLTerrainRenderer();
  if (!renderer.initContext()) throw Error(renderer.failed);
  const gl = renderer.gl,
    resources: any = new SharedInstantTerrainResources(renderer),
    programs: any[] = [];
  for (const source of native.variants) {
    const started = performance.now(),
      program = gl.createProgram(),
      stages = [];
    for (const [type, code] of [
      [gl.VERTEX_SHADER, source.TERRAIN_VS],
      [gl.FRAGMENT_SHADER, source.TERRAIN_FS],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, code);
      const before = performance.now();
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      stages.push(performance.now() - before);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    const before = performance.now();
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    native.finish();
    const uniforms: any = {};
    for (const match of source.TERRAIN_FS.matchAll(
      /uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*;/g,
    ))
      uniforms[match[1]] = gl.getUniformLocation(program, match[1]);
    const result = {
      name: source.name,
      program,
      uniforms,
      compileLinkMs: performance.now() - started,
      shaderCompileMs: stages,
      linkMs: performance.now() - before,
      firstDrawMs: null as number | null,
    };
    programs.push(result);
    native.progress(
      "compiled " + source.name + " " + result.compileLinkMs.toFixed(1) + "ms",
    );
  }
  const select = (p: any) => {
    renderer.program = p.program;
    renderer.uniforms = p.uniforms;
    resources.liquidUniform = p.uniforms.u_liquidRow;
    gl.useProgram(p.program);
  };
  select(programs[0]);
  const draw = (program: any, s: Sample, ids = false) => {
    select(program);
    resources.setPlane(s.plane);
    renderer.canvas.getContext("webgl2");
    const zoom = s.zoom ?? 1,
      before = performance.now();
    const canvas = renderer.render({
      width: s.width,
      height: s.height,
      camX:
        s.x +
        renderer.centerPx +
        s.width / 2 / zoom -
        s.pw * renderer.mapWidth * 512,
      camY: s.y + 7168 + s.height / 2 / zoom,
      camZ: zoom,
      pw: s.pw,
      pwVertical: 0,
      edgeNoise: true,
      materialTextures: true,
      engineTerrain: true,
    });
    if (ids) {
      gl.uniform1i(program.uniforms.u_materialIdOut, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    native.finish();
    const elapsedMs = performance.now() - before;
    if (program.firstDrawMs === null) program.firstDrawMs = elapsedMs;
    if (gl.getError()) throw Error("Draw GL error");
    return {
      elapsedMs,
      pixels: new Uint8ClampedArray(canvas.__nativeGlesPixels),
    };
  };
  const comparisons: any[] = [],
    cases: any[] = [];
  const settings = [
    { seed: 786433191, ngPlus: 0, gameMode: "normal" },
    { seed: 195331, ngPlus: 0, gameMode: "normal" },
    { seed: 100199613, ngPlus: 0, gameMode: "normal" },
    { seed: 92, ngPlus: 1, gameMode: "normal" },
    { seed: 1, ngPlus: 0, gameMode: "nightmare" },
  ];
  try {
    for (const options of settings) {
      native.progress("generating " + JSON.stringify(options));
      select(programs[0]);
      const gen = await generateDynamicMap({
        ...options,
        parallelWorlds: [0],
        unlocks: null,
      });
      await resources.ensureResources(gen.tileLayers, gen.biomeData, {
        ...options,
        seed: gen.seed,
        isNGP: gen.isNGP,
        gameMode: options.gameMode,
        elevatorShafts: gen.elevatorShafts,
        generatorConfig: GENERATOR_CONFIG,
        lut: { recolorMaterials: true, clearSpawnPixels: true },
      });
      const samples: Sample[] = [],
        width = renderer.mapWidth,
        worldWidth = width * 512;
      for (const plane of [-1, 0, 1] as const)
        for (const pw of [-1, 0, 1])
          for (const [name, x, y, w, h] of [
            ["mines", -4032, 64, 64, 64],
            ["material", -3520, 1600, 64, 64],
            ["top-seam", -width * 256 - 16, -7184, 32, 32],
            ["surface", -512, -256, 96, 96],
            ["bottom-seam", -4032, 17392, 32, 32],
          ] as const)
            samples.push({
              name,
              x: x + pw * worldWidth,
              y: y + plane * 24576,
              width: w,
              height: h,
              plane,
              pw,
            });
      if (options.seed === 195331 || options.seed === 100199613) {
        const area =
          options.seed === 195331
            ? { x: -3230, y: 810, w: 200, h: 120 }
            : { x: -2910, y: 2190, w: 800, h: 430 };
        for (const plane of [-1, 0, 1] as const)
          for (const pw of [-1, 0, 1])
            samples.push({
              name: "reported-pool",
              x: area.x + pw * worldWidth,
              y: area.y + plane * 24576,
              width: area.w,
              height: area.h,
              plane,
              pw,
            });
      }
      // Real chunk data across all present biome colors, including topology-0 FBM,
      // fixed fills and legacy fallbacks. No fabricated density/biome uniforms.
      const seen = new Set<number>();
      for (let i = 0; i < gen.biomeData.pixels.length; i++) {
        const color = gen.biomeData.pixels[i] & 0xffffff;
        if (seen.has(color)) continue;
        seen.add(color);
        samples.push({
          name: "biome-" + (BIOME_COLOR_TO_NAME[color] ?? color.toString(16)),
          x: (i % width) * 512 - renderer.centerPx + 224,
          y: Math.floor(i / width) * 512 - 7168 + 224,
          width: 32,
          height: 32,
          plane: 0,
          pw: 0,
        });
      }
      samples.push(
        {
          name: "overview-filter",
          x: -renderer.centerPx,
          y: -7168,
          width: 512,
          height: 384,
          zoom: 512 / worldWidth,
          plane: 0,
          pw: 0,
        },
        {
          name: "fractional-detail",
          x: -4100.25,
          y: 97.375,
          width: 128,
          height: 96,
          zoom: 2.3,
          plane: 0,
          pw: 0,
        },
      );
      for (const sample of samples)
        for (const ids of [false, true]) {
          const expected = draw(programs[0], sample, ids).pixels!;
          let visible = 0;
          for (let i = 3; i < expected.length; i += 4)
            if (expected[i]) visible++;
          const outputs = programs
            .slice(1)
            .map((program) => ({
              program,
              actual: draw(program, sample, ids).pixels!,
            }));
          for (const { program, actual } of outputs) {
            let mismatchedBytes = 0,
              mismatchedPixels = 0,
              maxChannelError = 0;
            const examples: any[] = [];
            for (let i = 0; i < expected.length; i += 4) {
              let mismatch = false;
              for (let c = 0; c < 4; c++)
                if (actual[i + c] !== expected[i + c]) {
                  mismatchedBytes++;
                  mismatch = true;
                  maxChannelError = Math.max(
                    maxChannelError,
                    Math.abs(actual[i + c] - expected[i + c]),
                  );
                }
              if (mismatch) {
                mismatchedPixels++;
                if (examples.length < 3)
                  examples.push({
                    pixel: i / 4,
                    expected: Array.from(expected.subarray(i, i + 4)),
                    actual: Array.from(actual.subarray(i, i + 4)),
                  });
              }
            }
            comparisons.push({
              ...options,
              ...sample,
              variant: program.name,
              ids,
              visible,
              bytes: expected.length,
              mismatchedBytes,
              mismatchedPixels,
              maxChannelError,
              examples,
            });
          }
        }
      cases.push({
        ...options,
        samples: samples.length,
        biomes: seen.size,
        liquidBytes: resources.stats.liquidBytes,
      });
      native.progress(
        "verified " + options.seed + " " + samples.length + " windows",
      );
    }
  } finally {
    resources.invalidate();
    releaseParallelWorlds();
    for (const p of programs) gl.deleteProgram(p.program);
  }
  return {
    programs: programs.map(
      ({ name, compileLinkMs, shaderCompileMs, linkMs, firstDrawMs }) => ({
        name,
        compileLinkMs,
        shaderCompileMs,
        linkMs,
        firstDrawMs,
      }),
    ),
    cases,
    comparisonCount: comparisons.length,
    comparedBytes: comparisons.reduce((sum, c) => sum + c.bytes, 0),
    mismatchedBytes: comparisons.reduce((sum, c) => sum + c.mismatchedBytes, 0),
    failures: comparisons.filter((c) => c.mismatchedBytes),
    comparisons,
  };
}
