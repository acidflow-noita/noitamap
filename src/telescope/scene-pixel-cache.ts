interface SceneRecord {
  width: number;
  height: number;
  imgElement?: unknown;
  visualArt?: { data?: unknown } | null;
  [key: string]: unknown;
}
type Entry = { original: SceneRecord; decoded: SceneRecord; bytes: number };
const pixelBytes = (record: SceneRecord) =>
  (ArrayBuffer.isView(record.imgElement) ? record.imgElement.byteLength : 0)
  + (ArrayBuffer.isView(record.visualArt?.data) ? record.visualArt.data.byteLength : 0);

/** Upstream's successful decode promises live as long as their record. Clearing
 * imgElement on that record would prevent it from loading again. Decode host
 * copies instead: eviction releases the copy and a later copy can load afresh,
 * without accumulating every scene's raw RGBA arrays in generator metadata. */
export function createScenePixelCache(maxBytes: number) {
  const entries = new Map<string, Entry>();
  let bytes = 0, decodes = 0, queue = Promise.resolve();
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  };
  return {
    get stats() { return { bytes, entries: entries.size, maxBytes, decodes }; },
    peek(key: string, original: SceneRecord) {
      const entry = entries.get(key);
      return entry?.original === original ? entry.decoded : undefined;
    },
    load(key: string, original: SceneRecord, art: boolean,
      decode: (record: SceneRecord, options: { art: boolean }) => Promise<unknown>): Promise<SceneRecord> {
      const job = queue.then(async () => {
        const existing = entries.get(key);
        const decoded = existing?.original === original ? existing.decoded : { ...original };
        // Retained source arrays are already accounted for; remove the entry
        // before a possible art upgrade, then reserve the entire expected size.
        remove(key);
        const estimate = Math.max(pixelBytes(decoded), original.width * original.height * (art ? 8 : 4));
        while (entries.size && bytes + estimate > maxBytes) remove(entries.keys().next().value!);
        await decode(decoded, { art });
        decodes++;
        const size = pixelBytes(decoded);
        while (entries.size && bytes + size > maxBytes) remove(entries.keys().next().value!);
        // Large single scenes may be needed transiently, but are never retained
        // beyond their caller merely because they exceed the optional cache.
        if (size <= maxBytes) { entries.set(key, { original, decoded, bytes: size }); bytes += size; }
        return decoded;
      });
      queue = job.then(() => {}, () => {});
      return job;
    },
    clear() { entries.clear(); bytes = 0; },
  };
}
