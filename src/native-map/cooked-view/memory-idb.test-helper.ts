/** Transactional IndexedDB test double. Request success precedes commit, and
 * injected commit failures roll back every write. No browser or network needed. */
export class MemoryIndexedDB {
  readonly databases = new Map<string, Map<string, Map<string, unknown>>>();
  failNextCommit: string | undefined;
  blocked = false;
  opens = 0;
  closes = 0;
  readonly durability: (IDBTransactionDurability | undefined)[] = [];
  factory(): IDBFactory {
    return this as unknown as IDBFactory;
  }
  open(name: string) {
    const request: any = {};
    queueMicrotask(() => {
      if (this.blocked) {
        request.onblocked?.();
        return;
      }
      const existing = this.databases.get(name),
        tables = existing ?? new Map();
      this.databases.set(name, tables);
      this.opens++;
      const db: any = {
        objectStoreNames: { contains: (key: string) => tables.has(key) },
        createObjectStore: (key: string) => {
          tables.set(key, new Map());
        },
        close: () => {
          this.closes++;
        },
        transaction: (
          names: string[],
          mode: string,
          options?: IDBTransactionOptions,
        ) => {
          this.durability.push(options?.durability);
          const working = new Map(
            names.map((key) => [key, new Map(tables.get(key))]),
          );
          let pending = 0,
            ended = false,
            scheduled = false;
          const tx: any = { error: null };
          const finish = () => {
            if (scheduled || ended || pending) return;
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (ended || pending) return;
              if (mode === "readwrite" && this.failNextCommit) {
                tx.error = new DOMException(
                  "Injected commit failure",
                  this.failNextCommit,
                );
                this.failNextCommit = undefined;
                tx.abort();
                return;
              }
              ended = true;
              if (mode === "readwrite")
                for (const [key, data] of working) tables.set(key, data);
              tx.oncomplete?.();
            });
          };
          tx.abort = () => {
            if (ended) return;
            ended = true;
            queueMicrotask(() => tx.onabort?.());
          };
          const enqueue = (action: () => unknown) => {
            if (ended)
              throw new DOMException(
                "Transaction ended",
                "TransactionInactiveError",
              );
            const req: any = {};
            pending++;
            queueMicrotask(() => {
              if (ended) return;
              try {
                req.result = structuredClone(action());
                pending--;
                req.onsuccess?.();
                finish();
              } catch (error) {
                req.error = error;
                tx.error = error;
                pending--;
                req.onerror?.();
                tx.abort();
              }
            });
            return req;
          };
          tx.objectStore = (key: string) => {
            const data = working.get(key);
            if (!data) throw new Error("Missing test store");
            return {
              get: (id: string) => enqueue(() => data.get(id)),
              put: (value: any) =>
                enqueue(() => {
                  data.set(value.key, structuredClone(value));
                  return value.key;
                }),
              add: (value: any) =>
                enqueue(() => {
                  if (data.has(value.key))
                    throw new DOMException("Duplicate key", "ConstraintError");
                  data.set(value.key, structuredClone(value));
                  return value.key;
                }),
              delete: (id: string) =>
                enqueue(() => {
                  data.delete(id);
                }),
            };
          };
          finish();
          return tx;
        },
      };
      request.result = db;
      request.transaction = { abort() {} };
      if (!existing) request.onupgradeneeded?.({ oldVersion: 0 });
      request.onsuccess?.();
    });
    return request;
  }
}
