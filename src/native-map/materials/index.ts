import materialModuleUrl from "./owned-materials.wasm?url";

export interface MaterialLattice {
  GW: number;
  GH: number;
  cov: Float32Array;
  mat: Uint16Array;
  chunkCovered: Uint8Array;
}
export interface MaterialShaft {
  /** Physical chunk column, wrapped into the biome map. Last duplicate wins. */
  column: number;
  lattice: Omit<MaterialLattice, "chunkCovered">;
  offsetY: number;
  originX: number;
}
export interface MaterialPlane {
  /** Absolute vertical plane translation; noise still samples absolute Y. */
  offsetY: number;
  shafts?: ReadonlyArray<MaterialShaft>;
}
export interface MaterialParameters {
  scale: number;
  threshold: number;
  type: number;
}
export interface MaterialInputs {
  lattice: MaterialLattice;
  biomePixels: ArrayLike<number>;
  mapWidth: number;
  hostChunks: Uint32Array;
  parameters: ReadonlyArray<MaterialParameters>;
  /** Omit for the main plane. Shaft grids are shared with the JS fallback. */
  plane?: MaterialPlane;
}
export interface NativeMaterialResolver {
  /** Borrowed storage, valid only until the next resolve. Negative IDs require JS. */
  resolve(x: number, y: number, width: number, height: number): Int32Array;
}
interface MaterialExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  heap_base(): number;
  abi_version(): number;
  configure(
    w: number,
    h: number,
    cov: number,
    mat: number,
    params: number,
    count: number,
    offx: number,
  ): void;
  configure_world(
    colors: number,
    width: number,
    covered: number,
    ids: number,
  ): void;
  configure_host_chunks(chunks: number): void;
  configure_vertical(
    offsetY: number,
    originX: number,
    hasOrigin: number,
    limitOffset: number,
  ): void;
  resolve_vertical_rect: MaterialExports["resolve_cpu_rect"];
  resolve_vertical_cpu_rect: MaterialExports["resolve_cpu_rect"];
  resolve_cpu_rect(
    x: number,
    y: number,
    width: number,
    height: number,
    cos: number,
    sin: number,
    out: number,
  ): void;
}
const MAX_EDGE = 640;
const MAX_LATTICE_CELLS = 3584 * 2457;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_COORDINATE = 2 ** 30;
const align = (value: number) => Math.ceil(value / 16) * 16;
let modulePromise: Promise<WebAssembly.Module | null> | undefined;

/** One immutable compiled module per worker; seed buffers belong to each terrain. */
function loadModule(): Promise<WebAssembly.Module | null> {
  return (modulePromise ??= (async () => {
    if (typeof WebAssembly === "undefined") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(materialModuleUrl, {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await WebAssembly.compile(await response.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })());
}

/** Start optional immutable code delivery alongside the CPU's normal inputs. */
export function warmNativeMaterialModule(): void {
  void loadModule();
}

async function readyModule(): Promise<WebAssembly.Module | null> {
  // A slow optional download continues for later contexts without retaining
  // this seed's lattice or delaying the existing CPU path beyond 50 ms.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadModule(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 50);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validGrid(lattice: Omit<MaterialLattice, "chunkCovered">): boolean {
  return (
    Number.isInteger(lattice.GW) &&
    Number.isInteger(lattice.GH) &&
    lattice.GW > 0 &&
    lattice.GH > 0 &&
    lattice.GW * lattice.GH <= MAX_LATTICE_CELLS &&
    lattice.cov.length === lattice.GW * lattice.GH &&
    lattice.mat.length === lattice.cov.length
  );
}
function validTranslation(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}
function checkRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    Math.abs(x) > MAX_COORDINATE ||
    Math.abs(y) > MAX_COORDINATE ||
    width < 1 ||
    height < 1 ||
    width > MAX_EDGE ||
    height > MAX_EDGE
  )
    throw new RangeError("Invalid native material rectangle");
}

/** Load, validation and allocation failure preserve the original JS renderer. */
export async function createNativeMaterialResolver(
  input: MaterialInputs,
): Promise<NativeMaterialResolver | null> {
  try {
    const { lattice, mapWidth, parameters, plane } = input;
    const cells = mapWidth * 48;
    const planeOffset = plane?.offsetY ?? 0;
    const shafts = new Map<number, MaterialShaft>();
    if (
      ![64, 70].includes(mapWidth) ||
      !validGrid(lattice) ||
      lattice.chunkCovered.length !== cells ||
      input.biomePixels.length !== cells ||
      input.hostChunks.length !== cells ||
      parameters.length > 65536
    )
      return null;
    if (plane) {
      if (
        !Number.isSafeInteger(planeOffset) ||
        !validTranslation(planeOffset) ||
        (plane.shafts?.length ?? 0) > mapWidth
      )
        return null;
      for (const shaft of plane.shafts ?? []) {
        if (
          !Number.isInteger(shaft.column) ||
          shaft.column < 0 ||
          shaft.column >= mapWidth ||
          !validGrid(shaft.lattice) ||
          !validTranslation(shaft.offsetY) ||
          !validTranslation(shaft.originX)
        )
          return null;
        shafts.set(shaft.column, shaft);
      }
    }
    const module = await readyModule();
    if (!module) return null;
    let retainedBytes = shafts.size ? MAX_EDGE * MAX_EDGE * 4 : 0;
    async function context(
      grid: Omit<MaterialLattice, "chunkCovered">,
      shaft?: MaterialShaft,
    ) {
      const { exports } = await WebAssembly.instantiate(module!);
      const wasm = exports as MaterialExports;
      if (wasm.abi_version() !== 2)
        throw new Error("Unsupported native material ABI");
      let next = align(wasm.heap_base());
      const allocate = (bytes: number) => {
        const result = next;
        next = align(next + bytes);
        return result;
      };
      const cov = allocate(grid.cov.byteLength),
        mat = allocate(grid.mat.byteLength);
      const params = allocate(parameters.length * 16),
        colors = allocate(cells * 4);
      const covered = allocate(cells),
        biomeIds = allocate(cells * 4),
        chunks = allocate(cells * 4);
      const cos = allocate(MAX_EDGE * 8),
        sin = allocate(MAX_EDGE * 8),
        out = allocate(MAX_EDGE * MAX_EDGE * 4);
      retainedBytes += Math.ceil(next / 65536) * 65536;
      if (retainedBytes > MAX_TOTAL_BYTES)
        throw new RangeError("Native material memory budget exceeded");
      if (next > wasm.memory.buffer.byteLength)
        wasm.memory.grow(
          Math.ceil((next - wasm.memory.buffer.byteLength) / 65536),
        );
      // Configuration is immutable: no later memory.grow can detach borrowed views.
      const memory = wasm.memory.buffer;
      new Float32Array(memory, cov, grid.cov.length).set(grid.cov);
      new Uint16Array(memory, mat, grid.mat.length).set(grid.mat);
      new Uint32Array(memory, colors, cells).set(input.biomePixels);
      const coverage = new Uint8Array(memory, covered, cells);
      if (shaft) coverage.fill(1);
      else coverage.set(lattice.chunkCovered);
      new Uint32Array(memory, chunks, cells).set(input.hostChunks);
      const table = new DataView(memory, params, parameters.length * 16);
      parameters.forEach((p, i) => {
        table.setFloat32(i * 16, p.scale, true);
        table.setFloat32(i * 16 + 4, p.threshold, true);
        table.setInt32(i * 16 + 8, p.type, true);
        table.setInt32(i * 16 + 12, 1, true);
      });
      wasm.configure(
        grid.GW,
        grid.GH,
        cov,
        mat,
        params,
        parameters.length,
        mapWidth * 256,
      );
      wasm.configure_world(colors, mapWidth, covered, biomeIds);
      wasm.configure_host_chunks(chunks);
      if (plane)
        wasm.configure_vertical(
          shaft?.offsetY ?? planeOffset,
          shaft?.originX ?? 0,
          shaft ? 1 : 0,
          planeOffset,
        );
      const cosine = new Float64Array(memory, cos, MAX_EDGE),
        sine = new Float64Array(memory, sin, MAX_EDGE);
      const run = !plane
        ? wasm.resolve_cpu_rect
        : shaft
          ? wasm.resolve_vertical_rect
          : wasm.resolve_vertical_cpu_rect;
      return {
        resolve(x: number, y: number, width: number, height: number) {
          for (let col = 0; col < width; col++)
            cosine[col] = Math.cos((x + col + mapWidth * 256) * 0.005);
          for (let row = 0; row < height; row++)
            sine[row] = Math.sin((y + row + 7168) * 0.005);
          run(x, y, width, height, cos, sin, out);
          return new Int32Array(memory, out, width * height);
        },
      };
    }
    const main = await context(lattice);
    const local = new Map<number, Awaited<ReturnType<typeof context>>>();
    for (const [column, shaft] of shafts)
      local.set(column, await context(shaft.lattice, shaft));
    if (!plane || !local.size)
      return {
        resolve(x, y, width, height) {
          checkRectangle(x, y, width, height);
          return main.resolve(x, y, width, height);
        },
      };
    const output = new Int32Array(MAX_EDGE * MAX_EDGE);
    return {
      resolve(x, y, width, height) {
        checkRectangle(x, y, width, height);
        output.fill(0, 0, width * height);
        const top = Math.max(y, planeOffset - 7168),
          bottom = Math.min(y + height, planeOffset + 17408);
        // Rectangles and plane offsets are integral in the CPU renderer. Reject
        // a fractional clip rather than silently truncating the output row offset.
        if (!Number.isInteger(top) || !Number.isInteger(bottom))
          throw new RangeError("Nonintegral native plane extent");
        if (bottom > top)
          for (let col = 0; col < width;) {
            const wx = x + col,
              physical = Math.floor((wx + mapWidth * 256) / 512);
            const column = ((physical % mapWidth) + mapWidth) % mapWidth;
            const count = Math.min(
              width - col,
              (physical + 1) * 512 - mapWidth * 256 - wx,
            );
            // Like rawMaterialAt, shafts take precedence over the host chunk flags.
            const values = (local.get(column) ?? main).resolve(
              wx,
              top,
              count,
              bottom - top,
            );
            for (let row = 0; row < bottom - top; row++)
              output.set(
                values.subarray(row * count, (row + 1) * count),
                (top - y + row) * width + col,
              );
            col += count;
          }
        return output.subarray(0, width * height);
      },
    };
  } catch {
    return null;
  }
}
