import scheme from "./seed-scheme.json";
import archiveSource from "./archive-source.json";

export const SAGE_AXES = [
  "greatChests",
  "chests",
  "shops",
  "wands",
  "hearts",
  "potions",
  "pouches",
  "hvSpells",
  "mimics",
] as const;
export type SageAxis = (typeof SAGE_AXES)[number];
export const SAGE_WORLDS = [-1, 0, 1] as const;
export type SageWorld = (typeof SAGE_WORLDS)[number];
export type WorldCounts = Record<SageWorld, number>;
export type WorldCategories = Record<SageWorld, Record<string, number>>;
export interface SageRecord {
  /** Verified archive revision, independent of the binary schema version. */
  populationRevision?: number;
  seed: number;
  axes: Record<SageWorld, Record<SageAxis, number>>;
  highSlotWands: WorldCounts;
  hordeCreatures: WorldCategories;
  totalSpells: WorldCounts;
  looseLootSpells: WorldCounts;
  wandSpells: WorldCounts;
  spellDamageTypes: WorldCategories;
  spellTypes: WorldCategories;
  factionCreatures: WorldCategories;
}
export interface SageReader {
  cached(seed: number): SageRecord | null;
  read(seed: number, signal?: AbortSignal): Promise<SageRecord>;
}

/** The pinned published shard layout, not the separate 1..40000 review snapshot.
 * schemaVersion identifies the binary layout, NOT a completed V4 population bake.
 * Each lookup requests TWO fixed records: the selected seed plus its neighbor.
 * Both seed tags must match, detecting an incorrect record size or stale schema.
 */
export function locateSageSeed(seed: number) {
  if (
    !Number.isInteger(seed) ||
    seed < scheme.firstSeed ||
    seed > scheme.lastSeed
  ) {
    throw new Error(`Sage covers seeds ${scheme.firstSeed}–${scheme.lastSeed}`);
  }
  const shardStart =
    scheme.firstSeed +
    Math.floor((seed - scheme.firstSeed) / scheme.seedsPerFile) *
      scheme.seedsPerFile;
  const shardEnd = Math.min(
    shardStart + scheme.seedsPerFile - 1,
    scheme.lastSeed,
  );
  const first = seed === shardEnd ? seed - 1 : seed;
  const start = scheme.headerBytes + (first - shardStart) * scheme.recordBytes;
  const length = 2 * scheme.recordBytes;
  const host =
    1 + scheme.splitSeeds.filter((boundary) => seed > boundary).length;
  const file = scheme.namePattern
    .replace("{start}", String(shardStart).padStart(10, "0"))
    .replace("{end}", String(shardEnd).padStart(10, "0"));
  return {
    seed,
    first,
    start,
    length,
    end: start + length - 1,
    url: `https://sage-data-${host}.acidflow.stream/${file}`,
  };
}

export function decodeSageRecord(bytes: Uint8Array, seed: number): SageRecord {
  const location = locateSageSeed(seed);
  if (bytes.byteLength !== location.length)
    throw new Error("Incomplete Sage record pair");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== location.first ||
    view.getUint32(scheme.recordBytes, true) !== location.first + 1
  ) {
    throw new Error("Sage record tags do not match the requested seed/schema");
  }
  const base = (seed - location.first) * scheme.recordBytes;
  const data: Record<string, unknown> = {};
  for (const field of scheme.recordFields) {
    const { offset, type } = field;
    const scalar = (index: number) =>
      type === "uint8"
        ? view.getUint8(base + offset + index)
        : type === "uint16_le"
          ? view.getUint16(base + offset + index * 2, true)
          : type === "uint32_le"
            ? view.getUint32(base + offset + index * 4, true)
            : (() => {
                throw new Error(`Unsupported Sage field ${type}`);
              })();
    let index = 0;
    const decode = (dimension: number): unknown => {
      if (!field.shape || dimension === field.shape.length)
        return scalar(index++);
      const order = scheme[field.orders![dimension] as keyof typeof scheme] as (
        string | number
      )[];
      return Object.fromEntries(
        order.map((key) => [key, decode(dimension + 1)]),
      );
    };
    data[field.name] = decode(0);
  }
  return data as unknown as SageRecord;
}

async function readBounded(
  response: Response,
  length: number,
): Promise<Uint8Array> {
  // Never accept a 25MB whole-shard response for an 806-byte request.
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(
      `Sage range request returned HTTP ${response.status}; expected 206`,
    );
  }
  const declared = response.headers.get("Content-Length");
  if (declared && Number(declared) !== length) {
    await response.body?.cancel();
    throw new Error("Sage range response has an unexpected length");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Sage response has no data");
  const bytes = new Uint8Array(length);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > length)
        throw new Error("Sage range response exceeds the requested length");
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== length) throw new Error("Sage range response ended early");
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class SageRecordReader implements SageReader {
  private records = new Map<number, SageRecord>();
  constructor(
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private limit = 24,
  ) {}
  cached(seed: number) {
    const record = this.records.get(seed);
    if (!record) return null;
    this.records.delete(seed);
    this.records.set(seed, record);
    return record;
  }
  async read(seed: number, signal?: AbortSignal): Promise<SageRecord> {
    signal?.throwIfAborted();
    const found = this.cached(seed);
    if (found) return found;
    const location = locateSageSeed(seed),
      controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Sage lookup timed out")),
      12000,
    );
    try {
      const response = await this.fetcher(location.url, {
        headers: { Range: `bytes=${location.start}-${location.end}` },
        signal: controller.signal,
        credentials: "omit",
      });
      // Content-Range is checked when exposed. The current CDN does not expose
      // it cross-origin, so fixed length + BOTH seed tags also validate every read.
      const range = response.headers.get("Content-Range");
      if (
        range &&
        !range.startsWith(`bytes ${location.start}-${location.end}/`)
      ) {
        await response.body?.cancel();
        throw new Error("Sage returned a different byte range");
      }
      const record = decodeSageRecord(
        await readBounded(response, location.length),
        seed,
      );
      controller.signal.throwIfAborted();
      record.populationRevision = archiveSource.populationRevision;
      this.records.set(seed, record);
      while (this.records.size > this.limit)
        this.records.delete(this.records.keys().next().value!);
      return record;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
export const sageReader = new SageRecordReader();
export function sageTotal(values: WorldCounts, worlds: readonly number[]) {
  return worlds.reduce(
    (sum, world) => sum + (values[world as SageWorld] ?? 0),
    0,
  );
}

/** Per-seed bake snapshot. Revision comes from the verified archive reader,
 * never from the binary schemaVersion or a manually decoded byte buffer. */
export interface BakedSageSnapshot {
  format: 'noitamap-sage-seed';
  version: 1;
  seed: number;
  status: 'ready' | 'unavailable';
  source: 'published-sage-seed-archive';
  populationRevision: number | null;
  capturedAt: string;
  schema?: typeof scheme;
  record?: SageRecord;
  reason?: string;
}
export function createBakedSageSnapshot(seed: number, record: SageRecord | null, reason?: string): BakedSageSnapshot {
  return { format: 'noitamap-sage-seed', version: 1, seed, status: record ? 'ready' : 'unavailable',
    source: 'published-sage-seed-archive', populationRevision: record?.populationRevision ?? null, capturedAt: new Date().toISOString(),
    ...(record ? { schema: scheme, record } : { reason: reason ?? 'Source unavailable' }) };
}
/** Treat a malformed/older/mismatched snapshot as absent, never as zero counts. */
export function readBakedSageSnapshot(value: unknown, seed: number): SageRecord | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as BakedSageSnapshot;
  if (snapshot.format !== 'noitamap-sage-seed' || snapshot.version !== 1 || snapshot.seed !== seed ||
      snapshot.status !== 'ready' || snapshot.record?.seed !== seed ||
      snapshot.source !== 'published-sage-seed-archive' || snapshot.populationRevision !== archiveSource.populationRevision ||
      (snapshot.record.populationRevision ?? null) !== snapshot.populationRevision || JSON.stringify(snapshot.schema) !== JSON.stringify(scheme)) return null;
  for (const field of scheme.recordFields) {
    const validate = (item: any, dimension: number): boolean => {
      if (!field.shape || dimension === field.shape.length) {
        const max = field.type === 'uint8' ? 255 : field.type === 'uint16_le' ? 65535 : 0xffffffff;
        return Number.isInteger(item) && item >= 0 && item <= max;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const order = scheme[field.orders![dimension] as keyof typeof scheme] as Array<string | number>;
      return order.every(key => validate(item[key], dimension + 1));
    };
    if (!validate((snapshot.record as any)[field.name], 0)) return null;
  }
  return snapshot.record;
}
