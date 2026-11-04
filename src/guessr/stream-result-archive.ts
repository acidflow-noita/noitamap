import { openDB } from 'idb';
import { streamResult } from './stream-state';
import { STREAM_ROUNDS, STREAM_SESSION_KEY, type StreamGame, type StreamResult } from './stream-types';

/** Private retry credentials stay in browser storage, outside public result data. */
export interface ArchivedStreamResult {
  result: StreamResult;
  published: boolean;
  pendingToken?: string;
  localChannel?: string;
}
export interface ResultArchiveStore {
  get(id: string): Promise<ArchivedStreamResult | undefined>;
  all(): Promise<ArchivedStreamResult[]>;
  put(entry: ArchivedStreamResult): Promise<void>;
}
const fallbackPrefix = 'noitamap-guessr-archive:';
const legacyPrefix = 'noitamap-guessr-result:';
const storageError = 'This browser could not save the result. Download a copy before closing this page.';
function valid(result: StreamResult | undefined): result is StreamResult {
  return !!result && result.schema === 1 && /^[a-f0-9-]{36}$/.test(result.id)
    && result.rounds?.length === STREAM_ROUNDS && !!result.players?.length
    && result.players.every(player => player.rounds?.length === STREAM_ROUNDS);
}
function read<T>(storage: Storage, key: string): T | undefined {
  try { return JSON.parse(storage.getItem(key) ?? 'null') ?? undefined; } catch { return undefined; }
}
function keys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, i) => storage.key(i)!).filter(Boolean);
}
function merge(old: ArchivedStreamResult | undefined, entry: ArchivedStreamResult): ArchivedStreamResult {
  const value = { ...old, ...entry, published: !!old?.published || entry.published };
  value.pendingToken ??= old?.pendingToken;
  if (value.published) delete value.pendingToken;
  return value;
}
function browserStore(): ResultArchiveStore {
  const db = openDB('noitamap-guessr-results', 1, {
    upgrade(database) { database.createObjectStore('games', { keyPath: 'result.id' }); },
  });
  return {
    async get(id) { return (await db).get('games', id); },
    async all() { return (await db).getAll('games'); },
    async put(entry) { await (await db).put('games', entry); },
  };
}

export class StreamResultArchive {
  private store?: ResultArchiveStore;
  private recovered?: Promise<void>;
  private writes = Promise.resolve();
  constructor(private storage: () => Storage = () => localStorage, private makeStore = browserStore) {}
  private database(): ResultArchiveStore { return this.store ??= this.makeStore(); }
  private fallback(id: string): ArchivedStreamResult | undefined {
    try { return read(this.storage(), fallbackPrefix + id); } catch { return undefined; }
  }
  async save(entry: ArchivedStreamResult): Promise<void> {
    if (!valid(entry.result)) throw new Error('Invalid result.');
    const write = this.writes.then(async () => {
      let old = this.fallback(entry.result.id);
      try { const stored = await this.database().get(entry.result.id); old = old ? merge(stored, old) : stored; } catch { /* Storage fallback below. */ }
      const merged = merge(old, entry);
      try {
        await this.database().put(merged);
      } catch {
        try { this.storage().setItem(fallbackPrefix + entry.result.id, JSON.stringify(merged)); return; }
        catch { throw new Error(storageError); }
      }
      try { this.storage().removeItem(fallbackPrefix + entry.result.id); this.storage().removeItem(legacyPrefix + entry.result.id); }
      catch { /* The durable write already succeeded. */ }
    });
    this.writes = write.catch(() => {});
    return write;
  }
  /** Recover the old per-result cache and the last completed host session, even
   * when opening a result URL directly after a failed upload or a page refresh. */
  private recover(): Promise<void> {
    return this.recovered ??= (async () => {
      let storage: Storage;
      try { storage = this.storage(); } catch { return; }
      for (const key of keys(storage)) {
        if (!key.startsWith(legacyPrefix)) continue;
        const result = read<StreamResult>(storage, key);
        if (valid(result)) await this.save({ result, published: false });
      }
      const game = read<StreamGame>(storage, STREAM_SESSION_KEY);
      if (game?.stage === 'complete' && game.session?.rounds?.length === STREAM_ROUNDS) {
        let result: StreamResult;
        try { result = streamResult(game); } catch { return; }
        await this.save({ result, published: !!game.published, ...(!game.published ? { pendingToken: game.session.token } : {}),
          ...(game.session.localChat ? { localChannel: game.session.host.login } : {}) });
      }
    })();
  }
  async get(id: string): Promise<ArchivedStreamResult | undefined> {
    await this.recover(); await this.writes;
    try { const stored = await this.database().get(id), backup = this.fallback(id); return backup ? merge(stored, backup) : stored; }
    catch { return this.fallback(id); }
  }
  async list(): Promise<ArchivedStreamResult[]> {
    await this.recover(); await this.writes;
    const entries = new Map<string, ArchivedStreamResult>();
    try { for (const key of keys(this.storage())) {
      if (!key.startsWith(fallbackPrefix)) continue;
      const entry = read<ArchivedStreamResult>(this.storage(), key);
      if (entry && valid(entry.result)) entries.set(entry.result.id, entry);
    } } catch { /* IndexedDB may still be available. */ }
    try { for (const entry of await this.database().all()) entries.set(entry.result.id, merge(entries.get(entry.result.id), entry)); }
    catch { /* Local storage fallback already collected. */ }
    return [...entries.values()].sort((a, b) => b.result.finishedAt - a.result.finishedAt);
  }
}
