/** Optional disk cache. Storage must never be a prerequisite for a usable map. */
export class CacheUnavailableError extends Error {
  constructor(message: string, readonly reason: "blocked" | "timeout" | "unavailable", cause?: unknown) {
    super(message, { cause });
    this.name = "CacheUnavailableError";
  }
}

export class OptionalCacheDatabase {
  private connection: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private unavailable: CacheUnavailableError | null = null;

  constructor(
    private readonly name: string,
    private readonly version: number,
    private readonly upgrade: (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void,
    // This bounds optional storage I/O, NOT terrain generation or downloads.
    private readonly waitMs = 3000,
  ) {}

  private disable(reason: CacheUnavailableError["reason"], message: string, cause?: unknown): CacheUnavailableError {
    if (!this.unavailable) {
      this.unavailable = new CacheUnavailableError(message, reason, cause);
      console.warn(`[TileCache] ${message}; continuing without the disk cache.`, cause ?? "");
    }
    this.connection?.close();
    this.connection = null;
    return this.unavailable;
  }

  open(): Promise<IDBDatabase> {
    if (this.unavailable) return Promise.reject(this.unavailable);
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let settled = false;
      let failure: CacheUnavailableError | null = null;
      const fail = (reason: CacheUnavailableError["reason"], message: string, cause?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failure = this.disable(reason, message, cause);
        reject(failure);
      };
      const timer = setTimeout(() => fail("timeout", "Opening the cache database did not respond"), this.waitMs);
      try {
        const request = indexedDB.open(this.name, this.version);
        request.onupgradeneeded = event => {
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

  read<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this.disable("timeout", "Cache read did not respond"));
        try { request.transaction?.abort(); } catch { /* already finished */ }
      }, this.waitMs);
      request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
      request.onerror = () => {
        clearTimeout(timer);
        reject(this.disable("unavailable", "Cache read failed", request.error));
      };
    });
  }

  complete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this.disable("timeout", "Cache transaction did not complete"));
        try { transaction.abort(); } catch { /* already finished */ }
      }, this.waitMs);
      transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
      transaction.onerror = transaction.onabort = () => {
        clearTimeout(timer);
        reject(this.disable("unavailable", "Cache transaction failed or was aborted", transaction.error));
      };
    });
  }
}

/** Availability failures are already reported once, not once per bitmap lookup. */
export function warnCacheFailure(message: string, error: unknown): void {
  if (!(error instanceof CacheUnavailableError)) console.warn(message, error);
}
