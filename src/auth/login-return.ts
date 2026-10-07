export const LOGIN_RETURN_KEY = 'noitamap-login-return-v1';
export const LOGIN_RETURN_PARAM = 'auth_resume';
type Feature = 'map' | 'drawing';
type Capture = (id: string) => unknown | Promise<unknown>;
interface Checkpoint { version: 1; id: string; url: string; returned: boolean; data: Partial<Record<Feature, unknown>> }

/** Small, per-tab resume tickets. Drawing geometry remains in IndexedDB. */
export class LoginReturn {
  private captures = new Map<Feature, { capture: Capture; discard?: (id: string) => void | Promise<void> }>();

  register(feature: Feature, capture: Capture, discard?: (id: string) => void | Promise<void>): () => void {
    const entry = { capture, discard };
    this.captures.set(feature, entry);
    return () => { if (this.captures.get(feature) === entry) this.captures.delete(feature); };
  }

  private read(): Checkpoint | null {
    try {
      const state = JSON.parse(sessionStorage.getItem(LOGIN_RETURN_KEY) || 'null');
      if (state?.version !== 1 || typeof state.id !== 'string' || typeof state.url !== 'string'
        || typeof state.returned !== 'boolean' || !state.data || typeof state.data !== 'object') return null;
      const saved = new URL(state.url);
      if (saved.origin !== location.origin || saved.pathname !== location.pathname) return null;
      return state;
    } catch { return null; }
  }

  async prepare(): Promise<string> {
    const id = crypto.randomUUID();
    // Invoke captures together, before yielding: the map capture first flushes
    // its URL, while drawing persistence can finish asynchronously.
    const captures = [...this.captures];
    const jobs = captures.map(async ([key, entry]) => [key, await entry.capture(id)] as const);
    const url = new URL(location.href);
    for (const key of ['auth', 'token', 'refresh_token', 'auth_error', LOGIN_RETURN_PARAM]) url.searchParams.delete(key);
    if (new URLSearchParams(url.hash.slice(1)).get('auth') === 'success') url.hash = '';
    try {
      const data = Object.fromEntries((await Promise.all(jobs)).filter(([, value]) => value !== undefined));
      if (!Object.keys(data).length) return url.href;
      const checkpoint: Checkpoint = { version: 1, id, url: url.href, returned: false, data };
      sessionStorage.setItem(LOGIN_RETURN_KEY, JSON.stringify(checkpoint));
      url.searchParams.set(LOGIN_RETURN_PARAM, id);
      return url.href;
    } catch (error) {
      await Promise.allSettled(jobs);
      await Promise.allSettled(captures.map(([, entry]) => Promise.resolve().then(() => entry.discard?.(id))));
      throw error;
    }
  }

  /** Called while auth credentials are being scrubbed, before application
   * features load. Error/cancel returns restore the workspace as well. */
  arrive(url: URL): boolean {
    const id = url.searchParams.get(LOGIN_RETURN_PARAM);
    const checkpoint = this.read();
    const backToOriginal = !id && checkpoint && !checkpoint.returned && url.href === checkpoint.url;
    if (!id && !backToOriginal) return false;
    url.searchParams.delete(LOGIN_RETURN_PARAM);
    if (checkpoint && (checkpoint.id === id || backToOriginal)) {
      checkpoint.returned = true;
      sessionStorage.setItem(LOGIN_RETURN_KEY, JSON.stringify(checkpoint));
      url.hash = new URL(checkpoint.url).hash;
    }
    return true;
  }

  /** Back/Forward cache already retains the live workspace; do not replay an
   * abandoned login checkpoint over subsequent edits on a later refresh. */
  discardUnreturned(): void {
    const checkpoint = this.read();
    if (checkpoint && !checkpoint.returned) {
      sessionStorage.removeItem(LOGIN_RETURN_KEY);
      for (const feature of Object.keys(checkpoint.data) as Feature[]) {
        Promise.resolve().then(() => this.captures.get(feature)?.discard?.(checkpoint.id))
          .catch(error => console.warn('[Auth] Could not remove cancelled login checkpoint:', error));
      }
    }
  }

  get(feature: Feature): { id: string; data: unknown } | null {
    const checkpoint = this.read();
    return checkpoint?.returned && checkpoint.data[feature] !== undefined
      ? { id: checkpoint.id, data: checkpoint.data[feature] } : null;
  }

  complete(feature: Feature, id: string): void {
    const checkpoint = this.read();
    if (!checkpoint || checkpoint.id !== id) return;
    delete checkpoint.data[feature];
    if (Object.keys(checkpoint.data).length) sessionStorage.setItem(LOGIN_RETURN_KEY, JSON.stringify(checkpoint));
    else sessionStorage.removeItem(LOGIN_RETURN_KEY);
  }
}
