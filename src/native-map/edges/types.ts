/** Inputs retain the original stamper's scene order and caller-owned materials. */
export interface EdgeScene {
  x: number;
  y: number;
  width: number;
  height: number;
  grid: Int16Array;
  artMask?: Uint8Array | null;
  skipEdges?: boolean;
  edgeEligible?: boolean;
}
export interface EdgeOptions {
  chunkShiftX?: number;
  chunkShiftY?: number;
  inset?: number;
  scenes?: readonly EdgeScene[];
  biomeData?: { pixels: ArrayLike<number> };
  mapWidth?: number;
  /** The reference owns diagnostic counters; these requests use JS. */
  stats?: Record<string, number>;
}
export type StampEdges = (
  materials: Int16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  seed: number,
  options?: EdgeOptions,
) => Uint8ClampedArray;
export interface EdgeExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  buffer_ptr(index: number): number;
  configure(
    materials: number,
    entries: number,
    images: number,
    atlasWidth: number,
    reach: number,
  ): number;
  start(
    w: number,
    h: number,
    x: number,
    y: number,
    seed: number,
    sx: number,
    sy: number,
    inset: number,
  ): number;
  scene(
    x: number,
    y: number,
    w: number,
    h: number,
    clipX: number,
    clipY: number,
    cw: number,
    ch: number,
    eligible: number,
  ): number;
}
/** Injectable only at the core boundary so failure tests can exercise real WASM. */
export type EdgeInstantiate = (
  source: BufferSource | WebAssembly.Module,
  imports: WebAssembly.Imports,
) => Promise<
  | { exports: WebAssembly.Exports }
  | { instance: { exports: WebAssembly.Exports } }
>;
