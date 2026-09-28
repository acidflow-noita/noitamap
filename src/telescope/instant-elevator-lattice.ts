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
  // Allocate only the final GPU storage. Upload the existing buffers into its
  // rectangles below, avoiding a second 50+ MiB staging copy on mobile.
  return { lattice: { GW, GH, cov: null, mat: null }, base, regions };
}

export function createPackedLatticeTexture(
  gl: any,
  packed: ReturnType<typeof packElevatorLattices>,
  kind: "cov" | "mat",
) {
  const texture =
    kind === "cov"
      ? createCoverageLatticeTexture(gl, packed.lattice)
      : createMaterialLatticeTexture(gl, packed.lattice);
  if (packed.regions.length)
    for (const { x, lattice } of [
      { x: 0, lattice: packed.base },
      ...packed.regions,
    ])
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        0,
        lattice.GW,
        lattice.GH,
        kind === "cov" ? gl.RED : gl.RED_INTEGER,
        kind === "cov" ? gl.FLOAT : gl.UNSIGNED_SHORT,
        lattice[kind],
      );
  return texture;
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
