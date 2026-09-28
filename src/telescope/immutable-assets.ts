interface Asset {
  body: Blob;
  status: number;
  statusText: string;
  headers: Headers;
}

const CACHE = "noitamap-telescope-assets-v1";
const REVISION = "X-Noitamap-Asset-Revision";

/** Dev URLs are stable filenames. Carry the content revision through the HTTP
 * cache too, while leaving inline assets' encoded payloads unchanged. */
export function revisionedAssetUrl(url: string, revision: string): string {
  if (/^(data|blob):/.test(url)) return url;
  const hash = url.indexOf("#");
  const path = hash < 0 ? url : url.slice(0, hash);
  return `${path}${path.includes("?") ? "&" : "?"}noitamap_revision=${encodeURIComponent(revision)}${hash < 0 ? "" : url.slice(hash)}`;
}

/** Small immutable inputs shared by every seed. Store compressed scene packs
 * and original atlas bytes, never expanded scenes or an extra decoded atlas.
 * Stable logical keys replace old deployments; the content revision must
 * match before a stored response can be reused. */
export class ImmutableTelescopeAssets {
  private cache?: Promise<Cache>;
  private disabled = false;
  private memory = new Map<string, Asset>();
  private pending = new Map<string, Promise<Asset>>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 8 * 1024 * 1024,
    private readonly waitMs = 1500,
  ) {}

  async fetch(
    key: string,
    revision: string,
    download: () => Promise<Response>,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    signal?.throwIfAborted();
    if (!revision) throw new Error("Immutable asset revision is required");
    const identity = `${revision}/${key}`;
    let ready = this.memory.get(identity);
    if (ready) {
      this.memory.delete(identity);
      this.memory.set(identity, ready);
    }
    let pending = this.pending.get(identity);
    if (!ready && !pending) {
      pending = this.load(key, revision, download)
        .then((asset) => {
          if (
            asset.status >= 200 &&
            asset.status < 300 &&
            asset.body.size <= this.maxBytes
          ) {
            this.memory.set(identity, asset);
            this.bytes += asset.body.size;
            while (this.bytes > this.maxBytes || this.memory.size > 16) {
              const oldest = this.memory.keys().next().value!;
              this.bytes -= this.memory.get(oldest)!.body.size;
              this.memory.delete(oldest);
            }
          }
          return asset;
        })
        .finally(() => this.pending.delete(identity));
      this.pending.set(identity, pending);
    }
    ready ??= await this.withSignal(pending!, signal);
    signal?.throwIfAborted();
    return this.response(ready);
  }

  private response(asset: Asset, revision?: string) {
    const headers = new Headers(asset.headers);
    if (revision) headers.set(REVISION, revision);
    return new Response(
      [204, 205, 304].includes(asset.status) ? null : asset.body,
      {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      },
    );
  }
  private async asset(response: Response): Promise<Asset> {
    const body = await response.blob();
    const headers = new Headers(response.headers);
    // fetch may have transparently decompressed the wire response already.
    headers.delete("Content-Encoding");
    headers.set("Content-Length", String(body.size));
    return {
      body,
      headers,
      status: response.status,
      statusText: response.statusText,
    };
  }
  private async optional<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Optional asset cache timed out")),
            this.waitMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async load(
    key: string,
    revision: string,
    download: () => Promise<Response>,
  ): Promise<Asset> {
    // This URL is only a CacheStorage key; it is never fetched.
    const base = globalThis.location?.href ?? "http://localhost/";
    const request = new Request(
      new URL(`/__noitamap_shared_assets__/${encodeURIComponent(key)}`, base),
    );
    let cache: Cache | undefined;
    if (!this.disabled && typeof caches !== "undefined") {
      try {
        this.cache ??= caches.open(CACHE);
        cache = await this.optional(this.cache);
        const stored = await this.optional(cache.match(request));
        if (stored?.ok && stored.headers.get(REVISION) === revision)
          return await this.optional(this.asset(stored));
      } catch {
        this.disabled = true;
      }
    }
    const response = await download();
    if (response.headers.get("Content-Type")?.includes("text/html"))
      throw new Error(`Immutable Telescope asset returned HTML: ${key}`);
    const asset = await this.asset(response);
    if (cache && !this.disabled && response.ok) {
      // Usable downloaded bytes do not wait for optional quota/storage writes.
      try {
        void this.optional(
          cache.put(request, this.response(asset, revision)),
        ).catch(() => {
          this.disabled = true;
        });
      } catch {
        this.disabled = true;
      }
    }
    return asset;
  }
  private withSignal<T>(
    pending: Promise<T>,
    signal?: AbortSignal | null,
  ): Promise<T> {
    if (!signal) return pending;
    if (signal.aborted)
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      pending
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
}

export const immutableTelescopeAssets = new ImmutableTelescopeAssets();
