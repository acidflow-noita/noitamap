import { CookedMap } from "../cooked-pixels/map-decoder";
import { restoreCookedMap } from "../cooked-pixels/map-snapshot";
import {
  decodeMapRecord,
  encodeMapRecord,
  validateLibrary,
  type CompletedMapRecord,
  type PreparedLibraryRecord,
} from "./records";
import {
  restorePreparedWorld,
  type PreparedWorldArtifact,
} from "../prepared-world/artifact";

export type CookedStorageFailure =
  | "unavailable"
  | "blocked"
  | "timeout"
  | "quota"
  | "transaction"
  | "corrupt"
  | "missing-library"
  | "conflict"
  | "closed"
  | "version";
export class CookedStorageError extends Error {
  constructor(
    readonly code: CookedStorageFailure,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "CookedStorageError";
  }
}
function failure(
  error: unknown,
  fallback: CookedStorageFailure = "transaction",
): CookedStorageError {
  if (error instanceof CookedStorageError) return error;
  const name =
    error && typeof error === "object" && "name" in error
      ? error.name
      : undefined;
  const code =
    name === "QuotaExceededError"
      ? "quota"
      : name === "ConstraintError"
        ? "conflict"
        : name === "VersionError"
          ? "version"
          : fallback;
  return new CookedStorageError(
    code,
    `Completed pixel storage failed (${code})`,
    error,
  );
}

/** Explicit durable snapshots. A failed transaction never publishes a partial map.
 * Prepared libraries are immutable records supplied by the preparation pipeline;
 * no completed seed is promoted into a library here. */
export class CookedMapStorage {
  readonly #factory: IDBFactory | undefined;
  readonly #name: string;
  readonly #wait: number;
  #db: IDBDatabase | undefined;
  #opening: Promise<IDBDatabase> | undefined;
  #closed = false;
  #cancelOpen: (() => void) | undefined;

  constructor(
    options: { indexedDB?: IDBFactory; name?: string; timeoutMs?: number } = {},
  ) {
    this.#factory = options.indexedDB ?? globalThis.indexedDB;
    this.#name = options.name ?? "noitamap-completed-native-pixels";
    this.#wait = options.timeoutMs ?? 30000;
    if (!Number.isFinite(this.#wait) || this.#wait <= 0)
      throw new RangeError("Invalid completed storage timeout");
  }

  async #open(): Promise<IDBDatabase> {
    if (this.#closed)
      throw new CookedStorageError("closed", "Completed map storage is closed");
    if (!this.#factory)
      throw new CookedStorageError("unavailable", "IndexedDB is unavailable");
    if (this.#db) return this.#db;
    if (this.#opening) return this.#opening;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#cancelOpen = undefined;
        reject(failure(error, "unavailable"));
      };
      const timer = setTimeout(
        () =>
          fail(
            new CookedStorageError(
              "timeout",
              "Opening completed map storage timed out",
            ),
          ),
        this.#wait,
      );
      this.#cancelOpen = () =>
        fail(
          new CookedStorageError("closed", "Completed map storage was closed"),
        );
      try {
        const request = this.#factory!.open(this.#name, 1);
        request.onblocked = () =>
          fail(
            new CookedStorageError(
              "blocked",
              "Completed map storage upgrade is blocked by another connection",
            ),
          );
        request.onerror = () => fail(request.error);
        request.onupgradeneeded = (event) => {
          if (settled || this.#closed) {
            request.transaction?.abort();
            return;
          }
          if (event.oldVersion !== 0) {
            request.transaction?.abort();
            fail(
              new CookedStorageError(
                "version",
                "Unsupported completed map database schema",
              ),
            );
            return;
          }
          request.result.createObjectStore("libraries", { keyPath: "key" });
          request.result.createObjectStore("maps", { keyPath: "key" });
        };
        request.onsuccess = () => {
          const db = request.result;
          if (settled || this.#closed) {
            db.close();
            return;
          }
          if (
            !db.objectStoreNames.contains("libraries") ||
            !db.objectStoreNames.contains("maps")
          ) {
            db.close();
            fail(
              new CookedStorageError(
                "version",
                "Completed map database stores are missing",
              ),
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.#cancelOpen = undefined;
          this.#db = db;
          const release = () => {
            db.close();
            if (this.#db === db) this.#db = undefined;
          };
          db.onversionchange = release;
          db.onclose = () => {
            if (this.#db === db) this.#db = undefined;
          };
          resolve(db);
        };
      } catch (error) {
        fail(error);
      }
    });
    this.#opening = opening;
    try {
      return await opening;
    } finally {
      if (this.#opening === opening) this.#opening = undefined;
    }
  }

  async #transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (
      tx: IDBTransaction,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction,
        settled = false,
        value: T,
        problem: unknown;
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: unknown) => {
        if (settled) return;
        problem = error;
        try {
          tx?.abort();
        } catch {
          /* completed/aborted already */
        }
        settled = true;
        clearTimeout(timer);
        reject(failure(error));
      };
      try {
        tx = db.transaction(
          stores,
          mode,
          mode === "readwrite" ? { durability: "strict" } : undefined,
        );
        timer = setTimeout(
          () =>
            fail(
              new CookedStorageError(
                "timeout",
                "Completed map transaction timed out",
              ),
            ),
          this.#wait,
        );
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        tx.onabort = tx.onerror = () => fail(problem ?? tx.error);
        work(
          tx,
          (result) => {
            value = result;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }

  /** Add-only identity: changing a prepared artifact requires a new library key. */
  async saveLibrary(
    key: string,
    artifact: PreparedWorldArtifact,
  ): Promise<void> {
    let library: PreparedLibraryRecord;
    try {
      const owned = structuredClone(artifact);
      library = {
        format: "noitamap-prepared-library",
        version: 1,
        key,
        artifact: owned,
      };
      validateLibrary(library);
      restorePreparedWorld(owned, owned.recipe.revision);
    } catch (error) {
      throw failure(error, "corrupt");
    }
    return this.#transaction<void>(
      ["libraries"],
      "readwrite",
      (tx, result, fail) => {
        const request = tx.objectStore("libraries").add(library);
        request.onerror = () => fail(request.error);
        request.onsuccess = () => result();
      },
    );
  }

  async #readLibrary(key: string): Promise<PreparedLibraryRecord | null> {
    const library = await this.#transaction<PreparedLibraryRecord | null>(
      ["libraries"],
      "readonly",
      (tx, result, fail) => {
        const request = tx.objectStore("libraries").get(key);
        request.onerror = () => fail(request.error);
        request.onsuccess = () => result(request.result ?? null);
      },
    );
    if (library)
      try {
        validateLibrary(library);
        if (library.key !== key)
          throw new Error("Stored library identity mismatch");
      } catch (error) {
        throw failure(error, "corrupt");
      }
    return library;
  }

  async openLibrary(key: string): Promise<PreparedWorldArtifact | null> {
    const library = await this.#readLibrary(key);
    if (!library) return null;
    try {
      restorePreparedWorld(library.artifact, library.artifact.recipe.revision);
      return library.artifact;
    } catch (error) {
      throw failure(error, "corrupt");
    }
  }

  async saveMap(
    key: string,
    map: CookedMap,
    options: { libraryKey?: string } = {},
  ): Promise<{ sharedNodes: number; storedNodes: number }> {
    if (!(map instanceof CookedMap) || map.ready !== true)
      throw new CookedStorageError(
        "corrupt",
        "Only a sealed complete CookedMap can be saved",
      );
    const libraryKey = options.libraryKey;
    if (libraryKey !== undefined && !libraryKey)
      throw new CookedStorageError(
        "corrupt",
        "Prepared library identity cannot be empty",
      );
    const library = libraryKey
      ? await this.#readLibrary(libraryKey)
      : undefined;
    if (libraryKey && !library)
      throw new CookedStorageError(
        "missing-library",
        "The prepared library must be saved before its map",
      );
    let encoded: ReturnType<typeof encodeMapRecord>;
    try {
      encoded = encodeMapRecord(
        key,
        map.exportSnapshot(),
        library ?? undefined,
      );
    } catch (error) {
      throw failure(error, "corrupt");
    }
    await this.#transaction<void>(
      ["maps", "libraries"],
      "readwrite",
      (tx, result, fail) => {
        const write = () => {
          const request = tx.objectStore("maps").put(encoded.record);
          request.onerror = () => fail(request.error);
          request.onsuccess = () => result();
        };
        if (encoded.record.libraryKey) {
          const check = tx
            .objectStore("libraries")
            .get(encoded.record.libraryKey);
          check.onerror = () => fail(check.error);
          check.onsuccess = () => {
            if (!check.result)
              fail(
                new CookedStorageError(
                  "missing-library",
                  "The prepared library disappeared before the map committed",
                ),
              );
            else write();
          };
        } else write();
      },
    );
    return {
      sharedNodes: encoded.sharedNodes,
      storedNodes: encoded.record.nodes.length,
    };
  }

  async openMap(key: string): Promise<CookedMap | null> {
    const records = await this.#transaction<{
      map: CompletedMapRecord;
      library?: PreparedLibraryRecord;
    } | null>(["maps", "libraries"], "readonly", (tx, result, fail) => {
      const request = tx.objectStore("maps").get(key);
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const map: CompletedMapRecord | undefined = request.result;
        if (!map) {
          result(null);
          return;
        }
        if (!map.libraryKey) {
          result({ map });
          return;
        }
        const lookup = tx.objectStore("libraries").get(map.libraryKey);
        lookup.onerror = () => fail(lookup.error);
        lookup.onsuccess = () => {
          if (!lookup.result)
            fail(
              new CookedStorageError(
                "missing-library",
                "Completed map references a missing prepared library",
              ),
            );
          else result({ map, library: lookup.result });
        };
      };
    });
    if (!records) return null;
    try {
      if (records.map.key !== key)
        throw new Error("Stored map identity mismatch");
      const map = restoreCookedMap(
        decodeMapRecord(records.map, records.library),
      );
      map.store.freezeForDisplay();
      return map;
    } catch (error) {
      throw failure(error, "corrupt");
    }
  }

  async deleteMap(key: string): Promise<void> {
    return this.#transaction<void>(
      ["maps"],
      "readwrite",
      (tx, result, fail) => {
        const request = tx.objectStore("maps").delete(key);
        request.onerror = () => fail(request.error);
        request.onsuccess = () => result();
      },
    );
  }

  close(): void {
    this.#closed = true;
    this.#cancelOpen?.();
    this.#db?.close();
    this.#db = undefined;
  }
}
