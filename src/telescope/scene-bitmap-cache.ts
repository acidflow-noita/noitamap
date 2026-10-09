interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
  users: number;
  retained: boolean;
}

export interface SceneBitmapLease {
  bitmap: ImageBitmap;
  release(): void;
}

/** Decoded scene artwork survives reseeds. Each displayed/preparing layer
 * leases its images, so eviction or removal of an older layer cannot close
 * pixels still used by another. Only retained cache entries count against
 * this budget; an evicted image lives until its last active layer releases it. */
export class SceneBitmapCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(readonly maxBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('Invalid decoded scene cache budget');
  }

  acquire(key: string): SceneBitmapLease | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return this.lease(entry);
  }

  /** Takes ownership of a newly decoded bitmap, even if it cannot be retained. */
  adopt(key: string, bitmap: ImageBitmap): SceneBitmapLease {
    const previous = this.entries.get(key);
    if (previous?.bitmap === bitmap) return this.lease(previous);
    if (previous) this.remove(key);
    const bytes = bitmap.width * bitmap.height * 4;
    const entry: Entry = { bitmap, bytes, users: 0,
      retained: Number.isSafeInteger(bytes) && bytes > 0 && bytes <= this.maxBytes };
    const lease = this.lease(entry);
    if (entry.retained) {
      this.entries.set(key, entry);
      this.bytes += bytes;
      while (this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    }
    return lease;
  }

  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }

  get stats() { return { entries: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes }; }

  private lease(entry: Entry): SceneBitmapLease {
    entry.users++;
    let released = false;
    return { bitmap: entry.bitmap, release() {
      if (released) return;
      released = true;
      if (--entry.users === 0 && !entry.retained) entry.bitmap.close();
    } };
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    entry.retained = false;
    if (!entry.users) entry.bitmap.close();
  }
}
