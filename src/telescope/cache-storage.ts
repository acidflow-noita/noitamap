/** Optional disk cache. Storage must never be a prerequisite for a usable map. */
export class CacheUnavailableError extends Error {
  constructor(message: string, readonly reason: "blocked" | "timeout" | "unavailable", cause?: unknown) {
    super(message, { cause });
    this.name = "CacheUnavailableError";
  }
}

const CACHE_WRITE_IDLE_MS = 10_000;
const CACHE_WRITE_MAX_MS = 30_000;

// Reseeding can create the next owner while the previous owner's final flush
// still runs. IDB serializes both owners' transactions on the same database.
const pendingWrites = new Map<string, Set<IDBTransaction>>();

export class OptionalCacheDatabase {
  private connection: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private unavailable: CacheUnavailableError | null = null;
  private closed: CacheUnavailableError | null = null;
  private abandonOpen: (() => void) | null = null;

  constructor(
    private readonly name: string,
    private readonly version: number,
    private readonly upgrade: (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void,
    // This bounds optional storage I/O, NOT terrain generation or downloads.
    private readonly waitMs = 3000,
    private readonly writeWait = { idleMs: CACHE_WRITE_IDLE_MS, maxMs: CACHE_WRITE_MAX_MS },
  ) {}

  private disable(reason: CacheUnavailableError["reason"], message: string, cause?: unknown): CacheUnavailableError {
    if (!this.unavailable) {
      this.unavailable = new CacheUnavailableError(message, reason, cause);
      console.warn(`[TileCache] ${message} [${this.name}]; continuing without the disk cache.`, cause ?? "");
    }
    this.connection?.close();
    this.connection = null;
    return this.unavailable;
  }

  open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.unavailable) return Promise.reject(this.unavailable);
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let settled = false;
      let failure: CacheUnavailableError | null = null;
      const fail = (reason: CacheUnavailableError["reason"], message: string, cause?: unknown) => {
        if (settled) return;
        settled = true;
        this.abandonOpen = null;
        clearTimeout(timer);
        failure = this.disable(reason, message, cause);
        reject(failure);
      };
      const timer = setTimeout(() => fail("timeout", "Opening the cache database did not respond"), this.waitMs);
      this.abandonOpen = () => {
        if (settled) return;
        settled = true;
        this.abandonOpen = null;
        clearTimeout(timer);
        reject(this.closed);
      };
      try {
        const request = indexedDB.open(this.name, this.version);
        request.onupgradeneeded = event => {
          if (this.closed) {
            request.transaction?.abort();
            return;
          }
          this.upgrade(request.result, request.transaction!, event.oldVersion);
        };
        request.onblocked = () => fail("blocked", "Cache upgrade is blocked by an older tab");
        request.onerror = () => fail("unavailable", "Cannot open the cache database", request.error);
        request.onsuccess = () => {
          clearTimeout(timer);
          const db = request.result;
          if (settled) {
            // IDB open requests cannot be cancelled. Do not leak a connection
            // when an abandoned upgrade eventually succeeds (and block later tabs).
            db.close();
            this.opening = null;
            // A blocked upgrade has now completed, including schema invalidation.
            // Other failures stay disabled for this page, avoiding stale reads after
            // an unsuccessful library-version cache clear.
            if (failure?.reason === "blocked" && this.unavailable === failure) this.unavailable = null;
            return;
          }
          settled = true;
          this.abandonOpen = null;
          this.connection = db;
          const release = () => {
            db.close();
            if (this.connection === db) {
              this.connection = null;
              this.opening = null;
            }
          };
          db.onversionchange = release;
          db.onclose = release;
          resolve(db);
        };
      } catch (error) {
        fail("unavailable", "Cannot open the cache database", error);
      }
    });
    return this.opening;
  }

  /** Terminal owner disposal. Existing transactions may finish; an IDB open
   * cannot be cancelled, so reject its waiter and close any late connection. */
  close(): void {
    if (this.closed) return;
    this.closed = new CacheUnavailableError("Cache owner was disposed", "unavailable");
    this.abandonOpen?.();
    this.connection?.close();
    this.connection = null;
    this.opening = null;
  }

  read<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = () => {
        // IDB queues reads behind earlier writes on the same store. A healthy
        // monitored write owns its longer, bounded deadline; the queued read
        // must not disable that connection after the short lookup deadline.
        const remaining = this.writeWait.maxMs - (performance.now() - started);
        if (pendingWrites.get(this.name)?.size && remaining > 0) {
          timer = setTimeout(timeout, Math.min(this.waitMs, remaining));
          return;
        }
        settled = true;
        reject(this.disable("timeout", "Cache read did not respond"));
        try { request.transaction?.abort(); } catch { /* already finished */ }
      };
      timer = setTimeout(timeout, this.waitMs);
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(this.disable("unavailable", "Cache read failed", request.error));
      };
    });
  }

  complete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let idle: ReturnType<typeof setTimeout>;
      let maximum: ReturnType<typeof setTimeout>;
      let writes = pendingWrites.get(this.name);
      if (!writes) pendingWrites.set(this.name, writes = new Set());
      writes.add(transaction);
      const cleanup = () => {
        settled = true;
        clearTimeout(idle);
        clearTimeout(maximum);
        writes.delete(transaction);
        if (!writes.size) pendingWrites.delete(this.name);
        transaction.removeEventListener?.("success", progress, true);
      };
      const timeout = (message: string) => {
        if (settled) return;
        cleanup();
        reject(this.disable("timeout", message));
        try { transaction.abort(); } catch { /* already finished */ }
      };
      const progress = () => {
        if (settled) return;
        clearTimeout(idle);
        idle = setTimeout(() => timeout("Cache transaction stopped making progress"), this.writeWait.idleMs);
      };
      // Request success events do not bubble, but their event parent is the
      // transaction. Capture observes progress without replacing callers'
      // cursor/request handlers. Success is still only the committed event.
      transaction.addEventListener?.("success", progress, true);
      progress();
      maximum = setTimeout(() => timeout("Cache transaction exceeded its write deadline"), this.writeWait.maxMs);
      transaction.oncomplete = () => {
        if (settled) return;
        cleanup();
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        if (settled) return;
        cleanup();
        reject(this.disable("unavailable", "Cache transaction failed or was aborted", transaction.error));
      };
    });
  }
}

/** Availability failures are already reported once, not once per bitmap lookup. */
export function warnCacheFailure(message: string, error: unknown): void {
  if (!(error instanceof CacheUnavailableError)) console.warn(message, error);
}
