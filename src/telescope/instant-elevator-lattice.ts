import { buildEngineLattice } from "noita-telescope-full-pixels/engine_resolve/lattice_builder.js";
import {
  createCoverageLatticeTexture,
  createMaterialLatticeTexture,
} from "noita-telescope-full-pixels/gl/textures.js";

/** Pack the narrow continuations beside the shared world lattice. The shader
 * wraps each rectangle independently; no extra sampler or world lattice is
 * needed for the lower plane. Matches the CPU renderer's region-local storage. */
export function packElevatorLattices(
  base: any,
  shafts: any[],
  config: any,
  limit: number,
) {
  const regions = shafts.map((shaft) => {
    if (shaft.minY !== 47 || shaft.biomeName !== "robobase")
      throw new Error("Invalid instant elevator origin");
    const local = {
      ...shaft,
      minX: 0,
      minY: 0,
      chunkBasePos: { x: 0, y: 0 },
      validChunks: undefined,
    };
    const lattice = buildEngineLattice(
      [local],
      config,
      Math.ceil(shaft.w / 512),
      Math.ceil(shaft.h / 512),
    );
    return { column: shaft.minX, x: 0, lattice };
  });
  if (!regions.length) return { lattice: base, base, regions };
  let GW = base.GW;
  const GH = Math.max(base.GH, ...regions.map((region) => region.lattice.GH));
  for (const region of regions) {
    region.x = GW;
    GW += region.lattice.GW;
  }
  if (GW > limit || GH > limit || GW > 65535 || GH > 65535)
    throw new Error("Instant elevator lattice exceeds texture capacity");
  // Keep the generated buffers separate until upload; their rectangles share
  // one texture so the shader stays inside WebGL2's minimum sampler count.
  return { lattice: { GW, GH, cov: null, mat: null }, base, regions };
}

export function createPackedLatticeTextures(
  gl: any,
  packed: ReturnType<typeof packElevatorLattices>,
) {
  const { GW, GH } = packed.lattice;
  // A null allocation followed by partial texSubImage2D uploads makes Firefox
  // security-clear the entire large texture first. Supply every texel in its
  // first upload, including padding. Reuse one temporary buffer for coverage
  // and material uploads instead of retaining two packed CPU lattices.
  const scratch = packed.regions.length ? new ArrayBuffer(GW * GH * 4) : undefined;
  const upload = (kind: "cov" | "mat") => {
    let lattice = packed.lattice;
    if (scratch) {
      const data = kind === "cov"
        ? new Float32Array(scratch)
        : new Uint16Array(scratch, 0, GW * GH);
      if (kind === "mat") data.fill(0);
      for (const { x, lattice: source } of [
        { x: 0, lattice: packed.base },
        ...packed.regions,
      ]) {
        for (let y = 0; y < source.GH; y++)
          data.set(source[kind].subarray(y * source.GW, (y + 1) * source.GW), y * GW + x);
      }
      lattice = { ...packed.lattice, [kind]: data };
    }
    const texture = kind === "cov"
      ? createCoverageLatticeTexture(gl, lattice)
      : createMaterialLatticeTexture(gl, lattice);
    if (!texture) throw new Error("Instant lattice texture allocation failed");
    return texture;
  };
  const cov = upload("cov");
  try {
    return { cov, mat: upload("mat") };
  } catch (error) {
    gl.deleteTexture(cov);
    throw error;
  }
}

/** Reuse the existing engine-table sampler: R is its unchanged biome flags;
 * GBA identifies the local shaft rectangle. Ordinary R16UI maps read B=0. */
export function createElevatorChunkTexture(
  gl: any,
  chunks: Uint16Array,
  width: number,
  regions: ReturnType<typeof packElevatorLattices>["regions"],
) {
  const data = new Uint16Array(chunks.length * 4);
  for (let i = 0; i < chunks.length; i++) data[i * 4] = chunks[i];
  for (const region of regions)
    for (let y = 0; y < 48; y++) {
      const i = (y * width + region.column) * 4;
      data[i + 1] = region.x;
      data[i + 2] = region.lattice.GW;
      data[i + 3] = region.lattice.GH;
    }
  const texture = gl.createTexture();
  if (!texture) throw new Error("Instant elevator texture allocation failed");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16UI,
    width,
    48,
    0,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_SHORT,
    data,
  );
  return texture;
}
