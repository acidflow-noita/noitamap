import type { ModifierGrid, ModifierKey } from "../complete-materials";

/** An owned interchange format for sampled inputs, not a native save format. */
export const CAVE_STATE_FORMAT = "noitamap-named-topology0-inputs";
export const CAVE_STATE_VERSION = 1;
export const CAVE_STATE_SCOPE = "named-topology0-modifier-grids";
export const CAVE_STATE_GRID_KEYS = [
  "$biome_desert", "$biome_pyramid", "$biome_winter", "_EMPTY_",
] as const;
/** These grids can depend on extra startup/runtime state. An import never fills
 * an absent member by invoking the incomplete seed-only approximation. */
export const RUNTIME_CAVE_GRID_KEYS = ["$biome_winter", "_EMPTY_"] as const;
export const CAVE_STATE_LIMITS = Object.freeze({
  grids: 4, axis: 4096, cellsPerGrid: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024, identifierCharacters: 256,
});

export interface CaveSourceIdentity {
  readonly binarySha256: string;
  readonly dataSha256: string;
  readonly configurationSha256: string;
  readonly loadOrderSha256: string;
}
export interface CaveGenerationContext {
  readonly source: CaveSourceIdentity;
  /** Same explicit immutable asset revision as NativeWorldDescription. */
  readonly assetsRevision: string;
  readonly seed: number;
  readonly ngPlus: number;
  readonly gameMode: "normal" | "nightmare";
}
export interface CaveCaptureProvenance {
  readonly kind: "game-memory" | "synthetic";
  /** Exporter-supplied identifier. No native frame counter is assumed. */
  readonly captureId: string;
  /** An exporter assertion; structural validation cannot prove atomic capture. */
  readonly consistency: "stopped-process" | "coherent-copy" | "synthetic";
}
export interface CaveGridDescriptor {
  readonly key: ModifierKey;
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  /** Captured node+0x94, exactly representable as finite float32. */
  readonly node94: number;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface CaveStateManifest {
  readonly format: typeof CAVE_STATE_FORMAT;
  readonly version: typeof CAVE_STATE_VERSION;
  readonly scope: typeof CAVE_STATE_SCOPE;
  readonly context: CaveGenerationContext;
  readonly capture: CaveCaptureProvenance;
  readonly grids: readonly CaveGridDescriptor[];
}
/** File/worker adapters provide actual bytes, not interpreted JS number lists.
 * Each buffer is exact little-endian F32 data; descriptor keys are not paths. */
export interface CaveStatePackage {
  readonly manifest: CaveStateManifest;
  readonly buffers: Readonly<Partial<Record<ModifierKey, Uint8Array>>>;
}
export interface ImportedCaveState {
  readonly scope: typeof CAVE_STATE_SCOPE;
  readonly digest: string;
  readonly context: CaveGenerationContext;
  readonly capture: CaveCaptureProvenance;
  readonly gridKeys: readonly ModifierKey[];
  readonly missingRuntimeGridKeys: readonly ModifierKey[];
  readonly byteLength: number;
}
/** The trusted caller supplies the expected binary/data/configuration/order;
 * callers must not obtain this expectation by copying an untrusted manifest. */
export interface CaveStateBinding {
  readonly state: ImportedCaveState;
  readonly expected: CaveGenerationContext;
}
interface OwnedState {
  manifest: CaveStateManifest;
  bytes: ReadonlyMap<ModifierKey, Uint8Array>;
  grids: ReadonlyMap<ModifierKey, ModifierGrid>;
}
const owned = new WeakMap<ImportedCaveState, OwnedState>();
const keys = new Set<string>(CAVE_STATE_GRID_KEYS);
const runtimeKeys = new Set<string>(RUNTIME_CAVE_GRID_KEYS);
const sourceFields = ["binarySha256", "dataSha256", "configurationSha256", "loadOrderSha256"] as const;
const contextFields = ["source", "assetsRevision", "seed", "ngPlus", "gameMode"] as const;
function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`Invalid ${label} object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of Reflect.ownKeys(descriptors))
    if (typeof name !== "string" || !fields.includes(name) || !Object.hasOwn(descriptors[name], "value"))
      throw new TypeError(`Unsupported ${label} field`);
  return value as Record<string, unknown>;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.length > CAVE_STATE_LIMITS.identifierCharacters || /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError(`Invalid ${label}`);
  return value;
}
function digestText(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`Invalid ${label} SHA-256`);
  return value.toLowerCase();
}
function context(value: unknown): CaveGenerationContext {
  const c = record(value, contextFields, "cave generation context"), s = record(c.source, sourceFields, "cave source identity");
  if (!Number.isInteger(c.seed) || (c.seed as number) < 0 || (c.seed as number) > 0xffffffff ||
      !Number.isSafeInteger(c.ngPlus) || (c.ngPlus as number) < 0 ||
      (c.gameMode !== "normal" && c.gameMode !== "nightmare")) throw new RangeError("Invalid cave generation seed or mode");
  const source = Object.freeze(Object.fromEntries(sourceFields.map(key => [key, digestText(s[key], key)])) as unknown as CaveSourceIdentity);
  return Object.freeze({ source, assetsRevision: identifier(c.assetsRevision, "cave asset revision"),
    seed: c.seed as number, ngPlus: c.ngPlus as number, gameMode: c.gameMode });
}
function assertContext(actual: CaveGenerationContext, expected: CaveGenerationContext) {
  for (const key of ["assetsRevision", "seed", "ngPlus", "gameMode"] as const)
    if (actual[key] !== expected[key]) throw new Error(`Cave generation state ${key} mismatch`);
  for (const key of sourceFields)
    if (actual.source[key] !== expected.source[key]) throw new Error(`Cave generation state ${key} mismatch`);
}
function provenance(value: unknown): CaveCaptureProvenance {
  const p = record(value, ["kind", "captureId", "consistency"], "capture provenance");
  if ((p.kind !== "synthetic" && p.kind !== "game-memory") ||
      !["stopped-process", "coherent-copy", "synthetic"].includes(p.consistency as string) ||
      (p.kind === "synthetic") !== (p.consistency === "synthetic")) throw new Error("Invalid capture consistency assertion");
  return Object.freeze({ kind: p.kind, captureId: identifier(p.captureId, "capture identifier"), consistency: p.consistency as CaveCaptureProvenance["consistency"] });
}
async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable for cave-state import");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
function floatBits(value: number): number {
  const bytes = new ArrayBuffer(4), view = new DataView(bytes); view.setFloat32(0, value, true); return view.getUint32(0, true);
}
function checked(state: ImportedCaveState): OwnedState {
  const data = owned.get(state);
  if (!data) throw new Error("Cave state must come from validated import in this realm");
  return data;
}

/** Validate, hash and take immutable ownership before publishing a state token.
 * No fetch, filesystem access, implicit game process reads or seed replay. */
export async function importCaveGenerationState(value: unknown, expectation: CaveGenerationContext): Promise<ImportedCaveState> {
  const expected = context(expectation), input = record(value, ["manifest", "buffers"], "cave state package");
  const m = record(input.manifest, ["format", "version", "scope", "context", "capture", "grids"], "cave state manifest");
  if (m.format !== CAVE_STATE_FORMAT || m.version !== CAVE_STATE_VERSION || m.scope !== CAVE_STATE_SCOPE)
    throw new Error("Unsupported cave-state format, version or scope");
  const actual = context(m.context); assertContext(actual, expected);
  const capture = provenance(m.capture);
  if (!Array.isArray(m.grids) || !m.grids.length || m.grids.length > CAVE_STATE_LIMITS.grids)
    throw new RangeError("Cave state must contain one to four named modifier grids");
  if (Object.getPrototypeOf(m.grids) !== Array.prototype || Reflect.ownKeys(m.grids).some(key => {
    if (key === "length") return false;
    return typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(m.grids, key)!, "value");
  })) throw new TypeError("Cave grid descriptors must be a plain data array");
  const buffers = record(input.buffers, CAVE_STATE_GRID_KEYS, "cave grid buffers");
  const descriptors: CaveGridDescriptor[] = [], copies = new Map<ModifierKey, Uint8Array>(), grids = new Map<ModifierKey, ModifierGrid>();
  let totalBytes = 0;
  for (const item of m.grids) {
    const g = record(item, ["key", "width", "height", "cellCount", "node94", "byteLength", "sha256"], "cave grid descriptor");
    if (typeof g.key !== "string" || !keys.has(g.key) || copies.has(g.key as ModifierKey)) throw new Error("Unsupported or duplicate named cave grid");
    const key = g.key as ModifierKey, W = g.width as number, H = g.height as number, count = g.cellCount as number;
    if (![W, H, count, g.byteLength].every(Number.isSafeInteger) || W < 1 || H < 1 || W > CAVE_STATE_LIMITS.axis || H > CAVE_STATE_LIMITS.axis ||
        count !== W * H || count > CAVE_STATE_LIMITS.cellsPerGrid || g.byteLength !== count * 4)
      throw new RangeError("Invalid cave grid dimensions, count or byte length");
    if (typeof g.node94 !== "number" || !Number.isFinite(g.node94) || Math.abs(g.node94) > 2 ** 26 || !Object.is(Math.fround(g.node94), g.node94))
      throw new RangeError("Captured cave node94 must be a bounded exact float32");
    totalBytes += count * 4;
    if (totalBytes > CAVE_STATE_LIMITS.totalBytes) throw new RangeError("Cave-state byte budget exceeded");
    const source = buffers[key];
    if (!(source instanceof Uint8Array) || !(source.buffer instanceof ArrayBuffer) || source.byteLength !== count * 4)
      throw new TypeError("Cave grid requires bounded nonshared little-endian bytes");
    // All attacker-owned metadata/bytes are snapshotted before the first await.
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source); // Typed-array copy; do not invoke a supplied iterator.
    const view = new DataView(bytes.buffer), data = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const v = view.getFloat32(i * 4, true);
      if (!Number.isFinite(v)) throw new RangeError("Nonfinite captured cave density");
      data[i] = v;
    }
    copies.set(key, bytes); grids.set(key, { W, H, node94: g.node94, data });
    descriptors.push(Object.freeze({ key, width: W, height: H, cellCount: count, node94: g.node94,
      byteLength: count * 4, sha256: digestText(g.sha256, "cave grid") }));
  }
  if (Object.keys(buffers).length !== descriptors.length) throw new Error("Unreferenced or missing cave grid buffer");
  descriptors.sort((a, b) => CAVE_STATE_GRID_KEYS.indexOf(a.key) - CAVE_STATE_GRID_KEYS.indexOf(b.key));
  await Promise.all(descriptors.map(async d => {
    if (await sha256(copies.get(d.key)!) !== d.sha256) throw new Error(`Captured cave grid checksum mismatch: ${d.key}`);
  }));
  // Canonical semantic identity deliberately excludes captureId/method: two
  // coherent captures of identical inputs can reuse the same completed pixels.
  const identity = new TextEncoder().encode(JSON.stringify({ format: CAVE_STATE_FORMAT, version: CAVE_STATE_VERSION,
    scope: CAVE_STATE_SCOPE, context: actual, grids: descriptors.map(d => ({ key: d.key, width: d.width, height: d.height,
      node94Bits: floatBits(d.node94), sha256: d.sha256 })) }));
  const digest = await sha256(identity);
  const manifest: CaveStateManifest = Object.freeze({ format: CAVE_STATE_FORMAT, version: CAVE_STATE_VERSION,
    scope: CAVE_STATE_SCOPE, context: actual, capture, grids: Object.freeze(descriptors) });
  const state: ImportedCaveState = Object.freeze({ scope: CAVE_STATE_SCOPE, digest, context: actual, capture,
    gridKeys: Object.freeze(descriptors.map(d => d.key)),
    missingRuntimeGridKeys: Object.freeze(RUNTIME_CAVE_GRID_KEYS.filter(key => !copies.has(key))), byteLength: totalBytes });
  owned.set(state, { manifest, bytes: copies, grids }); return state;
}

/** Revalidate the trusted execution identity at use, even after a worker/cache
 * roundtrip. A structured-cloned token is rejected; import its exported bytes. */
export function validateCaveStateBinding(binding: CaveStateBinding, world?: {
  seed: number; ngPlus: number; gameMode: "normal" | "nightmare"; assetsRevision: string;
}): ImportedCaveState {
  if (!binding || typeof binding !== "object") throw new TypeError("Invalid cave-state binding");
  checked(binding.state); assertContext(binding.state.context, context(binding.expected));
  if (world) for (const name of ["seed", "ngPlus", "gameMode", "assetsRevision"] as const)
    if (world[name] !== binding.state.context[name]) throw new Error(`Cave generation state ${name} mismatch`);
  return binding.state;
}

/** New copies belong to the consuming resolver. Missing runtime-dependent
 * named grids are explicit nulls; deterministic named overrides are optional. */
export function copyCaveStateModifiers(binding: CaveStateBinding): Partial<Record<ModifierKey, ModifierGrid | null>> {
  const state = validateCaveStateBinding(binding), data = checked(state);
  const result: Partial<Record<ModifierKey, ModifierGrid | null>> = {};
  for (const key of CAVE_STATE_GRID_KEYS) {
    const grid = data.grids.get(key);
    if (grid) result[key] = { W: grid.W, H: grid.H, node94: grid.node94, data: Float32Array.from(grid.data) };
    else if (runtimeKeys.has(key)) result[key] = null;
  }
  return result;
}

/** Explicit durable/worker transport; callers receive independent bytes. */
export function exportCaveGenerationState(state: ImportedCaveState): CaveStatePackage {
  const data = checked(state);
  return { manifest: data.manifest, buffers: Object.fromEntries([...data.bytes].map(([key, bytes]) => [key, Uint8Array.from(bytes)])) };
}

/** Append to the FULL existing seed/settings key, never use digest alone as the
 * complete map key. Seed-only and captured-state maps cannot collide. */
export function withCaveStateCacheIdentity(baseIdentity: string, state?: ImportedCaveState): string {
  if (typeof baseIdentity !== "string" || !baseIdentity.length) throw new TypeError("A complete base map identity is required");
  if (state) checked(state);
  return JSON.stringify([baseIdentity, CAVE_STATE_FORMAT, CAVE_STATE_VERSION, state?.digest ?? null]);
}
